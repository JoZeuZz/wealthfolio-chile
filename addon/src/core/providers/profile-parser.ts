import { isIsoDate, parseStatementDate, type IsoDate } from '../dates';
import { add, compare, type Money } from '../money';
import {
  DETECTION_FLOOR,
  StatementProduct,
  type DetectionResult,
  type ParsedStatement,
  type RowStats,
  type StatementIssue,
  type StatementPeriod,
  type ValidationResult,
} from '../model/statement';
import { detectHeader, normalizeHeader, type ColumnMap } from '../parsing/columns';
import type { StatementProfile } from '../parsing/profile';
import { mapRows } from '../parsing/rows';
import type { NormalizedTransaction } from '../model/transaction';
import { isBlankRow, type Sheet } from '../parsing/tabular';
import { pickDataSheet } from '../parsing/workbook';
import { foldCase } from '../text';
import type { DetectionHints, ParserInput, StatementParser } from './parser';

/**
 * Builds a working parser from a declarative profile.
 *
 * Every bank adapter in this project is one of these. The behaviour that
 * actually differs between banks is data — column wording, sign convention,
 * which product the file describes — so it lives in the profile, and the
 * algorithm stays in one tested place.
 */
export function createProfileParser(
  profile: StatementProfile,
  hints: DetectionHints = {},
): StatementParser {
  return {
    id: profile.parserId,
    institution: profile.institution,
    label: profile.institutionLabel,
    profile,

    detect(input: ParserInput): DetectionResult {
      return detectWithProfile(profile, hints, input);
    },

    parse(input: ParserInput): ParsedStatement {
      return parseWithProfile(profile, input);
    },

    validate(statement: ParsedStatement): ValidationResult {
      return validateStatement(statement, profile);
    },
  };
}

/** Rows scanned when looking for bank markers and account metadata. */
const PREAMBLE_ROWS = 25;

function detectWithProfile(
  profile: StatementProfile,
  hints: DetectionHints,
  input: ParserInput,
): DetectionResult {
  const sheet = pickDataSheet(input.sheets);
  const header = detectHeader(sheet);

  // Markers are searched in the preamble and header only. Scanning the movement
  // rows too would let a single `PAGO TARJETA DE CREDITO` line convince the
  // card parser that a current-account cartola is a card statement.
  const preamble = preambleText(sheet, header.headerRow);
  const reasons: string[] = [];
  let score = 0;

  for (const pattern of hints.strongMarkers ?? []) {
    if (pattern.test(preamble)) {
      score += 0.5;
      reasons.push(`El archivo menciona "${describePattern(pattern)}".`);
      break;
    }
  }

  let weakHits = 0;
  for (const pattern of hints.weakMarkers ?? []) {
    if (pattern.test(preamble)) weakHits += 1;
  }
  if (weakHits > 0) {
    score += Math.min(0.3, weakHits * 0.1);
    reasons.push(`Vocabulario compatible (${weakHits} coincidencia(s)).`);
  }

  for (const pattern of hints.fileNamePatterns ?? []) {
    if (pattern.test(input.file.name)) {
      score += 0.15;
      reasons.push('El nombre del archivo sigue la convención del banco.');
      break;
    }
  }

  if (header.headerRow >= 0) {
    score += 0.25;
    reasons.push('Se encontró una cabecera con fecha, descripción y monto.');
  } else {
    // Without a usable header the parser cannot map anything, whatever else
    // matched. Reporting a floor score keeps it out of the picker.
    return {
      parser: profile.parserId,
      institution: profile.institution,
      score: 0,
      reasons: ['No se encontró una cabecera de columnas reconocible.'],
    };
  }

  const structural = scoreStructuralFit(profile, header.map);
  score += structural.score;
  reasons.push(...structural.reasons);

  const account = readAccountMetadata(sheet, profile, header.headerRow);
  if (account.number) {
    score += 0.05;
    reasons.push('Se encontró un número de cuenta en el encabezado.');
  }

  const period = readPeriod(sheet, profile, header.headerRow);

  return {
    parser: profile.parserId,
    institution: profile.institution,
    score: Math.min(1, score),
    reasons,
    account,
    ...(period.from || period.to ? { period } : {}),
  };
}

