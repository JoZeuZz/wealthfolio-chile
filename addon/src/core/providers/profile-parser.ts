import {
  isIsoDate,
  parseStatementDate,
  splitDayMonth,
  toIsoDate,
  type DateYearHint,
  type IsoDate,
} from '../dates';
import { add, compare, parseAmount, subtract, sum, type Money } from '../money';
import {
  DETECTION_FLOOR,
  StatementProduct,
  type DetectionResult,
  type ParsedStatement,
  type RowStats,
  type StatementBalance,
  type StatementIssue,
  type StatementPeriod,
  type ValidationResult,
} from '../model/statement';
import { cell, ColumnRole, detectHeader, normalizeHeader, type ColumnMap } from '../parsing/columns';
import { COMMON_IGNORE_PATTERNS, type StatementProfile } from '../parsing/profile';
import { isIgnoredRow, mapRows } from '../parsing/rows';
import type { NormalizedTransaction } from '../model/transaction';
import { detectFileKind, isBlankRow, type Sheet } from '../parsing/tabular';
import { pickDataSheet } from '../parsing/workbook';
import { readCardFacts } from './card-facts';
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
  const fromColumn = readCurrencyColumn(sheet, map, header.firstDataRow, [
    ...COMMON_IGNORE_PATTERNS,
    ...(profile.ignoreRowPatterns ?? []),
  ]);

  if (fromColumn.length > 1) {
    // The role was mapped, the column was reserved, and nothing read it: every
    // row took the statement-level currency, which itself falls back to
    // `profile.defaultCurrency`. A USD 120,50 charge on a mixed-currency
    // statement was stored as CLP 120,50 — about $115.000 of real spending
    // recorded as $120 — and `matchStatementToAccount` then compared the
    // invented CLP against a CLP account and reported `compatible`, so the
    // currency guard could not catch it either.
    //
    // One currency per statement is what the rest of this pipeline is built
    // for: the account match, the balance walk and the period totals all assume
    // it. So a file that carries more than one is refused rather than flattened.
    issues.push({
      level: 'error',
      code: 'mixed-currency',
      message: `La cartola mezcla ${fromColumn.join(' y ')} en la misma columna de moneda. Impórtala en archivos separados, uno por moneda.`,
    });
  }

  const currency = (
    input.currency ??
    fromColumn[0] ??
    account.currency ??
    profile.defaultCurrency
  ).toUpperCase();

  // Read before mapping the rows, not after: a date cell that names no year
  // (`profile.dateOmitsYear`) needs the declared period to resolve one, and
  // that period comes from the preamble, never from the transactions it is
  // about to help produce.
  const declaredPeriod = profile.periodFromBalanceRows
    ? derivePeriodFromBalanceRows(
        sheet,
        map,
        header.headerRow,
        header.firstDataRow,
        profile.periodFromBalanceRows,
        profile.dateOrder,
      )
    : readPeriod(sheet, profile, header.headerRow);

  // A per-column format proven only for a spreadsheet source stays scoped to
  // spreadsheet cells that themselves prove the configured lexical evidence.
  // A `.csv` export, or an XLSX column without that evidence, keeps the
  // statement-wide `numberFormat`.
  const fileKind = detectFileKind(input.file);
  const isSpreadsheet = fileKind === 'xlsx' || fileKind === 'xls';
  const columnNumberFormats = isSpreadsheet
    ? resolveSpreadsheetColumnNumberFormats(profile, sheet, map, header.firstDataRow)
    : undefined;

  const mapped = mapRows({
    sheet,
    map,
    profile,
    firstDataRow: header.firstDataRow,
    fileHash: input.fileHash,
    ...(account.number !== undefined ? { accountRef: account.number } : {}),
    currency,
    ...(profile.dateOmitsYear ? { yearHint: declaredPeriod } : {}),
    ...(columnNumberFormats !== undefined ? { columnNumberFormats } : {}),
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

  const period = derivePeriod(mapped.transactions.map((t) => t.date), declaredPeriod);
  const balances = readBalances({
    sheet,
    map,
    profile,
    headerRow: header.headerRow,
    firstDataRow: header.firstDataRow,
    currency,
    transactions: mapped.transactions,
    stats: mapped.stats,
    issues,
  });

  // Only on a card. A cuenta corriente has no billing cycle, no minimum payment
  // and no cupo, so `PAGO MINIMO` in its preamble is somebody else's figure —
  // a card mentioned in passing, or marketing copy.
  const cardFacts =
    profile.product === StatementProduct.credit_card ||
    profile.product === StatementProduct.credit_line
      ? readCardFacts({
          preamble: preambleText(sheet, header.headerRow),
          currency,
          ...(profile.numberFormat ? { numberFormat: profile.numberFormat } : {}),
          // The profile's own order, the same one `readPeriod` uses. Without it
          // the facts fell back to DMY while the period beside them followed the
          // profile — two readings of the same file by different rules.
          dateOrder: profile.dateOrder,
        })
      : undefined;

  return {
    institution: profile.institution,
    parser: profile.parserId,
    parserVersion: profile.parserVersion,
    account: { ...account, currency },
    period,
    transactions: mapped.transactions,
    rowStats: mapped.stats,
    ...(balances.opening !== undefined ? { openingBalance: balances.opening } : {}),
    ...(balances.closing !== undefined ? { closingBalance: balances.closing } : {}),
    ...(cardFacts && Object.keys(cardFacts).length > 0 ? { cardFacts } : {}),
    issues,
    fileHash: input.fileHash,
    fileName: input.file.name,
  };
}

/**
 * Wording that names the balance before the period's first movement.
 *
 * `SALDO ANTERIOR` is the previous statement's closing balance, which is the
 * same number seen from the other side.
 */
const DECLARED_OPENING = /\bSALDO\s+(?:INICIAL|ANTERIOR)\b[^\d(+-]{0,40}([(+-]?[\d.,]+\)?-?)/i;

/**
 * Wording that names the balance after the period's last movement.
 *
 * `SALDO DISPONIBLE` is deliberately absent: in a Chilean cuenta corriente the
 * available balance includes the línea de crédito, so reading it as the
 * period's closing balance invents funds that are not there — and does it with
 * the authority of something the file "declared". `SALDO ACTUAL` is absent for
 * a quieter reason: on a statement downloaded mid-period it is today's
 * balance, not the balance at the end of what the file covers.
 */
const DECLARED_CLOSING = /\bSALDO\s+(?:FINAL|CONTABLE)\b[^\d(+-]{0,40}([(+-]?[\d.,]+\)?-?)/i;

interface StatementBalances {
  opening?: StatementBalance;
  closing?: StatementBalance;
}

/**
 * The balance before the first movement and after the last one, from whatever
 * evidence the file offers — derived first, declared second.
 *
 * Derived wins because it shares its sign convention and its number format
 * with the amounts it will be compared against, while a preamble figure shares
 * neither. When the two disagree that disagreement is itself worth reporting,
 * and `validateStatement` does that rather than this function picking a winner
 * quietly.
 */
function readBalances(input: {
  sheet: Sheet;
  map: ColumnMap;
  profile: StatementProfile;
  headerRow: number;
  firstDataRow: number;
  currency: string;
  transactions: readonly NormalizedTransaction[];
  stats: RowStats;
  issues: StatementIssue[];
}): StatementBalances {
  const derived = deriveBalances(input.transactions, input.stats, input.currency);

  // The anchor rows are trustworthy whenever the layout has them — a real row
  // with a real balance cell, never a label the preamble scan below could
  // confuse for one. But not every file that reaches this profile has them
  // (a file with no `SALDO INICIAL`/`SALDO FINAL` row at all still deserves
  // whatever the preamble states), so a side the anchors do not find falls
  // back to the generic scan rather than losing the balance outright.
  const fromAnchors = input.profile.periodFromBalanceRows
    ? readDeclaredBalancesFromAnchorRows(
        input.sheet,
        input.map,
        input.firstDataRow,
        input.profile.periodFromBalanceRows,
        input.currency,
        input.profile.numberFormat,
      )
    : {};
  const fromPreamble = readDeclaredBalances(input.sheet, input.profile, input.headerRow, input.currency);
  const declared: StatementBalances = {
    ...(fromAnchors.opening ?? fromPreamble.opening
      ? { opening: fromAnchors.opening ?? (fromPreamble.opening as StatementBalance) }
      : {}),
    ...(fromAnchors.closing ?? fromPreamble.closing
      ? { closing: fromAnchors.closing ?? (fromPreamble.closing as StatementBalance) }
      : {}),
  };

  reportDisagreement('inicial', derived.opening, declared.opening, input.issues);
  reportDisagreement('final', derived.closing, declared.closing, input.issues);

  return {
    ...(derived.opening ?? declared.opening
      ? { opening: derived.opening ?? (declared.opening as StatementBalance) }
      : {}),
    ...(derived.closing ?? declared.closing
      ? { closing: derived.closing ?? (declared.closing as StatementBalance) }
      : {}),
  };
}

/**
 * The file saying one thing and its own numbers saying another.
 *
 * Both figures describe the same moment, so a disagreement means one of them
 * was read wrong — a misread balance column, a stray number beside the word
 * "saldo", or, worst and likeliest, an amount whose sign came out backwards.
 * Reported rather than resolved: the derived figure is the one this pipeline
 * keeps, because it shares its sign convention with the amounts, but which of
 * the two is right is not something the parser can decide from the file alone.
 */
function reportDisagreement(
  which: 'inicial' | 'final',
  derived: StatementBalance | undefined,
  declared: StatementBalance | undefined,
  issues: StatementIssue[],
): void {
  if (!derived || !declared) return;
  if (derived.amount.currency !== declared.amount.currency) return;
  if (compare(derived.amount, declared.amount) === 0) return;

  issues.push({
    level: 'warning',
    code: 'balance-declared-mismatch',
    message: `El saldo ${which} que declara la cabecera no coincide con el que se desprende de la columna de saldo y los montos. Uno de los dos se está leyendo mal.`,
  });
}

/**
 * Balances read out of the running-balance column.
 *
 * Three conditions, all of them about whether the movement list in memory is
 * the movement list the file has.
 *
 * **Order.** "First row" is not "first movement": Banco de Chile and Santander
 * export newest first. `inLedgerOrder` puts them the right way round, and when
 * the file is in no date order at all it declines rather than picking an end
 * arbitrarily.
 *
 * **Completeness.** A row that failed to parse is not in `transactions`, so
 * the first movement in memory may not be the first movement of the period,
 * and subtracting its amount from its balance would produce an opening balance
 * for the wrong moment. With any failed row, nothing is derived.
 *
 * **Presence.** Plenty of cartolas print the balance once per day. The first
 * movement having no balance means there is no opening to derive, not that the
 * opening is zero.
 */
function deriveBalances(
  transactions: readonly NormalizedTransaction[],
  stats: RowStats,
  currency: string,
): StatementBalances {
  if (stats.failed > 0) return {};
  const order = ledgerOrder(transactions);
  if (!order || order.rows.length === 0) return {};

  const rows = order.rows;
  const first = rows[0] as NormalizedTransaction;
  const last = rows[rows.length - 1] as NormalizedTransaction;
  const out: StatementBalances = {};

  // An end is only an end if the file says which row it is. Two rows sharing
  // the first date are two candidates for "the first movement", and the
  // opening balance is defined against exactly one of them. On an ascending
  // file the printed order settles it — a bank lists a day's movements in the
  // order it posted them — but on a descending file the rows were reversed to
  // get here, and reversing a day is a guess about the bank's layout, not
  // something the file states.
  const firstIsUnique = order.direction === 'ascending' || !sameDate(rows[0], rows[1]);
  const lastIsUnique =
    order.direction === 'ascending' || !sameDate(rows[rows.length - 1], rows[rows.length - 2]);

  if (firstIsUnique && first.balanceAfter && first.balanceAfter.currency === currency) {
    out.opening = { amount: subtract(first.balanceAfter, first.amount), source: 'derived' };
  }
  if (lastIsUnique && last.balanceAfter && last.balanceAfter.currency === currency) {
    out.closing = { amount: last.balanceAfter, source: 'derived' };
  }
  return out;
}

function sameDate(
  a: NormalizedTransaction | undefined,
  b: NormalizedTransaction | undefined,
): boolean {
  return a !== undefined && b !== undefined && a.date === b.date;
}

/**
 * Balances printed in the preamble.
 *
 * Not read on a card. `SALDO ANTERIOR $450.000` on a tarjeta is what you owe,
 * so in this pipeline's sign convention it is negative — but the preamble has
 * no debit/credit column to say so, and there is no real card export to
 * calibrate against. A number whose sign is a guess is not evidence, and
 * labelling it `declared` would give the guess more standing than the amounts
 * it would be checked against.
 */
function readDeclaredBalances(
  sheet: Sheet,
  profile: StatementProfile,
  headerRow: number,
  currency: string,
): StatementBalances {
  if (
    profile.product === StatementProduct.credit_card ||
    profile.product === StatementProduct.credit_line
  ) {
    return {};
  }

  const end = headerRow >= 0 ? headerRow + 1 : Math.min(sheet.rows.length, PREAMBLE_ROWS);
  const text = sheet.rows
    .slice(0, end)
    .map((row) => row.join(' '))
    .join('\n');

  const out: StatementBalances = {};
  const opening = readDeclared(DECLARED_OPENING, text, profile, currency);
  if (opening) out.opening = opening;
  const closing = readDeclared(DECLARED_CLOSING, text, profile, currency);
  if (closing) out.closing = closing;
  return out;
}

function readDeclared(
  pattern: RegExp,
  text: string,
  profile: StatementProfile,
  currency: string,
): StatementBalance | undefined {
  const match = pattern.exec(text);
  if (!match?.[1]) return undefined;
  try {
    return {
      amount: parseAmount(match[1], { currency, format: profile.numberFormat }).money,
      source: 'declared',
    };
  } catch {
    // A preamble figure that will not parse is not worth an issue of its own:
    // it is the one place in the file where a stray number next to the word
    // "saldo" is routine.
    return undefined;
  }
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

/**
 * The distinct currencies the file states per row, in the order first seen.
 *
 * Normalised through the same patterns the preamble uses, because `$`, `PESOS`
 * and `CLP` are one currency written three ways. Comparing the raw cells made a
 * statement that mixed two spellings look like a statement that mixes two
 * currencies, and a statement written entirely in `PESOS` adopted `PESOS` as
 * its currency code — which then failed the account match against a CLP account
 * and refused an ordinary cartola.
 *
 * Rows the profile ignores do not vote. A footer reading
 * `TOTAL DEL PERIODO;PESOS;…` is not a second currency.
 *
 * A code we do not recognise is kept as written (upper-cased): refusing every
 * currency this project has not enumerated would be worse than carrying `EUR`
 * through to an account match that can judge it.
 */
function readCurrencyColumn(
  sheet: Sheet,
  map: ColumnMap,
  firstDataRow: number,
  ignorePatterns: readonly RegExp[],
): string[] {
  if (map.currency === undefined) return [];
  const seen: string[] = [];
  for (let i = firstDataRow; i < sheet.rows.length; i += 1) {
    const row = sheet.rows[i] as string[];
    if (isBlankRow(row) || isIgnoredRow(row, map, ignorePatterns)) continue;
    const raw = cell(row, map, ColumnRole.currency).trim();
    if (raw === '') continue;
    const code = normalizeCurrency(raw);
    if (!seen.includes(code)) seen.push(code);
  }
  return seen;
}

/** `$`, `PESOS` and `CLP` all mean CLP. Anything unrecognised stays as written. */
function normalizeCurrency(text: string): string {
  const trimmed = text.trim();
  // A currency *column* holding a bare `$` is the peso. The preamble patterns
  // require `$ chilenos` because there the symbol appears next to amounts and
  // means nothing on its own; in a column whose whole job is to name the
  // currency, it does.
  if (trimmed === '$') return 'CLP';
  for (const [pattern, code] of CURRENCY_PATTERNS) {
    if (pattern.test(trimmed)) return code;
  }
  return trimmed.toUpperCase();
}

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
  const lines = sheet.rows.slice(0, end).map((row) => row.join(' '));
  const text = lines.join('\n');

  const match = PERIOD_PATTERN.exec(text) ?? firstProfilePeriodMatch(lines, profile.periodLinePattern);
  if (!match?.[1] || !match[2]) return {};
  try {
    const first = parseStatementDate(match[1], { order: profile.dateOrder }).date;
    const second = parseStatementDate(match[2], { order: profile.dateOrder }).date;
    return first <= second ? { from: first, to: second } : {};
  } catch {
    return {};
  }
}

function firstProfilePeriodMatch(
  lines: readonly string[],
  pattern: RegExp | undefined,
): RegExpExecArray | null {
  if (!pattern) return null;
  for (const line of lines) {
    pattern.lastIndex = 0;
    const match = pattern.exec(line);
    pattern.lastIndex = 0;
    if (match) return match;
  }
  return null;
}

/**
 * `dateOmitsYear`'s year hint, built from two structural rows instead of a
 * declared period — see `StatementProfile.periodFromBalanceRows`.
 *
 * Every step fails closed to `{}` rather than guess: a missing emission date,
 * a missing anchor row, or `SALDO FINAL` landing on a different day/month
 * than the emission date all mean this file does not keep the one promise
 * this derivation is built on, and `dateOmitsYear` then refuses every row
 * with `missing-year` — the same outcome as a bank that never declared a
 * period at all, just for a specific, checkable reason instead of a shrug.
 */
function derivePeriodFromBalanceRows(
  sheet: Sheet,
  map: ColumnMap,
  headerRow: number,
  firstDataRow: number,
  anchors: NonNullable<StatementProfile['periodFromBalanceRows']>,
  dateOrder: StatementProfile['dateOrder'],
): DateYearHint {
  const preambleEnd = headerRow >= 0 ? headerRow : Math.min(sheet.rows.length, PREAMBLE_ROWS);
  const preambleText = sheet.rows
    .slice(0, preambleEnd)
    .map((row) => row.join(' '))
    .join('\n');
  const emission = findLabeledDate(preambleText, anchors.emissionDateLabel, dateOrder);
  if (!emission) return {};

  const openingRaw = findAnchorRowCell(sheet, map, firstDataRow, anchors.openingLabel, ColumnRole.date);
  const closingRaw = findAnchorRowCell(sheet, map, firstDataRow, anchors.closingLabel, ColumnRole.date);
  if (!openingRaw || !closingRaw) return {};

  const opening = parseDayMonthCell(openingRaw, dateOrder);
  const closing = parseDayMonthCell(closingRaw, dateOrder);
  if (!opening || !closing) return {};

  const emissionMonth = Number(emission.slice(5, 7));
  const emissionDay = Number(emission.slice(8, 10));
  if (closing.month !== emissionMonth || closing.day !== emissionDay) return {};

  const closingYear = Number(emission.slice(0, 4));
  // The interval crosses a year turn exactly when the opening side's month
  // comes *after* the closing side's — "28 dic .. 05 ene" — the same test
  // `resolveYearForMonth` (core/dates.ts) makes from a declared range; here
  // the range is these two exact months, not a guess between them.
  const openingYear = opening.month > closing.month ? closingYear - 1 : closingYear;

  try {
    const to = toIsoDate(closingYear, closing.month, closing.day);
    const from = toIsoDate(openingYear, opening.month, opening.day);
    return from <= to ? { from, to } : {};
  } catch {
    return {};
  }
}

/** A single labelled date in free text, e.g. `Fecha de Emisión: 05/03/2026`. */
function findLabeledDate(
  text: string,
  label: RegExp,
  order: StatementProfile['dateOrder'],
): IsoDate | undefined {
  const pattern = new RegExp(
    `${label.source}[^\\d]{0,20}(\\d{1,2}[-/.]\\d{1,2}[-/.]\\d{2,4}|\\d{4}-\\d{2}-\\d{2})`,
    label.flags.includes('i') ? 'i' : '',
  );
  const match = pattern.exec(text);
  if (!match?.[1]) return undefined;
  try {
    return parseStatementDate(match[1], { order }).date;
  } catch {
    return undefined;
  }
}

/**
 * One cell of the first data row whose text matches `label`, anywhere in the
 * row — the row itself, not a preamble scan. `SALDO INICIAL`/`SALDO FINAL`
 * are real rows with a real `Saldo (PESOS)` cell in the same column every
 * movement uses; reading *that* cell is what a declared balance should mean
 * for a layout whose preamble has no comparable single figure — see
 * `readDeclaredBalancesFromAnchorRows`.
 */
function findAnchorRowCell(
  sheet: Sheet,
  map: ColumnMap,
  firstDataRow: number,
  label: RegExp,
  role: ColumnRole,
): string | undefined {
  for (const row of sheet.rows.slice(firstDataRow) as string[][]) {
    if (!row.some((raw) => label.test(raw.trim()))) continue;
    const raw = cell(row, map, role);
    if (raw !== '') return raw;
  }
  return undefined;
}

/**
 * `SALDO INICIAL`/`SALDO FINAL`'s own `Saldo (PESOS)` cell, as the declared
 * opening/closing balance — instead of `readDeclaredBalances`'s preamble
 * text scan.
 *
 * That scan flattens the whole preamble with `row.join(' ')` and looks for
 * "the first number after the word SALDO", which is fine for a preamble that
 * is prose but wrong for one that is itself tabular: Banco de Chile's prints
 * a label row like `Saldo Contable | Retenciones 24 Hrs. | Retenciones 48
 * Hrs.` above its values, and flattening loses which column is which — the
 * "first number after SALDO CONTABLE" becomes the `24` sitting in the next
 * label over, never the actual balance one row below it. A profile with
 * `periodFromBalanceRows` already has a cell that cannot be confused with a
 * neighbouring label: the balance column of a row the layout guarantees
 * exists.
 */
function readDeclaredBalancesFromAnchorRows(
  sheet: Sheet,
  map: ColumnMap,
  firstDataRow: number,
  anchors: NonNullable<StatementProfile['periodFromBalanceRows']>,
  currency: string,
  format: StatementProfile['numberFormat'],
): StatementBalances {
  const out: StatementBalances = {};
  const openingRaw = findAnchorRowCell(sheet, map, firstDataRow, anchors.openingLabel, ColumnRole.balance);
  const closingRaw = findAnchorRowCell(sheet, map, firstDataRow, anchors.closingLabel, ColumnRole.balance);
  if (openingRaw) {
    try {
      out.opening = { amount: parseAmount(openingRaw, { currency, format }).money, source: 'declared' };
    } catch {
      // Fails closed by omission — `readBalances` still has `deriveBalances`.
    }
  }
  if (closingRaw) {
    try {
      out.closing = { amount: parseAmount(closingRaw, { currency, format }).money, source: 'declared' };
    } catch {
      // Same.
    }
  }
  return out;
}

/** `dd/mm`, no year — the raw shape `dateOmitsYear` rows carry. */
function parseDayMonthCell(
  raw: string,
  order: StatementProfile['dateOrder'],
): { day: number; month: number } | undefined {
  const match = raw.trim().match(/^(\d{1,2})[-/.](\d{1,2})$/);
  if (!match) return undefined;
  const { day, month } = splitDayMonth(Number(match[1]), Number(match[2]), order);
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  return { day, month };
}

function resolveSpreadsheetColumnNumberFormats(
  profile: StatementProfile,
  sheet: Sheet,
  map: ColumnMap,
  firstDataRow: number,
): Partial<Record<ColumnRole, StatementProfile['numberFormat']>> | undefined {
  const configured = profile.spreadsheetColumnNumberFormats;
  const evidence = profile.spreadsheetColumnNumberFormatEvidence;
  if (!configured || !evidence) return undefined;

  const resolved: Partial<Record<ColumnRole, StatementProfile['numberFormat']>> = {};
  for (const role of Object.values(ColumnRole)) {
    const format = configured[role];
    const pattern = evidence[role];
    if (!format || !pattern || map[role] === undefined) continue;

    for (const row of sheet.rows.slice(firstDataRow)) {
      pattern.lastIndex = 0;
      const matches = pattern.test(cell(row, map, role));
      pattern.lastIndex = 0;
      if (matches) {
        resolved[role] = format;
        break;
      }
    }
  }
  return Object.keys(resolved).length > 0 ? resolved : undefined;
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
  checkBalanceTotal(statement, issues);

  for (const transaction of transactions) {
    for (const warning of transaction.warnings) {
      issues.push({
        level:
          warning.code === 'ambiguous-amount-format' && profile.ambiguousAmountCheck === 'authoritative'
            ? 'error'
            : 'warning',
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
  const order = ledgerOrder(statement.transactions);
  if (!order) {
    const singleDay =
      statement.transactions.length > 1 &&
      statement.transactions.every(
        (transaction) => transaction.date === statement.transactions[0]?.date,
      );
    issues.push(
      singleDay
        ? {
            level: 'info',
            code: 'balance-order-ambiguous',
            message:
              'Todos los movimientos son del mismo día, así que el archivo no dice en qué orden ocurrieron. No se comprobó el saldo ni se dedujeron los saldos inicial y final.',
          }
        : {
            level: 'info',
            code: 'balance-walk-skipped',
            message:
              'Las filas no vienen ordenadas por fecha, así que no se pudo comprobar que el saldo declarado cuadre con los montos.',
          },
    );
    return undefined;
  }
  const ordered = order.rows;

  // Seeded only with a *declared* opening. A derived one is computed from the
  // first row's own balance and amount, so checking that row against it would
  // be checking a number against itself — a step that always passes, added to
  // the denominator of the mismatch ratio, quietly making a bad statement look
  // proportionally better.
  let previousBalance: Money | undefined =
    statement.openingBalance?.source === 'declared' &&
    statement.openingBalance.amount.currency === statement.account.currency
      ? statement.openingBalance.amount
      : undefined;
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
 * Opening + every movement === closing, in one comparison.
 *
 * The balance walk can only check the steps the file prints a balance for, and
 * a cartola with no balance column at all gets no coherence check whatsoever —
 * which is most of what a bank hands you when you ask for a CSV. Two declared
 * figures at the ends check every amount in between, including the sign of
 * each one, without needing a single intermediate balance.
 *
 * Requires at least one end to be declared. With both ends derived this is the
 * balance walk restated: the opening is the first row's balance minus its
 * amount and the closing is the last row's balance, so the comparison reduces
 * to the same arithmetic `checkBalanceWalk` already reported on, and firing
 * twice for one fault reads as two faults.
 *
 * Skipped rows are safe to leave out — a row carrying money is never skipped —
 * but a *failed* row is a missing amount, so the sum would come up short for a
 * reason this issue does not describe.
 */
function checkBalanceTotal(statement: ParsedStatement, issues: StatementIssue[]): void {
  const opening = statement.openingBalance;
  const closing = statement.closingBalance;
  if (!opening || !closing) return;
  if (opening.source === 'derived' && closing.source === 'derived') return;
  if (statement.rowStats.failed > 0) return;

  const currency = statement.account.currency;
  if (opening.amount.currency !== currency || closing.amount.currency !== currency) return;

  const movements = sum(
    statement.transactions.map((transaction) => transaction.amount),
    currency,
  );
  if (compare(add(opening.amount, movements), closing.amount) === 0) return;

  issues.push({
    level: 'warning',
    code: 'balance-total-mismatch',
    message:
      'El saldo inicial más los movimientos no da el saldo final que declara la cartola. Falta algún movimiento, sobra alguno, o el signo de alguno está al revés.',
  });
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
interface LedgerOrder {
  rows: readonly NormalizedTransaction[];
  /**
   * How the file was laid out. `ascending` means the rows are already in
   * ledger order, including within a day; `descending` means they were
   * reversed to get here, and the within-day order is this code's guess rather
   * than the file's statement.
   */
  direction: 'ascending' | 'descending';
}

/**
 * The rows in ledger order, and how that was decided.
 *
 * Two dates that only ever move one way settle it. What does not settle it is
 * dates that never move at all: a statement covering a single day satisfies
 * *both* tests, and the old code answered "ascending" because it asked that
 * question first. For a bank that exports newest-first — Banco de Chile and
 * Santander by default — that silently reads the day backwards, and every
 * balance derived from its ends is the wrong end.
 *
 * With more than one row and no date ever moving, the file has not said which
 * way it runs, and no amount of looking at it will. It declines.
 */
function ledgerOrder(
  transactions: readonly NormalizedTransaction[],
): LedgerOrder | undefined {
  const dates = transactions.map((transaction) => transaction.date);
  let ascending = true;
  let descending = true;
  let moved = false;
  for (let i = 1; i < dates.length; i += 1) {
    const previous = dates[i - 1] as string;
    const current = dates[i] as string;
    if (current < previous) ascending = false;
    if (current > previous) descending = false;
    if (current !== previous) moved = true;
  }

  if (transactions.length > 1 && !moved) return undefined;
  if (ascending) return { rows: transactions, direction: 'ascending' };
  if (descending) return { rows: [...transactions].reverse(), direction: 'descending' };
  return undefined;
}

export { DETECTION_FLOOR };
