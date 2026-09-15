import { abs, add, compare, negate, parseAmount, MoneyError, type Money } from '../core/money';
import { Confidence, TransactionKind } from '../core/model/kinds';
import type { NormalizedTransaction } from '../core/model/transaction';
import {
  DETECTION_FLOOR,
  StatementProduct,
  type ParsedStatement,
  type ValidationResult,
} from '../core/model/statement';
import { ColumnRole, detectHeader, mapColumns, normalizeHeader } from '../core/parsing/columns';
import { describeColumnShape, type ColumnShape } from '../core/parsing/column-shape';
import type { StatementProfile } from '../core/parsing/profile';
import { readSpreadsheetCellFormats } from '../core/parsing/spreadsheet-cell-facts';
import type { NativeCellType, NumberFormatShape } from '../core/parsing/spreadsheet-format';
import type { Sheet } from '../core/parsing/tabular';
import { pickDataSheet } from '../core/parsing/workbook';
import { redactSensitive } from '../core/privacy';
import { normalizeDescription } from '../core/text';
import {
  CARD_REVERSAL_MARKERS,
  CARD_SIDE_PAYMENT_MARKERS,
  CASH_SIDE_CARD_PAYMENT_MARKERS,
} from '../core/classify/card-semantics';
import {
  cardFactLabel,
  factPresence,
  type FactPresence,
} from '../core/model/statement-facts';
import { detectAll, getParser } from '../core/providers/registry';
import type { ParserInput, StatementParser } from '../core/providers/parser';
import { mergeSynonyms } from '../core/providers/profile-parser';

/**
 * The report that turns one real cartola into a profile correction.
 *
 * Every bank profile in this project was written against format documentation.
 * The first real export will disagree with one of them, and the useful question
 * is *how*: which column went unmapped, which rows failed, whether the balance
 * column walks, whether the decimal separator was read the way the bank meant
 * it. This produces exactly those answers.
 *
 * What it must never produce is the statement. A calibration report is written
 * down, pasted into an issue, read over someone's shoulder — so it carries
 * counts, codes, normalized column roles and classifications, and not one movement.
 * Concretely, and enforced by tests:
 *
 * - no description, merchant or glosa, in any form;
 * - no amount, not even a total — only how amounts were *shaped* (scale, sign,
 *   and for a failed balance step the class of the discrepancy, never its
 *   size);
 * - no account, card or national id number, and no holder name;
 * - no file name or stable file identifier — only an allowlisted extension and size;
 * - no raw column heading: an unusual heading can itself contain personal data.
 */

export interface CalibrationReport {
  file: FileFacts;
  detection: DetectionFacts;
  header: HeaderFacts;
  rows: RowFacts;
  amounts: AmountFacts;
  dates: DateFacts;
  balances: BalanceFacts;
  classification: ClassificationFacts;
  installments: InstallmentFacts;
  /**
   * Which statement facts the profile found, on a card statement.
   *
   * Presence only, never a value: this report gets pasted into an issue, and a
   * pago mínimo is a figure about a person's debt. Absent entirely when the
   * statement is not a card — a cuenta corriente has none of these.
   */
  cardFacts?: FactPresence[];
  /**
   * The mapped monetary columns' own native storage shape, spreadsheets only.
   *
   * Never the value, and never the decimal separator read out of the cell's
   * *text* — that lexical reading is exactly what `core/money.ts#splitDecimal`
   * already cannot disambiguate for some real formats. This is the cell's own
   * SheetJS type and Excel number-format code, a genuinely independent fact.
   * Absent entirely for a CSV/TXT source, or when no format evidence could be
   * read at all.
   */
  spreadsheetFormats?: Partial<Record<string, SpreadsheetColumnFormatFacts>>;
  /** Issue codes the parser raised, with how many times each. */
  issues: Array<{ code: string; level: string; count: number }>;
  /**
   * `row-parse-failed` counted by *why*, not just that it happened.
   *
   * `describeRowFailure` (core/parsing/rows.ts) already reduces every failure
   * to a fixed, PII-free template — the cell itself never reaches it. Grouping
   * by that template turns "20 rows failed" into "20 rows had no readable
   * amount column", which is the difference between a profile bug and a wrong
   * bank guess.
   */
  rowFailureReasons: Array<{ reason: string; count: number }>;
  /**
   * How the general amount column relates to the labelled instalment column,
   * on rows where both are present.
   *
   * Never the values, only whether they agree. The question this answers is
   * exactly the ambiguity `banco-falabella.cmr` is marked `pending-real-sample`
   * over (see its `validationNotes`), and it can be answered from a
   * relationship between two columns without ever reading either one.
   */
  amountRelationship?: AmountRelationshipFacts;
  /**
   * Candidate vocabulary hits among rows the classifier left `unknown`.
   *
   * Every marker here is either an existing production list from
   * `core/classify/card-semantics` (to show *none* of them matched, which is
   * exactly why the row is unknown) or a plausible addition proposed for
   * calibration, never yet compiled into a classifier. A boolean per
   * category, counted — never the row's own text.
   */
  unknownVocabulary: VocabularyFacts[];
}

export interface AmountRelationshipFacts {
  /** Both columns parsed to the same magnitude. */
  equal: number;
  /** Both present, magnitudes differ. */
  different: number;
  /** One or both columns were empty or unparseable. */
  oneMissing: number;
}

export interface VocabularyFacts {
  category: string;
  rows: number;
}

export interface FileFacts {
  /** Extension only. The name can carry a RUT — see `core/privacy`. */
  extension: string;
  bytes: number;
  sheets: number;
  /** Rows in the sheet the parser chose, header and preamble included. */
  sheetRows: number;
}