function parseWithProfile(profile: StatementProfile, input: ParserInput): ParsedStatement {
  const sheet = pickDataSheet(input.sheets);
  const header = detectHeader(sheet);
  const issues: StatementIssue[] = [];

  // Only one sheet is read. Saying so is the difference between "we read the
  // statement whole" and "we read the part of it we picked": bank workbooks do
  // split movements across sheets, by month or by product.
  const ignoredSheets = input.sheets.filter(
    (candidate) => candidate.name !== sheet.name && candidate.rows.some((row) => !isBlankRow(row)),
  );
  if (ignoredSheets.length > 0) {
    issues.push({
      level: 'warning',
      code: 'multiple-sheets',
      message: `El archivo tiene ${ignoredSheets.length + 1} hojas con datos y sólo se leyó "${sheet.name}". Si los movimientos están repartidos entre hojas, importa cada una por separado.`,
    });
  }

  if (header.headerRow < 0) {
    return {
      institution: profile.institution,
      parser: profile.parserId,
      parserVersion: profile.parserVersion,
      account: { product: profile.product, currency: profile.defaultCurrency },
      period: {},
      transactions: [],
      rowStats: { dataRows: 0, mapped: 0, skipped: 0, failed: 0 },
      issues: [
        {
          level: 'error',
          code: 'no-header',
          message:
            'No se encontró la fila de cabecera. Revisa que el archivo sea la cartola completa y no un resumen.',
        },
      ],
      fileHash: input.fileHash,
      fileName: input.file.name,
    };
  }

  const map = mergeSynonyms(sheet, header.headerRow, profile, header.map);
  const account = readAccountMetadata(sheet, profile, header.headerRow);
  const currency = (input.currency ?? account.currency ?? profile.defaultCurrency).toUpperCase();

  const mapped = mapRows({
    sheet,
    map,
    profile,
    firstDataRow: header.firstDataRow,
    fileHash: input.fileHash,
    ...(account.number !== undefined ? { accountRef: account.number } : {}),
    currency,
  });

  issues.push(...mapped.issues);

  if (profile.validationStatus === 'pending-real-sample') {
    issues.push({
      level: 'warning',
      code: 'profile-unverified',
      message: `El formato de ${profile.institutionLabel} aún no se ha validado con una cartola real. Revisa la vista previa con especial atención.`,
    });
  }

  if (mapped.transactions.length === 0) {
    issues.push({
      level: 'error',
      code: 'no-transactions',
      message: 'No se reconoció ningún movimiento en el archivo.',
    });
  }

  const period = derivePeriod(mapped.transactions.map((t) => t.date), readPeriod(sheet, profile, header.headerRow));

  return {
    institution: profile.institution,
    parser: profile.parserId,
    parserVersion: profile.parserVersion,
    account: { ...account, currency },
    period,
    transactions: mapped.transactions,
    rowStats: mapped.stats,
    issues,
    fileHash: input.fileHash,
    fileName: input.file.name,
  };
}

/**
 * Re-map the header row with the profile's extra synonyms layered in.
 *
 * The generic map is computed first so a bank-specific wording can only add
 * roles, never silently steal a column the generic pass already resolved
 * correctly.
 */
function mergeSynonyms(
  sheet: Sheet,
  headerRow: number,
  profile: StatementProfile,
  generic: ColumnMap,
): ColumnMap {
  if (!profile.columnSynonyms) return generic;

  const row = (sheet.rows[headerRow] ?? []).map(normalizeHeader);
  const merged: ColumnMap = { ...generic };
  const taken = new Set(Object.values(generic).filter((v): v is number => v !== undefined));

  for (const [role, synonyms] of Object.entries(profile.columnSynonyms)) {
    const key = role as keyof ColumnMap;
    if (merged[key] !== undefined || !synonyms) continue;
    for (const synonym of synonyms) {
      const wanted = normalizeHeader(synonym);
      const index = row.findIndex((cell, i) => !taken.has(i) && cell === wanted);
      if (index >= 0) {
        merged[key] = index;
        taken.add(index);
        break;
      }
    }
  }

  return merged;
}

