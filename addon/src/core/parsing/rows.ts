import { parseStatementDate, type IsoDate } from '../dates';
import { detectInstallment } from '../installments/detect';
import { abs, isZero, negate, parseAmount, sign, type Money } from '../money';
import { defaultKindForRow } from '../classify/card-semantics';
import { Confidence, Direction } from '../model/kinds';
import type { RowStats, StatementIssue } from '../model/statement';
import type { NormalizedTransaction, TransactionWarning } from '../model/transaction';
import { normalizeDescription } from '../text';
import { cell, ColumnRole, type ColumnMap } from './columns';
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
  const dateOrder = resolveDateOrder(
    sheet.rows.slice(firstDataRow).map((row) => cell(row as string[], map, ColumnRole.date)),
    profile.dateOrder,
  );

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

    const rawDescription = cell(row, map, ColumnRole.description);
    if (ignorePatterns.some((pattern) => pattern.test(rawDescription.trim()))) {
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
        message: `Fila ${line}: ${(error as Error).message}`,
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
}

/**
 * Map one row. Returns `null` for rows that are structurally fine but carry no
 * movement (a zero-amount separator line, for instance).
 */
function mapRow(input: MapRowInput): NormalizedTransaction | null {
  const { row, line, map, profile, currency, fileHash, accountRef, dateOrder } = input;
  const warnings: TransactionWarning[] = [];

  const rawDate = cell(row, map, ColumnRole.date);
  if (rawDate === '') return null;

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
        message: `No se pudo leer la fecha contable "${rawPosted}".`,
      });
    }
  }

  const description = cell(row, map, ColumnRole.description);
  const amountResult = readAmount({ row, map, profile, currency, warnings });
  if (amountResult === null) return null;
  const amount = amountResult;

  if (isZero(amount)) {
    // A zero movement carries no financial meaning but often marks a
    // formatting artefact, so it is reported rather than silently dropped.
    warnings.push({ code: 'zero-amount', message: 'El movimiento tiene monto cero.' });
  }

  const balanceAfter = readOptionalMoney(cell(row, map, ColumnRole.balance), profile, currency);
  const direction = sign(amount) < 0 ? Direction.out : Direction.in;

  const installment = detectInstallment(description, cell(row, map, ColumnRole.installment));
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
        message: `Hay fechas que sólo se entienden como ${describeOrder('DMY')} y otras que sólo se entienden como ${describeOrder('MDY')}. Se usó ${describeOrder(profile.dateOrder)}; las filas que no se puedan leer así aparecerán como error.`,
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

interface ReadAmountInput {
  row: string[];
  map: ColumnMap;
  profile: StatementProfile;
  currency: string;
  warnings: TransactionWarning[];
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
      message: `El monto "${amountText}" admite más de una lectura; se interpretó como ${parsed.money.minor / 10 ** parsed.money.scale}.`,
    });
  }

  const flag = cell(row, map, ColumnRole.directionFlag).toUpperCase();
  if (flag !== '') {
    const outflow = /^(C|CARGO|D|DEBITO|DÉBITO|DEBE)$/.test(flag);
    return outflow ? negate(abs(parsed.money)) : abs(parsed.money);
  }

  if (profile.amountSign === 'debit-positive') return negate(parsed.money);
  if (profile.amountSign === 'credit-positive') return parsed.money;
  return parsed.money;
}

function parseOptional(
  text: string,
  currency: string,
  format: StatementProfile['numberFormat'],
  warnings: TransactionWarning[],
): Money | null {
  if (text === '' || text === '-' || text === '0') return null;
  try {
    const parsed = parseAmount(text, { currency, format });
    if (parsed.ambiguous) {
      warnings.push({
        code: 'ambiguous-amount-format',
        message: `El monto "${text}" admite más de una lectura.`,
      });
    }
    return parsed.money;
  } catch {
    return null;
  }
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