export interface DetectionFacts {
  /** Parser this report was produced with. */
  parser: string;
  institution: string;
  score: number;
  /** Reasons the detector gave. Format vocabulary, not statement content. */
  reasons: string[];
  /**
   * Every other parser that scored above the floor, best first.
   *
   * A sample that two profiles both claim is a profile problem in itself, and
   * it does not show up in any single parser's own output.
   */
  runnersUp: Array<{ parser: string; score: number }>;
}

export interface HeaderFacts {
  /** Row index the header was found on, or -1. */
  row: number;
  /** Roles the profile resolved, in column order. */
  mapped: Array<{ role: string; column: number }>;
  /**
   * Positions the profile did not map.
   *
   * The operator inspects that position in the private file locally. Raw
   * headings cannot enter the pasteable report because they may contain PII.
   * `shape` is the one thing the report can add about *what's there*: a
   * digit-run bucket, never a digit — see `core/parsing/column-shape.ts`.
   */
  unmapped: Array<{ column: number; shape: ColumnShape }>;
  /**
   * Whether the header row exactly matches a named, hard-coded candidate
   * layout signature — never the header text itself.
   *
   * A candidate is proposed from something other than the file (a format
   * spec, a description of the export) and this only ever answers "yes" or
   * "no" to "is that guess right", the same shape as the vocabulary
   * candidates in `unknownVocabulary`. It exists to turn a hypothesis about
   * an exact header into evidence a `recognizedLayoutSignatures` entry can
   * be built from, without the header ever appearing in the report.
   */
  signatureCandidates: Array<{ name: string; matched: boolean }>;
}

export interface RowFacts {
  data: number;
  mapped: number;
  skipped: number;
  failed: number;
  /** Source line numbers of the rows that failed, for a targeted look. */
  failedLines: number[];
}

export interface AmountFacts {
  /**
   * How many amounts came out at each decimal scale.
   *
   * A CLP cartola should be almost entirely scale 0. A cloud of scale 2 says
   * the thousands separator was read as a decimal point — the single most
   * expensive misread this pipeline can make, and invisible in a row count.
   */
  byScale: Array<{ scale: number; rows: number }>;
  inflows: number;
  outflows: number;
  zero: number;
}

export interface DateFacts {
  /** `ascending`, `descending`, `single-day` or `mixed`. */
  order: string;
  /** Distinct dates seen. `1` with several rows is why order cannot be read. */
  distinct: number;
  /**
   * Rows whose date or amount could be read more than one way.
   *
   * `03/04/2026` is two dates and `1.234` is two amounts, and which one the
   * parser chose came from the profile, not from the file. On a real sample
   * this count is what says whether that guess is load-bearing.
   */
  ambiguousRows: number;
}

export interface BalanceFacts {
  rowsWithBalance: number;
  /** Steps the walk could compare. */
  steps: number;
  mismatches: number;
  /**
   * What the failing steps look like, which is what a fix is made of.
   *
   * `sign` means the amounts carry the opposite sign to the balance column;
   * `scale-100` means one side is off by a factor of a hundred. Neither is an
   * amount.
   */
  mismatchKinds: Array<{ kind: BalanceMismatchKind; count: number }>;
  opening?: 'declared' | 'derived';
  closing?: 'declared' | 'derived';
}

export type BalanceMismatchKind = 'sign' | 'scale-100' | 'scale-1000' | 'other';

export interface ClassificationFacts {
  /** How many rows landed on each kind. */
  byKind: Array<{ kind: string; rows: number }>;
  /** Rows nothing could classify. The queue a profile is judged by. */
  unknown: number;
  /** Rows classified only by the product default, not by their wording. */
  suggested: number;
  /** Rows that look like a cuota where the file does not say the plan size. */
  ambiguousInstallments: number;
}

/**
 * Cuotas evidence, aggregated. Counters only — never the installment number,
 * the total, or the text `detectInstallment` read them from: `2 de 6` on a
 * card is a fact about a person's debt, exactly like an amount.
 */
export interface InstallmentFacts {
  /** Rows whose Cuotas cell (whatever the profile calls it) is non-empty. */
  cellsPresent: number;
  cellsEmpty: number;
  /** Rows `detectInstallment` turned into a plan, from the cell or the glosa. */
  parsed: number;
  /** Of `parsed`, how many came from an explicit `CUOTA` marker or the dedicated column. */
  confirmed: number;
  /** Of `parsed`, how many came from a bare `n/m` with no keyword to confirm it. */
  suggested: number;
  /** A non-empty cell that `detectInstallment` could not turn into a plan. */
  unparsed: number;
  /** Rows carrying the `ambiguous-installment` warning (an uncertain reading). */
  ambiguousPlan: number;
  /** Rows carrying `ambiguous-installment-amount` (plan certain, amount role unclear). */
  ambiguousAmount: number;
  /**
   * Of `unparsed`, how many are a bare integer — not an `n de m` pair.
   *
   * `detectInstallment` only reads a `current/total` pair; a column that
   * prints a single remaining-cuotas count (never a plan) is invisible to it
   * and lands entirely in `unparsed` with no further signal. This is the one
   * count that separates "the column uses a format nothing reads yet" from
   * "the column is genuinely unparseable" — never the count's own value,
   * only whether it read as zero (no plan open) or a positive remainder.
   */
  bareIntegerZero: number;
  bareIntegerPositive: number;
}

/**
 * A monetary column's spreadsheet cell shape, aggregated over its data rows.
 *
 * `nativeType`/`numberFormatShape` are `'mixed'` when the column's own cells
 * disagree — a fact worth reporting, not an average to paper over. Blank
 * cells are ignored, same as `describeColumnShape`.
 */
