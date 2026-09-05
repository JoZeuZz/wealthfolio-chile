import { compare, negate, type Money } from '../core/money';
import { Confidence, TransactionKind } from '../core/model/kinds';
import type { NormalizedTransaction } from '../core/model/transaction';
import { DETECTION_FLOOR, type ParsedStatement, type ValidationResult } from '../core/model/statement';
import { detectHeader, mapColumns } from '../core/parsing/columns';
import type { Sheet } from '../core/parsing/tabular';
import { redactSensitive } from '../core/privacy';
import { detectAll, getParser } from '../core/providers/registry';
import type { ParserInput } from '../core/providers/parser';

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
  /** Issue codes the parser raised, with how many times each. */
  issues: Array<{ code: string; level: string; count: number }>;
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
   */
  unmapped: Array<{ column: number }>;
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
  const sheet = input.sheets[0] as Sheet;

  return {
    file: fileFacts(input, sheet),
    detection: detectionFacts(parser.id, parser.institution, detections),
    header: headerFacts(sheet, parser.id),
    rows: rowFacts(statement),
    amounts: amountFacts(statement.transactions),
    dates: dateFacts(statement.transactions),
    balances: balanceFacts(statement),
    classification: classificationFacts(statement.transactions),
    issues: issueFacts(validation),
  };
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
  if (!sheet || !profile) return { row: -1, mapped: [], unmapped: [] };

  const header = detectHeader(sheet);
  if (header.headerRow < 0) return { row: -1, mapped: [], unmapped: [] };

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
    else unmapped.push({ column });
  });

  return { row: header.headerRow, mapped, unmapped };
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
  let previous: Money | undefined;
  for (const transaction of statement.transactions) {
    const balance = transaction.balanceAfter;
    if (!balance) continue;
    if (previous) {
      steps += 1;
      const expected = { ...balance, minor: balance.minor - previous.minor };
      if (compare(expected, transaction.amount) !== 0) {
        mismatches += 1;
        const kind = classifyMismatch(expected, transaction.amount);
        kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
      }
    }
    previous = balance;
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
      lines.push(`  [${column.column}] rol no reconocido`);
    }
  }

  lines.push('', '── Filas ─────────────────────────────────────────────────');
  add('De datos', report.rows.data);
  add('Mapeadas', report.rows.mapped);
  add('Omitidas', report.rows.skipped);
  add('Fallidas', report.rows.failed);
  if (report.rows.failedLines.length > 0) {
    add('Líneas fallidas', report.rows.failedLines.join(', '));
  }

  lines.push('', '── Montos ────────────────────────────────────────────────');
  add(
    'Decimales',
    report.amounts.byScale.map((entry) => `${entry.rows} filas con ${entry.scale}`).join(' · '),
  );
  add('Entradas / salidas / cero', `${report.amounts.inflows} / ${report.amounts.outflows} / ${report.amounts.zero}`);

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

  lines.push('', '── Clasificación ─────────────────────────────────────────');
  for (const kind of report.classification.byKind) {
    lines.push(`  ${String(kind.rows).padStart(5)}  ${kind.kind}`);
  }
  add('Sin clasificar', report.classification.unknown);
  add('Sólo por producto', report.classification.suggested);
  add('Cuotas ambiguas', report.classification.ambiguousInstallments);

  if (report.issues.length > 0) {
    lines.push('', '── Avisos ────────────────────────────────────────────────');
    for (const issue of report.issues) {
      lines.push(`  ${String(issue.count).padStart(5)}  [${issue.level}] ${issue.code}`);
    }
  }

  return lines.join('\n');
}
