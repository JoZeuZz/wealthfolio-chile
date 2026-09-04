import { DateParseError, parseStatementDate, type IsoDate } from '../dates';
import { detectInstallment } from '../installments/detect';
import { abs, isZero, MoneyError, negate, parseAmount, sign, type Money } from '../money';
import { defaultKindForRow } from '../classify/card-semantics';
import { Confidence, Direction } from '../model/kinds';
import type { RowStats, StatementIssue } from '../model/statement';
import type { NormalizedTransaction, TransactionWarning } from '../model/transaction';
import { redactDescription } from '../privacy';
import { normalizeDescription } from '../text';
import { cell, ColumnRole, normalizeHeader, type ColumnMap } from './columns';
import { resolveDateOrder, type DateOrderEvidence } from './date-order';
import { COMMON_IGNORE_PATTERNS, type StatementProfile } from './profile';
import { isBlankRow, type Sheet } from './tabular';

/**
 * Row mapping: `Sheet` + `ColumnMap` + `StatementProfile` -> canonical rows.
 *
 * This is the only place that reads spreadsheet cells. Every bank adapter
 * delegates here, so a fix to date handling or sign conventions lands for all
 * of them at once.
 */

export interface MapRowsInput {
  sheet: Sheet;
  map: ColumnMap;
  profile: StatementProfile;
  firstDataRow: number;
  fileHash: string;
  /** Account reference recovered from the file header, if any. */
  accountRef?: string;
  /** Overrides the profile currency when the file states its own. */
  currency?: string;
}

export interface MapRowsResult {
  transactions: NormalizedTransaction[];
  issues: StatementIssue[];
  /** What became of every row below the header. */
  stats: RowStats;
}

export function mapRows(input: MapRowsInput): MapRowsResult {
  const { sheet, map, profile, firstDataRow, fileHash, accountRef } = input;
  const currency = (input.currency ?? profile.defaultCurrency).toUpperCase();
  const ignorePatterns = [...COMMON_IGNORE_PATTERNS, ...(profile.ignoreRowPatterns ?? [])];

  // Settled once for the whole file, before any row is mapped: the field order
  // of a numeric date is a property of the export, not of the row being read.
  //
  // Only rows that will actually become movements get a vote. A `TOTAL DEL
  // PERIODO` footer is not a movement, and its date cell was enough to re-date
  // the whole statement at the highest confidence the detector has. Both date
  // columns count: a statement can leave every transaction date ambiguous and
  // settle the question in its posted-date column, and reading one row's two
  // dates under two different orders is how a movement ends up posted three
  // months before it happened.
  const votingRows = sheet.rows
    .slice(firstDataRow)
    .filter((row) => !isBlankRow(row as string[]))
    .filter((row) => !isIgnoredRow(row as string[], map, ignorePatterns));

  const dateOrder = resolveDateOrder(
    votingRows.flatMap((row) => [
      cell(row as string[], map, ColumnRole.date),
      cell(row as string[], map, ColumnRole.postedDate),
    ]),
    profile.dateOrder,
  );

  // The heading above the direction column, read once. Its wording is what
  // fixes the meaning of the abbreviations underneath it.
  const directionFlagHeader =
    map.directionFlag !== undefined && firstDataRow > 0
      ? normalizeHeader((sheet.rows[firstDataRow - 1] as string[] | undefined)?.[map.directionFlag] ?? '')
      : undefined;

  const transactions: NormalizedTransaction[] = [];
  const issues: StatementIssue[] = [...describeDateOrder(dateOrder, profile)];
  let dataRows = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = firstDataRow; i < sheet.rows.length; i += 1) {
    const row = sheet.rows[i] as string[];
    const line = i + 1;
    dataRows += 1;

    if (isBlankRow(row)) {
      skipped += 1;
      continue;
    }

    if (isIgnoredRow(row, map, ignorePatterns)) {
      skipped += 1;
      continue;
    }

    try {
      const transaction = mapRow({
        row,
        line,
        map,
        profile,
        currency,
        fileHash,
        accountRef,
        dateOrder: dateOrder.order,
        ...(directionFlagHeader !== undefined ? { directionFlagHeader } : {}),
      });
      if (transaction === null) {
        skipped += 1;
        continue;
      }
      transactions.push(transaction);
    } catch (error) {
      failed += 1;
      issues.push({
        level: 'error',
        code: 'row-parse-failed',
        message: `Fila ${line}: ${describeRowFailure(error)}`,
        line,
      });
    }
  }

  return {
    transactions,
    issues,
    stats: { dataRows, mapped: transactions.length, skipped, failed },
  };
}