/** Render a marker pattern as something a person can read in the UI. */
function describePattern(pattern: RegExp): string {
  return pattern.source
    .replace(/\\b|\(\?:|\)|\?|\^|\$/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\\s\+?/g, ' ')
    .replace(/\|/g, ' / ')
    .trim();
}

/**
 * Structural evidence for or against a product.
 *
 * Column shape is a far more reliable signal than vocabulary: a running balance
 * column means a cash account, because a card statement has no balance to
 * carry; a cuota column means a card, because a current account has no
 * installments. Weighing this alongside the name markers is what stops a card
 * parser from claiming a cartola that merely mentions a card payment.
 */
function scoreStructuralFit(
  profile: StatementProfile,
  map: ColumnMap,
): { score: number; reasons: string[] } {
  const hasBalance = map.balance !== undefined;
  const hasDebitCredit = map.debit !== undefined && map.credit !== undefined;
  const hasInstallment = map.installment !== undefined;

  const isCardProfile =
    profile.product === StatementProduct.credit_card ||
    profile.product === StatementProduct.credit_line;

  let score = 0;
  const reasons: string[] = [];

  if (isCardProfile) {
    if (hasInstallment) {
      score += 0.2;
      reasons.push('Tiene una columna de cuotas, propia de un estado de cuenta de tarjeta.');
    }
    if (hasBalance) {
      score -= 0.3;
      reasons.push('Tiene columna de saldo, que un estado de cuenta de tarjeta no lleva.');
    }
    if (hasDebitCredit) {
      score -= 0.15;
      reasons.push('Separa cargos y abonos como una cuenta corriente.');
    }
  } else {
    if (hasBalance) {
      score += 0.2;
      reasons.push('Tiene columna de saldo, propia de una cuenta.');
    }
    if (hasDebitCredit) {
      score += 0.15;
      reasons.push('Separa cargos y abonos.');
    }
    if (hasInstallment && !hasBalance) {
      score -= 0.15;
      reasons.push('Tiene columna de cuotas, más propia de una tarjeta.');
    }
  }

  return { score, reasons };
}

/**
 * Text of the rows above the header, plus the header itself.
 *
 * That region is where a bank prints its own name, the account number and the
 * period — and, crucially, it contains no transaction descriptions.
 */
function preambleText(sheet: Sheet, headerRow: number): string {
  const end = headerRow >= 0 ? headerRow + 1 : Math.min(sheet.rows.length, PREAMBLE_ROWS);
  return foldCase(
    sheet.rows
      .slice(0, end)
      .map((row) => row.join(' '))
      .join('\n'),
  );
}

const ACCOUNT_PATTERNS = [
  /\b(?:CUENTA|CTA)\.?\s*(?:CORRIENTE|VISTA|RUT|DE\s+AHORRO)?\s*(?:N[º°]?|NRO\.?|NUMERO)?\s*:?\s*([\d.-]{6,})/i,
  /\bTARJETA\s*(?:N[º°]?|NRO\.?)?\s*:?\s*([\dX*.-]{8,})/i,
];

const CURRENCY_PATTERNS: Array<[RegExp, string]> = [
  [/\b(?:PESOS|MONEDA\s+NACIONAL|CLP|\$\s*CHILENOS?)\b/i, 'CLP'],
  [/\b(?:D[OÓ]LARES?|USD|US\$)\b/i, 'USD'],
  [/\b(?:UF|UNIDAD(?:ES)?\s+DE\s+FOMENTO)\b/i, 'CLF'],
];