export interface SpreadsheetColumnFormatFacts {
  container: 'xls' | 'xlsx';
  nativeType: NativeCellType | 'mixed';
  numberFormatShape: NumberFormatShape | 'mixed';
}

const MONETARY_ROLES: readonly ColumnRole[] = [
  ColumnRole.amount,
  ColumnRole.debit,
  ColumnRole.credit,
  ColumnRole.balance,
];

export interface CalibrationInput {
  /** Bytes of the private sample. Never retained past this call. */
  bytes: Uint8Array;
  fileName: string;
  fileHash: string;
  sheets: Sheet[];
  /** Force a parser instead of using the best detection. */
  parserId?: string;
  accountId: string;
}

export function calibrate(input: CalibrationInput): CalibrationReport {
  const parserInput: ParserInput = {
    file: { name: input.fileName, bytes: input.bytes },
    sheets: input.sheets,
    fileHash: input.fileHash,
    accountId: input.accountId,
  };

  const detections = detectAll(parserInput);
  const chosenId = input.parserId ?? detections[0]?.parser;
  const parser = chosenId ? getParser(chosenId) : undefined;
  if (!parser) {
    throw new Error(
      'Ningún perfil reconoció el archivo. Ejecútalo de nuevo con --parser <id> para ver por qué falla ese perfil en concreto.',
    );
  }

  const statement = parser.parse(parserInput);
  const validation = parser.validate(statement);
  // The exact same sheet production picks: `pickDataSheet` is what
  // `parseWithProfile` (core/providers/profile-parser.ts) calls before ever
  // reading a header. `input.sheets[0]` used to be read here instead, so a
  // workbook with a cover sheet before the movements sheet reported the cover
  // page's (empty) header and row counts while the parser above had already
  // read the real data from a different sheet entirely.
  const sheet = pickDataSheet(input.sheets);

  return {
    file: fileFacts(input, sheet),
    detection: detectionFacts(parser.id, parser.institution, detections),
    header: headerFacts(sheet, parser.id),
    rows: rowFacts(statement),
    amounts: amountFacts(statement.transactions),
    dates: dateFacts(statement.transactions),
    balances: balanceFacts(statement),
    classification: classificationFacts(statement.transactions),
    installments: installmentFacts(statement.transactions),
    ...(isCardStatement(statement) ? { cardFacts: factPresence(statement.cardFacts ?? {}) } : {}),
    ...(() => {
      const facts = spreadsheetFormatFacts(input, sheet, parser.id);
      return facts ? { spreadsheetFormats: facts } : {};
    })(),
    issues: issueFacts(validation),
    rowFailureReasons: rowFailureReasonFacts(statement),
    ...(() => {
      const facts = amountRelationshipFacts(statement.transactions, parser.profile);
      return facts ? { amountRelationship: facts } : {};
    })(),
    unknownVocabulary: unknownVocabularyFacts(statement.transactions),
  };
}

/**
 * Compares the `amount` and `installmentAmount` columns row by row, on
 * whichever rows carry both. Absent entirely when the profile has neither
 * column mapped, or when no row carries both filled in — there is nothing to
 * relate.
 */
function amountRelationshipFacts(
  transactions: readonly NormalizedTransaction[],
  profile: StatementProfile,
): AmountRelationshipFacts | undefined {
  let equal = 0;
  let different = 0;
  let oneMissing = 0;
  let sawEitherColumn = false;

  for (const transaction of transactions) {
    const amountText = transaction.rawMetadata[ColumnRole.amount];
    const installmentText = transaction.rawMetadata[ColumnRole.installmentAmount];
    if (amountText === undefined && installmentText === undefined) continue;
    sawEitherColumn = true;

    const a = tryParseAmount(amountText, profile);
    const b = tryParseAmount(installmentText, profile);
    if (!a || !b) {
      oneMissing += 1;
      continue;
    }
    if (compare(abs(a), abs(b)) === 0) equal += 1;
    else different += 1;
  }

  return sawEitherColumn ? { equal, different, oneMissing } : undefined;
}

function tryParseAmount(text: string | undefined, profile: StatementProfile): Money | undefined {
  if (text === undefined || text.trim() === '') return undefined;
  try {
    return parseAmount(text, {
      currency: profile.defaultCurrency,
      format: profile.numberFormat,
      allowDebitCreditSuffix: true,
    }).money;
  } catch (error) {
    if (error instanceof MoneyError) return undefined;
    throw error;
  }
}

/**
 * Candidate description vocabulary, probed only against rows the classifier
 * already gave up on (`TransactionKind.unknown`).
 *
 * The three production lists are included so a calibration run can show that
 * *none* of them matched — the reason the row is unknown in the first place.
 * The rest are calibration-only candidates: plausible Chilean card wording
 * that has never been confirmed against a real statement, proposed here so a
 * hit can promote it to a production marker with evidence behind it, never
 * as a guess compiled straight into the classifier.
 */
const VOCABULARY_CANDIDATES: Readonly<Record<string, readonly string[]>> = {
  'production: cash-side card payment': CASH_SIDE_CARD_PAYMENT_MARKERS,
  'production: card-side payment': CARD_SIDE_PAYMENT_MARKERS,
  'production: reversal': CARD_REVERSAL_MARKERS,
  'candidate: issuer service charge': [
    'SERVICIO DE ADMINISTRACION',
    'COMISION ADMINISTRACION',
    'ADMINISTRACION TARJETA',
    'MANTENCION TARJETA',
    'CARGO MANTENCION',
  ],
  'candidate: payment channel': [
    'PAGO SUCURSAL',
    'PAGO CAJA',
    'PAGO PORTAL',
    'PAGO WEB',
    'PAGO SERVIPAG',
    'PAGO ONLINE',
    'PAGO APP',
  ],
  'candidate: international marker': ['INTERNACIONAL', 'EXTRANJERO', 'EXTERIOR'],
};