interface MapRowInput {
  row: string[];
  line: number;
  map: ColumnMap;
  profile: StatementProfile;
  currency: string;
  fileHash: string;
  accountRef?: string;
  /** Settled for the whole file by {@link resolveDateOrder}. */
  dateOrder: StatementProfile['dateOrder'];
  /** The direction column's heading, normalised. See {@link readDirectionFlag}. */
  directionFlagHeader?: string;
}

/**
 * Map one row. Returns `null` for rows that are structurally fine but carry no
 * movement (a zero-amount separator line, for instance).
 */
function mapRow(input: MapRowInput): NormalizedTransaction | null {
  const { row, line, map, profile, currency, fileHash, accountRef, dateOrder } = input;
  const warnings: TransactionWarning[] = [];

  const rawDate = cell(row, map, ColumnRole.date);
  const description = cell(row, map, ColumnRole.description);

  // No money in any column that could hold it: the row is a separator, a
  // continuation line or a zero-value artefact. Not a movement, and skipping it
  // is the honest answer.
  if (!hasAmountContent(row, map, currency, profile.numberFormat)) return null;

  // Money with neither a date nor a glosa is a total, not a movement missing
  // its date. A bank writes `;;490.000;` under the last row and means "this is
  // the period"; treating it as an unreadable movement refused the whole file.
  if (rawDate === '' && description.trim() === '') return null;

  // From here on the row *does* carry money and says something about itself, so
  // it can no longer be "omitted". Every remaining failure is a movement we
  // could not read, and calling that an omission is how a charge leaves the
  // ledger without a trace.
  if (rawDate === '') {
    throw new Error('la fila tiene monto pero no fecha');
  }

  // No per-row ambiguity warning: the order was settled for the file, and a
  // flag that fires on every row with a day of 12 or less stops being read.
  const parsedDate = parseStatementDate(rawDate, { order: dateOrder });

  let postedDate: IsoDate | undefined;
  const rawPosted = cell(row, map, ColumnRole.postedDate);
  if (rawPosted !== '') {
    try {
      postedDate = parseStatementDate(rawPosted, { order: dateOrder }).date;
    } catch {
      warnings.push({
        code: 'unparsed-column',
        // The cell is not quoted. When a column is misaligned this one holds a
        // whole glosa, name and RUT included, and naming the column is what
        // makes the problem findable anyway.
        message: 'No se pudo leer la fecha contable de esta fila.',
      });
    }
  }

  // Money, a date, and nothing said about it. Both readings are plausible and
  // both are expensive: a totals line written `28/02/2026;;490.000;640.000`
  // becomes half a million pesos of income nobody received, and a real movement
  // whose glosa cell came out blank disappears from the ledger. Nothing in the
  // row separates them.
  //
  // So it blocks. That is what `validation` is for, and it is the only answer
  // that neither invents money nor loses it: the statement stops, the line
  // number is named, and a person decides.
  if (description.trim() === '') {
    throw new Error('la fila trae monto y fecha pero no glosa');
  }
  const amountResult = readAmount({
    row,
    map,
    profile,
    currency,
    warnings,
    ...(input.directionFlagHeader !== undefined
      ? { directionFlagHeader: input.directionFlagHeader }
      : {}),
  });
  if (amountResult === null) {
    throw new Error('la fila tiene fecha pero ninguna columna de monto con contenido');
  }
  const amount = amountResult;

  if (isZero(amount)) {
    // A zero movement carries no financial meaning but often marks a
    // formatting artefact, so it is reported rather than silently dropped.
    warnings.push({ code: 'zero-amount', message: 'El movimiento tiene monto cero.' });
  }

  const balanceAfter = readOptionalMoney(cell(row, map, ColumnRole.balance), profile, currency);
  const direction = sign(amount) < 0 ? Direction.out : Direction.in;

  const installment = detectInstallment(description, cell(row, map, ColumnRole.installment), {
    product: profile.product,
  });
  if (installment?.confidence === Confidence.suggested) {
    warnings.push({
      code: 'ambiguous-installment',
      message: `Posible compra en cuotas (${installment.current}/${installment.total}); requiere confirmación.`,
    });
  }

  // The row says it is part of a plan, and the amount came from a column the
  // statement did not label. `MONTO` next to `2 de 6` is either this month's
  // instalment or the whole purchase repeated, and the two readings differ by a
  // factor of the plan length. Nobody has seen a real CMR export, so the
  // uncertainty travels with the row instead of being resolved by assumption.
  if (installment !== undefined && map.installmentAmount === undefined) {
    warnings.push({
      code: 'ambiguous-installment-amount',
      message:
        'La fila es una cuota y el estado de cuenta no dice si el monto es el de la cuota o el de la compra completa. El cargo del mes se toma tal cual; el total de la compra no se calcula.',
    });
  }

  const { kind, confidence, ambiguousCardCredit } = defaultKindForRow({
    product: profile.product,
    direction,
    description,
  });
  if (ambiguousCardCredit) {
    warnings.push({
      code: 'ambiguous-card-credit',
      message:
        'Abono en una tarjeta sin glosa que diga si es un pago del estado de cuenta o una devolución. Queda sin clasificar hasta que lo decidas.',
    });
  }

  return {
    sourceInstitution: profile.institution,
    sourceParser: profile.parserId,
    sourceParserVersion: profile.parserVersion,
    ...(accountRef !== undefined ? { sourceAccountRef: accountRef } : {}),
    sourceFileHash: fileHash,
    sourceLine: line,

    // Filled in by `core/dedupe/fingerprint` once the row is complete.
    fingerprint: '',
    ...(readReference(row, map) !== undefined ? { externalId: readReference(row, map) } : {}),

    date: parsedDate.date,
    ...(postedDate !== undefined ? { postedDate } : {}),

    description,
    normalizedDescription: normalizeDescription(description),

    amount,
    direction,
    ...(balanceAfter !== undefined ? { balanceAfter } : {}),

    ...(readReference(row, map) !== undefined ? { reference: readReference(row, map) } : {}),
    ...(cell(row, map, ColumnRole.operationType) !== ''
      ? { operationType: cell(row, map, ColumnRole.operationType) }
      : {}),
    ...(readCardLast4(row, map, description) !== undefined
      ? { cardLast4: readCardLast4(row, map, description) }
      : {}),

    kind,
    // From the classifier, not from whether the kind happens to be `unknown`:
    // a card payment recognised by its glosa is `confirmed`, and the preview's
    // "needs review" count should not include it.
    kindConfidence: confidence,
    tags: [],
    ...(installment !== undefined ? { installment } : {}),

    warnings,
    rawMetadata: buildRawMetadata(row, map),
  };
}

