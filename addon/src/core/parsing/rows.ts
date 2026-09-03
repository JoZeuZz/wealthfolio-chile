import { parseStatementDate, type IsoDate } from '../dates';
import { detectInstallment } from '../installments/detect';
import { abs, isZero, negate, parseAmount, sign, type Money } from '../money';
import { defaultKindForRow } from '../classify/card-semantics';
import { Confidence, Direction } from '../model/kinds';
import type { RowStats, StatementIssue } from '../model/statement';
import type { NormalizedTransaction, TransactionWarning } from '../model/transaction';
import { normalizeDescription } from '../text';
import { cell, ColumnRole, type ColumnMap } from './columns';
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

  const transactions: NormalizedTransaction[] = [];
  const issues: StatementIssue[] = [];
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
      const transaction = mapRow({ row, line, map, profile, currency, fileHash, accountRef });
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
}

/**
 * Map one row. Returns `null` for rows that are structurally fine but carry no
 * movement (a zero-amount separator line, for instance).
 */
function mapRow(input: MapRowInput): NormalizedTransaction | null {
  const { row, line, map, profile, currency, fileHash, accountRef } = input;
  const warnings: TransactionWarning[] = [];

  const rawDate = cell(row, map, ColumnRole.date);
  if (rawDate === '') return null;

  const parsedDate = parseStatementDate(rawDate, { order: profile.dateOrder });
  if (parsedDate.ambiguous) {
    warnings.push({
      code: 'ambiguous-date-format',
      message: `La fecha "${rawDate}" es ambigua; se interpretó como ${parsedDate.date}.`,
    });
  }

  let postedDate: IsoDate | undefined;
  const rawPosted = cell(row, map, ColumnRole.postedDate);
  if (rawPosted !== '') {
    try {
      postedDate = parseStatementDate(rawPosted, { order: profile.dateOrder }).date;
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