/**
 * Per-marker, not per-category: knowing *one* candidate in a list of nine
 * matched every unknown row does not say which phrase to add to production.
 * A marker string is fixed reference vocabulary the tool ships with — not
 * text read out of the private file — so naming it in the report is no
 * different from naming the category it came from.
 */
function unknownVocabularyFacts(transactions: readonly NormalizedTransaction[]): VocabularyFacts[] {
  const unknown = transactions.filter((transaction) => transaction.kind === TransactionKind.unknown);
  const facts: VocabularyFacts[] = [];
  for (const [category, markers] of Object.entries(VOCABULARY_CANDIDATES)) {
    for (const marker of markers) {
      const rows = unknown.filter((transaction) => mentionsAny(transaction.description, [marker])).length;
      if (rows > 0) facts.push({ category: `${category}: ${marker}`, rows });
    }
  }
  // Categories with zero hits still matter — they are why calibration was
  // needed — so report one summary line per category even when every one of
  // its markers scored zero.
  for (const category of Object.keys(VOCABULARY_CANDIDATES)) {
    if (!facts.some((fact) => fact.category.startsWith(`${category}:`))) {
      facts.push({ category, rows: 0 });
    }
  }
  return facts;
}

function mentionsAny(description: string, markers: readonly string[]): boolean {
  const text = normalizeDescription(description ?? '');
  return markers.some((marker) => text.includes(normalizeDescription(marker)));
}

/**
 * Aggregates each mapped monetary column's own cell shape, spreadsheets only.
 *
 * Re-derives the header row and column map the same way `parser.parse` does
 * (`detectHeader` + `mergeSynonyms`, the exact function the real profile
 * parser uses) so a column position can never drift between what the parser
 * actually read and what this reports on.
 */