/**
 * Why a row could not be read, without quoting the row.
 *
 * `parseStatementDate` and `parseAmount` interpolate the offending cell into
 * the error they throw, and when a column is misaligned that cell is a whole
 * glosa — counterparty name and RUT included. Redaction is not enough: it
 * removes what has a shape, and `MARIA FERNANDA GONZALEZ` has none.
 *
 * The line number and the column are what make the problem findable, and
 * neither identifies anybody. Anything unrecognised falls back to a redacted,
 * truncated message rather than nothing, because an unknown failure with no
 * description is a support case with no thread to pull.
 */
function describeRowFailure(error: unknown): string {
  if (error instanceof DateParseError) return 'no se pudo leer la fecha.';
  if (error instanceof MoneyError) return 'no se pudo leer el monto.';
  const message = error instanceof Error ? error.message : String(error);
  return redactDescription(message, 80);
}

/**
 * What, if anything, to say about how the dates were read.
 *
 * One statement-level issue instead of one per row. `date-order-differs` is the
 * one worth reading twice: the file proved an order its profile did not expect,
 * which means either the bank changed its export or the wrong profile is
 * selected — and both produce movements dated wrong in a way nothing else
 * catches.
 */
function describeDateOrder(
  evidence: DateOrderEvidence,
  profile: StatementProfile,
): StatementIssue[] {
  if (evidence.source === 'file' && evidence.order !== profile.dateOrder) {
    return [
      {
        level: 'warning',
        code: 'date-order-differs',
        message: `El archivo demuestra que sus fechas vienen en formato ${describeOrder(evidence.order)}, aunque el perfil de ${profile.institutionLabel} espera ${describeOrder(profile.dateOrder)}. Se leyeron como dice el archivo; revisa que el banco elegido sea el correcto.`,
      },
    ];
  }

  if (evidence.source === 'conflict') {
    return [
      {
        level: 'warning',
        code: 'date-order-conflict',
        message: `Hay fechas que sólo se entienden como ${describeOrder('DMY')} y otras que sólo se entienden como ${describeOrder('MDY')}. Se usó ${describeOrder(profile.dateOrder)} donde se pudo y la otra lectura donde no, así que hay filas leídas con un criterio y filas leídas con otro. Revisa las fechas de la vista previa una por una, o prueba con otro banco.`,
      },
    ];
  }

  if (evidence.source === 'profile' && evidence.ambiguousRows > 0) {
    return [
      {
        level: 'warning',
        code: 'ambiguous-date-order',
        message: `${evidence.ambiguousRows} fecha(s) del archivo admiten dos lecturas y nada en él prueba cuál es. Se interpretaron como ${describeOrder(profile.dateOrder)}, que es lo que declara el perfil de ${profile.institutionLabel}.`,
      },
    ];
  }

  return [];
}