function readAccountMetadata(
  sheet: Sheet,
  profile: StatementProfile,
  headerRow: number,
): { number?: string; product: StatementProduct; currency: string } {
  const end = headerRow >= 0 ? headerRow + 1 : Math.min(sheet.rows.length, PREAMBLE_ROWS);
  const text = sheet.rows
    .slice(0, end)
    .map((row) => row.join(' '))
    .join('\n');

  let number: string | undefined;
  for (const pattern of ACCOUNT_PATTERNS) {
    const match = pattern.exec(text);
    if (match?.[1]) {
      number = match[1].replace(/[.\s]/g, '');
      break;
    }
  }

  let currency = profile.defaultCurrency;
  for (const [pattern, code] of CURRENCY_PATTERNS) {
    if (pattern.test(text)) {
      currency = code;
      break;
    }
  }

  return { ...(number !== undefined ? { number } : {}), product: profile.product, currency };
}

const PERIOD_PATTERN =
  /\b(?:PER[IÍ]ODO|DESDE|ENTRE)\b[^\d]{0,20}(\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}|\d{4}-\d{2}-\d{2})[^\d]{1,20}(\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}|\d{4}-\d{2}-\d{2})/i;

function readPeriod(sheet: Sheet, profile: StatementProfile, headerRow: number): StatementPeriod {
  const end = headerRow >= 0 ? headerRow + 1 : Math.min(sheet.rows.length, PREAMBLE_ROWS);
  const text = sheet.rows
    .slice(0, end)
    .map((row) => row.join(' '))
    .join('\n');
  const match = PERIOD_PATTERN.exec(text);
  if (!match?.[1] || !match[2]) return {};
  try {
    return {
      from: parseStatementDate(match[1], { order: profile.dateOrder }).date,
      to: parseStatementDate(match[2], { order: profile.dateOrder }).date,
    };
  } catch {
    return {};
  }
}

/** Prefer the period the file declares; fall back to the movement range. */
function derivePeriod(dates: readonly IsoDate[], declared: StatementPeriod): StatementPeriod {
  if (declared.from && declared.to) return declared;
  const valid = dates.filter((d) => isIsoDate(d)).slice().sort();
  if (valid.length === 0) return declared;
  return {
    from: declared.from ?? (valid[0] as IsoDate),
    to: declared.to ?? (valid[valid.length - 1] as IsoDate),
  };
}

/**
 * Coherence checks over a parsed statement.
 *
 * The strongest available check is the balance walk: when the file reports a
 * running balance, the movements between two consecutive rows must explain the
 * difference. A statement that fails it has been mis-parsed — usually a sign
 * convention or a missed column — and is worth blocking before it reaches the
 * user's ledger.
 */
export function validateStatement(
  statement: ParsedStatement,
  profile: StatementProfile,
): ValidationResult {
  const issues: StatementIssue[] = [...statement.issues];
  const { transactions } = statement;

  const balanceReconciles = checkBalanceWalk(statement, profile, issues);

  for (const transaction of transactions) {
    for (const warning of transaction.warnings) {
      issues.push({
        level: 'warning',
        code: warning.code,
        message: warning.message,
        ...(transaction.sourceLine !== undefined ? { line: transaction.sourceLine } : {}),
      });
    }
  }

  const stats: RowStats = statement.rowStats;

  return {
    ok: transactions.length > 0 && !issues.some((issue) => issue.level === 'error'),
    issues,
    summary: {
      // Straight from the row loop, never inferred from how many issues were
      // raised: one issue can describe several rows and several issues one row,
      // so counting prose was reporting a number that meant nothing.
      totalRows: stats.dataRows,
      parsedRows: stats.mapped,
      skippedRows: stats.skipped,
      errorRows: stats.failed,
      ...(balanceReconciles !== undefined ? { balanceReconciles } : {}),
    },
  };
}

/**
 * Share of balance steps that must fail before the mismatch stops being a bank
 * quirk and starts being a misread file.
 *
 * A bank printing one rounded or out-of-order balance is ordinary. Half the
 * statement failing is not: it means a sign convention or a column is wrong,
 * and every amount in the file is suspect — including the ones whose steps
 * happened to add up.
 */
const SYSTEMATIC_MISMATCH_RATIO = 0.5;

/**
 * Steps needed before a *proportion* means anything.
 *
 * With one step, any quirk at all is 100 %. Without this floor a two-line
 * cartola with a single rounded balance is indistinguishable from a statement
 * read entirely wrong, and gets blocked as if it were.
 */