function spreadsheetFormatFacts(
  input: CalibrationInput,
  sheet: Sheet | undefined,
  parserId: string,
): Partial<Record<string, SpreadsheetColumnFormatFacts>> | undefined {
  if (!sheet) return undefined;
  const profile = getParser(parserId)?.profile;
  if (!profile) return undefined;

  const cellFormatSheets = readSpreadsheetCellFormats({ name: input.fileName, bytes: input.bytes });
  const formatSheet = cellFormatSheets?.find((candidate) => candidate.name === sheet.name);
  if (!formatSheet) return undefined;

  const header = detectHeader(sheet);
  if (header.headerRow < 0) return undefined;
  const generic = mapColumns((sheet.rows[header.headerRow] ?? []).map((cell) => cell.trim()));
  const map = mergeSynonyms(sheet, header.headerRow, profile, generic);

  const result: Partial<Record<string, SpreadsheetColumnFormatFacts>> = {};
  for (const role of MONETARY_ROLES) {
    const column = map[role];
    if (column === undefined) continue;

    const nativeTypes = new Set<NativeCellType>();
    const shapes = new Set<NumberFormatShape>();
    for (let r = header.firstDataRow; r < sheet.rows.length; r += 1) {
      const text = (sheet.rows[r]?.[column] ?? '').trim();
      if (text === '') continue;
      const fact = formatSheet.cells[r]?.[column];
      if (!fact) continue;
      nativeTypes.add(fact.nativeType);
      shapes.add(fact.numberFormatShape);
    }
    if (nativeTypes.size === 0) continue;

    result[role] = {
      container: formatSheet.container,
      nativeType: nativeTypes.size === 1 ? ([...nativeTypes][0] as NativeCellType) : 'mixed',
      numberFormatShape: shapes.size === 1 ? ([...shapes][0] as NumberFormatShape) : 'mixed',
    };
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/** Whether the parsed statement is one that can carry card facts at all. */
function isCardStatement(statement: ParsedStatement): boolean {
  return (
    statement.account.product === StatementProduct.credit_card ||
    statement.account.product === StatementProduct.credit_line
  );
}

function fileFacts(input: CalibrationInput, sheet: Sheet | undefined): FileFacts {
  const dot = input.fileName.lastIndexOf('.');
  const candidate = dot > 0 ? input.fileName.slice(dot).toLowerCase() : '';
  return {
    extension: ['.csv', '.xls', '.xlsx'].includes(candidate) ? candidate : '(no reconocida)',
    bytes: input.bytes.length,
    sheets: input.sheets.length,
    sheetRows: sheet?.rows.length ?? 0,
  };
}

function detectionFacts(
  parserId: string,
  institution: string,
  detections: readonly { parser: string; score: number; reasons: string[] }[],
): DetectionFacts {
  const own = detections.find((detection) => detection.parser === parserId);
  return {
    parser: parserId,
    institution,
    score: own?.score ?? 0,
    reasons: (own?.reasons ?? []).map(redactSensitive),
    runnersUp: detections
      .filter((detection) => detection.parser !== parserId && detection.score >= DETECTION_FLOOR)
      .map((detection) => ({ parser: detection.parser, score: detection.score })),
  };
}

function headerFacts(sheet: Sheet | undefined, parserId: string): HeaderFacts {
  const profile = getParser(parserId)?.profile;
  if (!sheet || !profile) return { row: -1, mapped: [], unmapped: [], signatureCandidates: [] };

  const header = detectHeader(sheet);
  if (header.headerRow < 0) return { row: -1, mapped: [], unmapped: [], signatureCandidates: [] };

  const cells = (sheet.rows[header.headerRow] ?? []).map((cell) => cell.trim());
  // The generic map, not the profile's merged one. A heading this shows as
  // unmapped is precisely the one the profile needs a synonym for, and running
  // the profile's own synonyms here would hide the columns it already knows
  // about — which is the opposite of what a calibration is for.
  const map = mapColumns(cells);
  const mappedColumns = new Map<number, string>();
  for (const [role, column] of Object.entries(map)) {
    if (typeof column === 'number') mappedColumns.set(column, role);
  }

  const mapped: HeaderFacts['mapped'] = [];
  const unmapped: HeaderFacts['unmapped'] = [];
  cells.forEach((heading, column) => {
    if (heading === '') return;
    const role = mappedColumns.get(column);
    if (role) mapped.push({ role, column });
    else unmapped.push({ column, shape: columnShapeAt(sheet, header.firstDataRow, column) });
  });

  const normalizedCells = new Set(cells.filter((c) => c !== '').map(normalizeHeader));
  const signatureCandidates = (LAYOUT_SIGNATURE_CANDIDATES[parserId] ?? []).map((candidate) => ({
    name: candidate.name,
    matched: candidate.headers.every((required) => normalizedCells.has(normalizeHeader(required))),
  }));

  return { row: header.headerRow, mapped, unmapped, signatureCandidates };
}

/**
 * Named layout-signature hypotheses, proposed from outside the file (a
 * description of an export, never a read of one), pending confirmation
 * against a real statement. A match here is the evidence a
 * `StatementProfile.recognizedLayoutSignatures` entry can be built from; the
 * header text that would confirm or refute it never appears in the report,
 * only whether the guess was right.
 */
const LAYOUT_SIGNATURE_CANDIDATES: Readonly<Record<string, ReadonlyArray<{ name: string; headers: readonly string[] }>>> = {
  'banco-falabella.cmr': [
    {
      name: 'cmr-movimientos-facturados-v1',
      headers: ['FECHA', 'DESCRIPCION', 'TITULAR ADICIONAL', 'MONTO', 'CUOTAS PENDIENTES', 'VALOR CUOTA'],
    },
  ],
};

/** The shape of one column's own values, read straight from the sheet. */
function columnShapeAt(sheet: Sheet, firstDataRow: number, column: number): ColumnShape {
  const values: string[] = [];
  for (let i = firstDataRow; i < sheet.rows.length; i += 1) {
    values.push(sheet.rows[i]?.[column] ?? '');
  }
  return describeColumnShape(values);
}

function rowFacts(statement: ParsedStatement): RowFacts {
  const stats = statement.rowStats;
  return {
    data: stats.dataRows,
    mapped: stats.mapped,
    skipped: stats.skipped,
    failed: stats.failed,
    failedLines: statement.issues
      .filter((issue) => issue.level === 'error' && issue.line !== undefined)
      .map((issue) => issue.line as number)
      .sort((a, b) => a - b),
  };
}

function amountFacts(transactions: readonly NormalizedTransaction[]): AmountFacts {
  const byScale = new Map<number, number>();
  let inflows = 0;
  let outflows = 0;
  let zero = 0;

  for (const transaction of transactions) {
    byScale.set(transaction.amount.scale, (byScale.get(transaction.amount.scale) ?? 0) + 1);
    if (transaction.amount.minor > 0) inflows += 1;
    else if (transaction.amount.minor < 0) outflows += 1;
    else zero += 1;
  }

  return {
    byScale: [...byScale.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([scale, rows]) => ({ scale, rows })),
    inflows,
    outflows,
    zero,
  };
}

function dateFacts(transactions: readonly NormalizedTransaction[]): DateFacts {
  const dates = transactions.map((transaction) => transaction.date);
  const distinct = new Set(dates).size;

  let ascending = true;
  let descending = true;
  for (let i = 1; i < dates.length; i += 1) {
    if ((dates[i] as string) < (dates[i - 1] as string)) ascending = false;
    if ((dates[i] as string) > (dates[i - 1] as string)) descending = false;
  }

  const order =
    dates.length <= 1
      ? 'single-row'
      : distinct === 1
        ? 'single-day'
        : ascending
          ? 'ascending'
          : descending
            ? 'descending'
            : 'mixed';

  return {
    order,
    distinct,
    ambiguousRows: transactions.filter((transaction) =>
      transaction.warnings.some(
        (warning) =>
          warning.code === 'ambiguous-date-format' || warning.code === 'ambiguous-amount-format',
      ),
    ).length,
  };
}

function balanceFacts(statement: ParsedStatement): BalanceFacts {
  const withBalance = statement.transactions.filter(
    (transaction) => transaction.balanceAfter !== undefined,
  );

  const kinds = new Map<BalanceMismatchKind, number>();
  let steps = 0;
  let mismatches = 0;

  // Walked here rather than read off the validation summary because the
  // summary answers "did it reconcile"; a calibration needs "and in what way
  // did it not". The order is the file's own: a report that silently sorted
  // would hide the very thing it is meant to expose.
  //
  // `pending` accumulates every transaction since the last balance-bearing
  // one — same as `checkBalanceWalk` (core/providers/profile-parser.ts).
  // Plenty of real cartolas print a balance only every few rows (Banco de
  // Chile cuenta corriente, calibrated 2026-09: roughly 8 of every 20+ mapped
  // rows), and comparing the declared jump against only the *last* row's own
  // amount flags every multi-row step as a mismatch whether or not the file
  // was read correctly.
  let previous: Money | undefined;
  let pending: Money | undefined;
  for (const transaction of statement.transactions) {
    pending = pending ? add(pending, transaction.amount) : transaction.amount;
    const balance = transaction.balanceAfter;
    if (!balance) continue;
    if (previous) {
      steps += 1;
      const expected = { ...balance, minor: balance.minor - previous.minor };
      if (compare(expected, pending) !== 0) {
        mismatches += 1;
        const kind = classifyMismatch(expected, pending);
        kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
      }
    }
    previous = balance;
    pending = undefined;
  }

  return {
    rowsWithBalance: withBalance.length,
    steps,
    mismatches,
    mismatchKinds: [...kinds.entries()].map(([kind, count]) => ({ kind, count })),
    ...(statement.openingBalance ? { opening: statement.openingBalance.source } : {}),
    ...(statement.closingBalance ? { closing: statement.closingBalance.source } : {}),
  };
}

/**
 * What shape a failing balance step has.
 *
 * The classes are the corrections a profile can actually receive: a sign
 * convention read backwards, or a decimal separator read as a thousands
 * separator. Reporting the *size* of the gap would be reporting an amount.
 */
function classifyMismatch(expected: Money, actual: Money): BalanceMismatchKind {
  if (actual.minor !== 0 && compare(expected, negate(actual)) === 0) return 'sign';
  const ratio = actual.minor === 0 ? 0 : Math.abs(expected.minor / actual.minor);
  if (near(ratio, 100) || near(ratio, 1 / 100)) return 'scale-100';
  if (near(ratio, 1000) || near(ratio, 1 / 1000)) return 'scale-1000';
  return 'other';
}

function near(value: number, target: number): boolean {
  return Math.abs(value - target) < target * 0.01;
}

function classificationFacts(
  transactions: readonly NormalizedTransaction[],
): ClassificationFacts {
  const byKind = new Map<string, number>();
  let suggested = 0;
  let ambiguousInstallments = 0;

  for (const transaction of transactions) {
    byKind.set(transaction.kind, (byKind.get(transaction.kind) ?? 0) + 1);
    if (transaction.kindConfidence === Confidence.suggested) suggested += 1;
    if (
      transaction.warnings.some((warning) => warning.code.startsWith('ambiguous-installment'))
    ) {
      ambiguousInstallments += 1;
    }
  }

  return {
    byKind: [...byKind.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([kind, rows]) => ({ kind, rows })),
    unknown: byKind.get(TransactionKind.unknown) ?? 0,
    suggested,
    ambiguousInstallments,
  };
}

function installmentFacts(transactions: readonly NormalizedTransaction[]): InstallmentFacts {
  let cellsPresent = 0;
  let cellsEmpty = 0;
  let parsed = 0;
  let confirmed = 0;
  let suggested = 0;
  let unparsed = 0;
  let ambiguousPlan = 0;
  let ambiguousAmount = 0;
  let bareIntegerZero = 0;
  let bareIntegerPositive = 0;

  for (const transaction of transactions) {
    const rawCell = transaction.rawMetadata[ColumnRole.installment];
    const cellPresent = rawCell !== undefined;
    if (cellPresent) cellsPresent += 1;
    else cellsEmpty += 1;

    if (transaction.installment) {
      parsed += 1;
      if (transaction.installment.confidence === Confidence.confirmed) confirmed += 1;
      if (transaction.installment.confidence === Confidence.suggested) suggested += 1;
    } else if (cellPresent) {
      unparsed += 1;
      if (rawCell !== undefined && /^\d{1,3}$/.test(rawCell.trim())) {
        if (Number(rawCell.trim()) === 0) bareIntegerZero += 1;
        else bareIntegerPositive += 1;
      }
    }

    for (const warning of transaction.warnings) {
      if (warning.code === 'ambiguous-installment') ambiguousPlan += 1;
      if (warning.code === 'ambiguous-installment-amount') ambiguousAmount += 1;
    }
  }

  return {
    cellsPresent,
    cellsEmpty,
    parsed,
    confirmed,
    suggested,
    unparsed,
    ambiguousPlan,
    ambiguousAmount,
    bareIntegerZero,
    bareIntegerPositive,
  };
}

function issueFacts(validation: ValidationResult): CalibrationReport['issues'] {
  const counts = new Map<string, { level: string; count: number }>();
  for (const issue of validation.issues) {
    const existing = counts.get(issue.code);
    if (existing) existing.count += 1;
    else counts.set(issue.code, { level: issue.level, count: 1 });
  }
  return [...counts.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .map(([code, { level, count }]) => ({ code, level, count }));
}

/** Strips the `Fila N: ` prefix `describeRowFailure` adds, keeping the template. */
const ROW_LINE_PREFIX = /^Fila \d+: /;

function rowFailureReasonFacts(statement: ParsedStatement): CalibrationReport['rowFailureReasons'] {
  const counts = new Map<string, number>();
  for (const issue of statement.issues) {
    if (issue.code !== 'row-parse-failed') continue;
    const reason = issue.message.replace(ROW_LINE_PREFIX, '');
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => ({ reason, count }));
}

/** The report as plain text, for pasting somewhere. Same content, no more. */
export function formatReport(report: CalibrationReport): string {
  const lines: string[] = [];
  const add = (label: string, value: string | number) => lines.push(`${label.padEnd(26)}${value}`);

  lines.push('── Archivo ───────────────────────────────────────────────');
  add('Extensión', report.file.extension);
  add('Tamaño', `${report.file.bytes} bytes`);
  add('Hojas', report.file.sheets);
  add('Filas en la hoja', report.file.sheetRows);

  lines.push('', '── Detección ─────────────────────────────────────────────');
  add('Perfil', report.detection.parser);
  add('Institución', report.detection.institution);
  add('Confianza', `${Math.round(report.detection.score * 100)}%`);
  for (const reason of report.detection.reasons) lines.push(`  · ${reason}`);
  if (report.detection.runnersUp.length > 0) {
    add(
      'Otros candidatos',
      report.detection.runnersUp
        .map((other) => `${other.parser} (${Math.round(other.score * 100)}%)`)
        .join(', '),
    );
  }

  lines.push('', '── Cabecera ──────────────────────────────────────────────');
  add('Fila', report.header.row);
  for (const column of report.header.mapped) {
    lines.push(`  [${column.column}] ${column.role}`);
  }
  if (report.header.unmapped.length > 0) {
    lines.push('  Sin mapear:');
    for (const column of report.header.unmapped) {
      lines.push(`  [${column.column}] rol no reconocido — forma: ${column.shape}`);
    }
  }
  for (const candidate of report.header.signatureCandidates) {
    lines.push(`  Firma candidata "${candidate.name}": ${candidate.matched ? 'coincide' : 'no coincide'}`);
  }

  lines.push('', '── Filas ─────────────────────────────────────────────────');
  add('De datos', report.rows.data);
  add('Mapeadas', report.rows.mapped);
  add('Omitidas', report.rows.skipped);
  add('Fallidas', report.rows.failed);
  if (report.rows.failedLines.length > 0) {
    add('Líneas fallidas', report.rows.failedLines.join(', '));
  }
  for (const reason of report.rowFailureReasons) {
    lines.push(`  · ${reason.reason}: ${reason.count}`);
  }

  lines.push('', '── Montos ────────────────────────────────────────────────');
  add(
    'Decimales',
    report.amounts.byScale.map((entry) => `${entry.rows} filas con ${entry.scale}`).join(' · '),
  );
  add('Entradas / salidas / cero', `${report.amounts.inflows} / ${report.amounts.outflows} / ${report.amounts.zero}`);

  if (report.spreadsheetFormats) {
    lines.push('', '── Formato nativo (planilla) ────────────────────────────');
    for (const [role, facts] of Object.entries(report.spreadsheetFormats)) {
      if (!facts) continue;
      lines.push(`  ${role} (${facts.container}): ${facts.nativeType} / ${facts.numberFormatShape}`);
    }
  }

  lines.push('', '── Fechas ────────────────────────────────────────────────');
  add('Orden', report.dates.order);
  add('Fechas distintas', report.dates.distinct);
  add('Filas ambiguas', report.dates.ambiguousRows);

  lines.push('', '── Saldos ────────────────────────────────────────────────');
  add('Filas con saldo', report.balances.rowsWithBalance);
  add('Pasos comprobados', report.balances.steps);
  add('Descuadres', report.balances.mismatches);
  for (const kind of report.balances.mismatchKinds) {
    lines.push(`  · ${kind.kind}: ${kind.count}`);
  }
  add('Saldo inicial', report.balances.opening ?? 'sin evidencia');
  add('Saldo final', report.balances.closing ?? 'sin evidencia');

  if (report.cardFacts) {
    lines.push('', '── Estado de cuenta ──────────────────────────────────────');
    // What the profile's labels found, and nothing about what they said. On a
    // profile with no real cartola behind it every line reads "no encontrado",
    // and that is the honest starting point: it turns the first real statement
    // into a list of labels to correct.
    for (const fact of report.cardFacts) {
      add(cardFactLabel(fact.key), fact.found ? `encontrado (${fact.source})` : 'no encontrado');
    }
  }

  lines.push('', '── Clasificación ─────────────────────────────────────────');
  for (const kind of report.classification.byKind) {
    lines.push(`  ${String(kind.rows).padStart(5)}  ${kind.kind}`);
  }
  add('Sin clasificar', report.classification.unknown);
  add('Sólo por producto', report.classification.suggested);
  add('Cuotas ambiguas', report.classification.ambiguousInstallments);

  lines.push('', '── Cuotas ────────────────────────────────────────────────');
  add('Celda presente / vacía', `${report.installments.cellsPresent} / ${report.installments.cellsEmpty}`);
  add('Plan reconocido', report.installments.parsed);
  add('  confirmado / sugerido', `${report.installments.confirmed} / ${report.installments.suggested}`);
  add('Celda presente sin plan', report.installments.unparsed);
  add('  entero simple en 0 / >0',
    `${report.installments.bareIntegerZero} / ${report.installments.bareIntegerPositive}`);
  add('Aviso: lectura incierta', report.installments.ambiguousPlan);
  add('Aviso: monto de cuota incierto', report.installments.ambiguousAmount);

  if (report.issues.length > 0) {
    lines.push('', '── Avisos ────────────────────────────────────────────────');
    for (const issue of report.issues) {
      lines.push(`  ${String(issue.count).padStart(5)}  [${issue.level}] ${issue.code}`);
    }
  }

  if (report.amountRelationship) {
    lines.push('', '── Monto vs. cuota ───────────────────────────────────────');
    add('Iguales / distintos / incompletos',
      `${report.amountRelationship.equal} / ${report.amountRelationship.different} / ${report.amountRelationship.oneMissing}`);
  }

  if (report.unknownVocabulary.some((entry) => entry.rows > 0) || report.classification.unknown > 0) {
    lines.push('', '── Vocabulario en filas sin clasificar ──────────────────');
    for (const entry of report.unknownVocabulary) {
      lines.push(`  ${String(entry.rows).padStart(5)}  ${entry.category}`);
    }
  }

  return lines.join('\n');
}

/**
 * Cross-statement comparison, entirely in memory.
 *
 * Two exports of the same product — two months, or a PDF and an XLSX of the
 * same cycle — can describe the same movement twice. The question a policy
 * decision needs answered is never "what do these movements say" but "how
 * many are the same one": matched, unmatched, and — for an open instalment
 * plan specifically — whether the remaining-cuotas count decreases the way a
 * continuing plan should and whether the date the row carries moves between
 * statements or stays fixed. The last of those is load-bearing for dedupe: a
 * fingerprint keyed on a date that does not advance between cycles would
 * treat the second cuota as a repeat of the first.
 *
 * The match key is the normalised description and the resolved amount —
 * never printed, only counted — so nothing in this report is a movement's
 * own text.
 */
export interface CompareInput {
  a: CalibrationInput;
  b: CalibrationInput;
}

export interface ComparisonReport {
  parserA: string;
  parserB: string;
  rowsA: number;
  rowsB: number;
  matched: number;
  onlyA: number;
  onlyB: number;
  /** Of matched pairs, how many carry the exact same `date` in both files. */
  sameDate: number;
  differentDate: number;
  installmentContinuity: {
    /** Matched pairs where either side's bare instalment cell is positive. */
    candidates: number;
    /** B's remaining count is exactly one less than A's — a plan advancing normally. */
    remainingDecreasedByOne: number;
    /** Present on both sides but not a clean one-step decrease — worth a manual look. */
    remainingOther: number;
    /** Of `candidates`, how many keep the exact same `date` across both files. */
    sameDate: number;
    differentDate: number;
  };
}

export function compareStatements(input: CompareInput): ComparisonReport {
  const { parser: parserA, statement: statementA } = parseForComparison(input.a);
  const { parser: parserB, statement: statementB } = parseForComparison(input.b);

  const poolB = new Map<string, NormalizedTransaction[]>();
  for (const transaction of statementB.transactions) {
    const key = matchKey(transaction);
    const bucket = poolB.get(key);
    if (bucket) bucket.push(transaction);
    else poolB.set(key, [transaction]);
  }

  let matched = 0;
  let onlyA = 0;
  let sameDate = 0;
  let differentDate = 0;
  let candidates = 0;
  let remainingDecreasedByOne = 0;
  let remainingOther = 0;
  let candidateSameDate = 0;
  let candidateDifferentDate = 0;

  for (const a of statementA.transactions) {
    const bucket = poolB.get(matchKey(a));
    const match = bucket?.shift();
    if (!match) {
      onlyA += 1;
      continue;
    }
    matched += 1;
    const isSameDate = a.date === match.date;
    if (isSameDate) sameDate += 1;
    else differentDate += 1;

    const bareA = bareInstallmentValue(a);
    const bareB = bareInstallmentValue(match);
    if ((bareA !== undefined && bareA > 0) || (bareB !== undefined && bareB > 0)) {
      candidates += 1;
      if (isSameDate) candidateSameDate += 1;
      else candidateDifferentDate += 1;
      if (bareA !== undefined && bareB !== undefined && bareB === bareA - 1) {
        remainingDecreasedByOne += 1;
      } else {
        remainingOther += 1;
      }
    }
  }
  const onlyB = [...poolB.values()].reduce((sum, bucket) => sum + bucket.length, 0);

  return {
    parserA: parserA.id,
    parserB: parserB.id,
    rowsA: statementA.transactions.length,
    rowsB: statementB.transactions.length,
    matched,
    onlyA,
    onlyB,
    sameDate,
    differentDate,
    installmentContinuity: {
      candidates,
      remainingDecreasedByOne,
      remainingOther,
      sameDate: candidateSameDate,
      differentDate: candidateDifferentDate,
    },
  };
}

function parseForComparison(input: CalibrationInput): {
  parser: StatementParser;
  statement: ParsedStatement;
} {
  const parserInput: ParserInput = {
    file: { name: input.fileName, bytes: input.bytes },
    sheets: input.sheets,
    fileHash: input.fileHash,
    accountId: input.accountId,
  };
  const detections = detectAll(parserInput);
  const chosenId = input.parserId ?? detections[0]?.parser;
  const parser = chosenId ? getParser(chosenId) : undefined;
  if (!parser) {
    throw new Error(
      'Ningún perfil reconoció uno de los archivos. Indica --parser <id> para ambos.',
    );
  }
  return { parser, statement: parser.parse(parserInput) };
}

function matchKey(transaction: NormalizedTransaction): string {
  return [
    transaction.normalizedDescription,
    transaction.amount.currency,
    String(transaction.amount.minor),
    String(transaction.amount.scale),
  ].join('::');
}

/** A bare remaining-cuotas integer the column carries but `detectInstallment` did not parse. */
function bareInstallmentValue(transaction: NormalizedTransaction): number | undefined {
  if (transaction.installment !== undefined) return undefined;
  const raw = transaction.rawMetadata[ColumnRole.installment];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return /^\d{1,3}$/.test(trimmed) ? Number(trimmed) : undefined;
}

export function formatComparisonReport(report: ComparisonReport): string {
  const lines: string[] = [];
  const add = (label: string, value: string | number) => lines.push(`${label.padEnd(28)}${value}`);

  lines.push('── Comparación entre dos archivos ───────────────────────');
  add('Perfil A / B', `${report.parserA} / ${report.parserB}`);
  add('Filas A / B', `${report.rowsA} / ${report.rowsB}`);
  add('Coincidencias', report.matched);
  add('Sólo en A / sólo en B', `${report.onlyA} / ${report.onlyB}`);
  add('  misma fecha / distinta', `${report.sameDate} / ${report.differentDate}`);

  lines.push('', '── Continuidad de cuotas ─────────────────────────────────');
  add('Candidatas (cuota activa)', report.installmentContinuity.candidates);
  add('  misma fecha / distinta', `${report.installmentContinuity.sameDate} / ${report.installmentContinuity.differentDate}`);
  add('  bajó en exactamente 1', report.installmentContinuity.remainingDecreasedByOne);
  add('  otro patrón', report.installmentContinuity.remainingOther);

  return lines.join('\n');
}