function describeOrder(order: StatementProfile['dateOrder']): string {
  switch (order) {
    case 'MDY':
      return 'MM/DD/AAAA';
    case 'YMD':
      return 'AAAA/MM/DD';
    default:
      return 'DD/MM/AAAA';
  }
}

/**
 * Whether a row is decoration rather than a movement.
 *
 * The label is normally in the description column, but not always: a footer
 * printed as `SALDO FINAL;;;;1.473.430;` puts it in the date column and leaves
 * the description empty. That case used to be caught by a `/^\s*$/` entry in
 * the shared ignore list — which also swallowed every *real* row whose glosa
 * cell happened to be blank, silently, as though it were a footer.
 *
 * So the label is looked for where it actually is: the description cell, and
 * failing that the row's first cell that could *be* a label. Narrower than
 * joining the whole row, which would let a glosa containing the word `TOTAL`
 * erase its own movement.
 *
 * "Could be a label" excludes dates and numbers, and that exclusion is the
 * whole point. A totals row written as `28/02/2026;;490.000;640.000` puts its
 * closing date first and leaves the glosa empty; taking the date as the label
 * found no pattern, so the row stopped being a footer and became a $490.000
 * income nobody had. Labels are words.
 */
export function isIgnoredRow(
  row: string[],
  map: ColumnMap,
  patterns: readonly RegExp[],
): boolean {
  const description = cell(row, map, ColumnRole.description).trim();
  const label = description !== '' ? description : (row.find(looksLikeLabel) ?? '').trim();
  if (label === '') return false;
  return patterns.some((pattern) => pattern.test(label));
}

/** A cell that carries words rather than a date or a figure. */
function looksLikeLabel(value: string): boolean {
  const text = value.trim();
  if (text === '') return false;
  return /\p{L}{2,}/u.test(text);
}

/**
 * Whether any column that can hold money has something in it.
 *
 * Used to tell "this row is not a movement" from "this row is a movement we
 * could not read". The two used to share the `skipped` bucket, and the second
 * is money leaving the statement without a trace.
 */
function hasAmountContent(
  row: string[],
  map: ColumnMap,
  currency: string,
  format: StatementProfile['numberFormat'],
): boolean {
  // Exactly the columns `readAmount` reads. `purchaseAmount` used to be here
  // and is not: nothing reads it, so a CMR statement with `Monto Total` filled
  // and `Valor Cuota` empty — an ordinary purchase with no cuotas — had every
  // row declared a movement we failed to read, and the whole file became
  // unimportable with no user action that could fix it.
  const AMOUNT_ROLES = [
    ColumnRole.installmentAmount,
    ColumnRole.debit,
    ColumnRole.credit,
    ColumnRole.amount,
  ] as const;
  return AMOUNT_ROLES.some((role) => carriesValue(cell(row, map, role), currency, format));
}

/**
 * Whether a cell holds an amount that is actually there.
 *
 * Agrees with `parseOptional` about "nothing here" — but by value, not by
 * spelling. The literal comparison against `'0'` missed `0,00`, so an
 * informational line printing zeros in both cargo and abono stopped being a
 * separator and became an unreadable movement that refused the statement.
 *
 * A cell that will not parse at all *is* content: that is the unreadable amount
 * the gate exists to catch.
 */