const MIN_STEPS_FOR_SYSTEMATIC = 4;

/**
 * Walk the declared running balance and see whether the movements explain it.
 *
 * Two things this has to get right before it is allowed to block anything, both
 * of which it originally got wrong:
 *
 * **Order.** The walk is over the ledger, not over the file. Banco de Chile and
 * Santander export newest-first by default, and reading that top to bottom
 * makes every single step disagree — a correct cartola scoring a 100 %
 * mismatch. The rows are put in ledger order first, and when they are in no
 * date order at all the check declines to answer rather than inventing a
 * failure.
 *
 * **Gaps.** Plenty of Chilean cartolas print the balance once per day and leave
 * it blank on the rows in between. Comparing a balance against only the amount
 * on its own row drops everything between the two, so almost every step fails.
 * Amounts accumulate across the gap instead.
 */
function checkBalanceWalk(
  statement: ParsedStatement,
  profile: StatementProfile,
  issues: StatementIssue[],
): boolean | undefined {
  const ordered = inLedgerOrder(statement.transactions);
  if (!ordered) {
    issues.push({
      level: 'info',
      code: 'balance-walk-skipped',
      message:
        'Las filas no vienen ordenadas por fecha, así que no se pudo comprobar que el saldo declarado cuadre con los montos.',
    });
    return undefined;
  }

  let previousBalance: Money | undefined;
  let pending: Money | undefined;
  let steps = 0;
  let mismatches = 0;

  for (const transaction of ordered) {
    pending = pending ? add(pending, transaction.amount) : transaction.amount;
    const balance = transaction.balanceAfter;
    if (!balance) continue;

    if (previousBalance) {
      steps += 1;
      if (compare(add(previousBalance, pending), balance) !== 0) mismatches += 1;
    }
    previousBalance = balance;
    pending = undefined;
  }

  if (steps === 0) return undefined;
  if (mismatches === 0) return true;

  const systematic =
    steps >= MIN_STEPS_FOR_SYSTEMATIC && mismatches / steps >= SYSTEMATIC_MISMATCH_RATIO;

  if (systematic) {
    issues.push({
      level: 'error',
      code: 'balance-walk-systematic',
      message: `El saldo declarado no cuadra con los montos en ${mismatches} de ${steps} pasos. Con esa proporción no es una rareza del banco: el archivo se está leyendo mal (signo, columna o formato de monto), así que ningún movimiento de esta cartola es confiable.`,
    });
    return false;
  }

  issues.push({
    // `authoritative` means someone confirmed against a real export that this
    // bank's balance column walks exactly. Only then does a single bad step
    // prove the parse is wrong; otherwise it is something to look at.
    level: profile.balanceCheck === 'authoritative' ? 'error' : 'warning',
    code: 'balance-walk-mismatch',
    message: `El saldo declarado no cuadra con los montos en ${mismatches} de ${steps} pasos. Es probable que el signo de los montos o alguna columna estén mal interpretados.`,
  });
  return false;
}

/**
 * The rows in the order the account actually moved, or `undefined` when the
 * file is in no date order at all.
 *
 * Reversing a descending export is safe in a way that sorting is not: it keeps
 * same-day rows in the sequence the bank printed them, which for a cartola in
 * reverse is also reversed. Sorting by date alone would leave those the wrong
 * way round and the walk would fail inside every busy day.
 */
function inLedgerOrder(
  transactions: readonly NormalizedTransaction[],
): readonly NormalizedTransaction[] | undefined {
  const dates = transactions.map((transaction) => transaction.date);
  let ascending = true;
  let descending = true;
  for (let i = 1; i < dates.length; i += 1) {
    const previous = dates[i - 1] as string;
    const current = dates[i] as string;
    if (current < previous) ascending = false;
    if (current > previous) descending = false;
  }
  if (ascending) return transactions;
  if (descending) return [...transactions].reverse();
  return undefined;
}

export { DETECTION_FLOOR };