function carriesValue(
  text: string,
  currency: string,
  format: StatementProfile['numberFormat'],
): boolean {
  const trimmed = text.trim();
  if (trimmed === '' || trimmed === '-') return false;
  try {
    return !isZero(parseAmount(trimmed, { currency, format, allowDebitCreditSuffix: true }).money);
  } catch {
    return true;
  }
}

interface ReadAmountInput {
  row: string[];
  map: ColumnMap;
  profile: StatementProfile;
  currency: string;
  warnings: TransactionWarning[];
  /**
   * The direction column's own header, normalised.
   *
   * Needed because the values are abbreviations whose meaning is fixed by the
   * heading above them, not by a global table. See {@link readDirectionFlag}.
   */
  directionFlagHeader?: string;
}

/**
 * Resolve the movement amount, signed so that negative always means "left the
 * account".
 *
 * Three layouts are supported: a single signed column, separate cargo/abono
 * columns, and a single unsigned column plus a direction flag.
 */
function readAmount(input: ReadAmountInput): Money | null {
  const { row, map, profile, currency, warnings } = input;
  const format = profile.numberFormat;

  // A labelled instalment column settles what is charged this period, so it
  // wins over any general amount column on the same row.
  if (map.installmentAmount !== undefined) {
    const text = cell(row, map, ColumnRole.installmentAmount);
    if (text !== '') {
      const parsed = parseAmount(text, { currency, format, allowDebitCreditSuffix: true });
      if (parsed.explicitSign) return signedByMarker(parsed.money, parsed.explicitSign);
      return profile.amountSign === 'debit-positive' ? negate(parsed.money) : parsed.money;
    }
  }

  const debitText = cell(row, map, ColumnRole.debit);
  const creditText = cell(row, map, ColumnRole.credit);

  if (map.debit !== undefined || map.credit !== undefined) {
    const debit = parseOptional(debitText, currency, format, warnings);
    const credit = parseOptional(creditText, currency, format, warnings);

    // Both columns filled is a layout the profile does not describe; refusing
    // beats guessing which one is authoritative.
    if (debit && credit && !isZero(debit) && !isZero(credit)) {
      throw new Error('la fila tiene cargo y abono simultáneos');
    }
    if (debit && !isZero(debit)) return negate(abs(debit));
    if (credit && !isZero(credit)) return abs(credit);
    if (map.amount === undefined) return null;
  }

  const amountText = cell(row, map, ColumnRole.amount);
  if (amountText === '') return null;

  const parsed = parseAmount(amountText, { currency, format, allowDebitCreditSuffix: true });
  if (parsed.ambiguous) {
    warnings.push({
      code: 'ambiguous-amount-format',
      message: `El monto de esta fila admite más de una lectura; se interpretó como ${parsed.money.minor / 10 ** parsed.money.scale}.`,
    });
  }

  // The cell said so itself. Nothing below may override that: a marker in the
  // data is more specific than any default the profile carries.
  if (parsed.explicitSign) return signedByMarker(parsed.money, parsed.explicitSign);

  const flag = cell(row, map, ColumnRole.directionFlag).trim();
  if (flag !== '') {
    return signedByMarker(parsed.money, readDirectionFlag(flag, input.directionFlagHeader));
  }

  if (profile.amountSign === 'debit-positive') return negate(parsed.money);
  if (profile.amountSign === 'credit-positive') return parsed.money;
  return parsed.money;
}

/** Apply a direction that something other than the profile decided. */
function signedByMarker(amount: Money, marker: 'debit' | 'credit'): Money {
  return marker === 'debit' ? negate(abs(amount)) : abs(amount);
}

/**
 * What a value in the direction column means.
 *
 * The abbreviations are only unambiguous relative to their own heading, and
 * both readings of a bare `C` are in circulation in Chilean exports:
 *
 * - under `D/C` or `Debe/Haber`, `C` is **Crédito** — money in.
 * - under `Cargo/Abono`, `C` is **Cargo** — money out.
 *
 * A single hard-coded table has to be wrong about one of them, and it was:
 * every `C` was read as a charge, so under a `D/C` heading a salary of 500.000
 * was booked as a 500.000 expense — a million-peso swing across the month's
 * income and spending, with a balance walk that never tests the first row to
 * catch it.
 *
 * A value neither vocabulary explains throws, so the row is recorded as failed
 * and the statement stops being importable. Guessing at the sign of a movement
 * is the one thing this module must not do.
 */
function readDirectionFlag(value: string, header?: string): 'debit' | 'credit' {
  const flag = normalizeDescription(value);
  const raw = value.trim();
  const heading = header ?? '';
  // `Cargo/Abono` names its outflow explicitly; `D/C` and `Debe/Haber` do not.
  // That is the *only* thing the heading settles — which of the two readings a
  // bare `C` gets — so it disambiguates and then steps aside. Making it pick
  // one table and stop meant a `Cargo/Abono` column printing `D`/`C` failed
  // every row, and one such row refuses the whole statement.
  const cargoAbono = heading.includes('CARGO') || heading.includes('ABONO');

  if (cargoAbono && /^(C|CARGO|CARGOS)$/.test(flag)) return 'debit';
  if (cargoAbono && /^(A|AB|ABONO|ABONOS)$/.test(flag)) return 'credit';

  if (/^(D|DB|DEBITO|DEBE|CARGO|CARGOS)$/.test(flag)) return 'debit';
  if (/^(C|CR|CREDITO|H|HABER|ABONO|ABONOS|A|AB)$/.test(flag)) return 'credit';
  // Some exports print the sign in the flag column instead of a letter.
  if (raw === '-') return 'debit';
  if (raw === '+') return 'credit';

  throw new Error(
    `la columna de dirección dice "${value}", que no significa nada bajo la cabecera "${header ?? '(sin cabecera)'}"`,
  );
}

/**
 * One of the cargo/abono cells, or `null` when it holds no value.
 *
 * Empty, a lone dash and a bare zero are "nothing here". Anything else that
 * will not parse is an *error*, and the exception is allowed through so the row
 * mapper records it as a failed row.
 *
 * It used to be swallowed. A cargo cell holding an amount too large to
 * represent exactly — `parseAmount` refuses those rather than rounding — came
 * back as `null`, the row was counted as deliberately skipped, `validation.ok`
 * stayed true and the import went ahead without it. A movement disappearing in
 * silence is the failure this whole gate exists to prevent, and it was
 * happening one `catch` away from it.
 */
function parseOptional(
  text: string,
  currency: string,
  format: StatementProfile['numberFormat'],
  warnings: TransactionWarning[],
): Money | null {
  if (text === '' || text === '-' || text === '0') return null;
  const parsed = parseAmount(text, { currency, format });
  if (parsed.ambiguous) {
    warnings.push({
      code: 'ambiguous-amount-format',
      message: 'El monto de esta fila admite más de una lectura.',
    });
  }
  return parsed.money;
}

function readOptionalMoney(
  text: string,
  profile: StatementProfile,
  currency: string,
): Money | undefined {
  if (text === '') return undefined;
  try {
    return parseAmount(text, { currency, format: profile.numberFormat }).money;
  } catch {
    return undefined;
  }
}

function readReference(row: readonly string[], map: ColumnMap): string | undefined {
  const value = cell(row, map, ColumnRole.reference);
  return value === '' ? undefined : value;
}

const CARD_TAIL = /(?:\*{2,}|X{2,}|N[°º]?\s*)(\d{4})\b/i;

function readCardLast4(
  row: readonly string[],
  map: ColumnMap,
  description: string,
): string | undefined {
  const column = cell(row, map, ColumnRole.card);
  const source = column !== '' ? column : description;
  const digits = source.replace(/\D/g, '');
  const marked = CARD_TAIL.exec(source);
  if (marked?.[1]) return marked[1];
  if (column !== '' && digits.length >= 4) return digits.slice(-4);
  return undefined;
}

/**
 * Keep the original row, keyed by header name.
 *
 * Only mapped columns plus anything non-empty are stored, and values are capped
 * so a runaway cell cannot bloat the metadata written back to Wealthfolio.
 */
function buildRawMetadata(row: readonly string[], map: ColumnMap): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [role, index] of Object.entries(map)) {
    if (index === undefined) continue;
    const value = (row[index] ?? '').trim();
    if (value !== '') out[role] = value.slice(0, 200);
  }
  return out;
}
