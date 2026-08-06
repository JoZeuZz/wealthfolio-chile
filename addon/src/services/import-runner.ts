import type { AddonContext } from '@wealthfolio/addon-sdk';
import { toActivityCreate } from '../core/mapping/activities';
import { createRedactingLogger } from '../core/privacy';
import type { PreparedImport, PreviewRow } from '../core/pipeline';
import { ImportHistory, newRunId, type ImportRun } from './import-history';

/**
 * Writing an approved preview into Wealthfolio.
 *
 * The only function in the addon that mutates the user's ledger, and it does so
 * exclusively through the supported `activities.saveMany` API — never by
 * touching the database. That constraint is what keeps this project an addon
 * rather than a fork.
 *
 * Nothing is written until the user has seen a preview and pressed confirm.
 */

export interface RunImportInput {
  ctx: AddonContext;
  prepared: PreparedImport;
  accountId: string;
  accountName: string;
  /** Rows already filtered by the preview; only `willImport` rows are written. */
  verboseLogging?: boolean;
}

/**
 * Why each detected row did or did not end up in Wealthfolio.
 *
 * Calling all four skip reasons "skipped" hides the only distinction that
 * matters to the user: a row the deduplicator recognised is fine, a row that
 * failed to write is money missing from their ledger.
 *
 * `selected = created + failed` and
 * `detected = selected + skippedExactDuplicate + skippedProbableDuplicate +
 * skippedByRule + skippedByUser`, always.
 */
export interface ImportBreakdown {
  /** Rows the parser produced. */
  detected: number;
  /** Rows the user approved for import. */
  selected: number;
  /** Rows Wealthfolio confirmed it created. */
  created: number;
  /** Approved rows the host refused or never acknowledged. */
  failed: number;
  skippedExactDuplicate: number;
  skippedProbableDuplicate: number;
  skippedByRule: number;
  /** Approved-by-default rows the user unticked in the preview. */
  skippedByUser: number;
}

export interface RunImportResult {
  run: ImportRun;
  /** @deprecated Read `breakdown.created`. Kept so callers migrate in one step. */
  createdCount: number;
  breakdown: ImportBreakdown;
  status: ImportRun['status'];
  errors: string[];
  /**
   * False when the movements were written but the run could not be recorded.
   *
   * Not a failed import — the money is in Wealthfolio — but the history page
   * will be missing an entry, and the user deserves to know that.
   */
  historyRecorded: boolean;
}

/**
 * Batch size for `saveMany`.
 *
 * Small enough that a failure loses little work and the UI can report progress,
 * large enough to avoid a round trip per movement.
 */
const BATCH_SIZE = 100;

export async function runImport(input: RunImportInput): Promise<RunImportResult> {
  const { ctx, prepared, accountId, accountName } = input;
  const logger = createRedactingLogger(ctx.api.logger, {
    verboseEnabled: input.verboseLogging ?? false,
  });

  const runId = newRunId();
  const selected = prepared.rows.filter((row) => row.willImport);

  const activities = selected.map((row) =>
    toActivityCreate(row.transaction, {
      accountId,
      runId,
      weakFingerprint: row.weakFingerprint,
    }),
  );

  const errors: string[] = [];
  let created = 0;

  for (let offset = 0; offset < activities.length; offset += BATCH_SIZE) {
    const batch = activities.slice(offset, offset + BATCH_SIZE);
    try {
      const result = await ctx.api.activities.saveMany({ creates: batch });
      created += result.created.length;
      for (const error of result.errors) {
        errors.push(error.message);
      }
    } catch (error) {
      // A failed batch is reported rather than retried: retrying a partially
      // applied write is exactly how duplicates get created.
      const message = error instanceof Error ? error.message : String(error);
      errors.push(message);
      logger.error(`Falló un lote de importación: ${message}`);
    }
  }

  const breakdown = buildBreakdown(prepared.rows, created);

  // `failed` rather than `errors` decides the status: a host that rejects rows
  // without raising is still a partial import, and a host that reports an error
  // yet created everything is not.
  const status: ImportRun['status'] =
    breakdown.failed === 0 && errors.length === 0
      ? 'completed'
      : created > 0
        ? 'partial'
        : 'failed';

  const run: ImportRun = {
    id: runId,
    timestamp: new Date().toISOString(),
    fileName: prepared.statement.fileName,
    fileHash: prepared.fileHash,
    institution: prepared.statement.institution,
    parser: prepared.statement.parser,
    parserVersion: prepared.statement.parserVersion,
    profileStatus: prepared.parser.profile.validationStatus,
    accountId,
    accountName,
    currency: prepared.totals.currency,
    ...(prepared.statement.period.from ? { periodFrom: prepared.statement.period.from } : {}),
    ...(prepared.statement.period.to ? { periodTo: prepared.statement.period.to } : {}),
    detectedRows: breakdown.detected,
    selectedRows: breakdown.selected,
    importedRows: breakdown.created,
    failedRows: breakdown.failed,
    exactDuplicates: breakdown.skippedExactDuplicate,
    probableDuplicates: breakdown.skippedProbableDuplicate,
    ignoredRows: breakdown.skippedByRule,
    deselectedRows: breakdown.skippedByUser,
    errorRows: prepared.validation.summary.errorRows,
    status,
    ...(errors.length > 0 ? { message: errors.slice(0, 3).join(' · ') } : {}),
  };

  // Recording the run must never undo a successful write, so a storage failure
  // is reported alongside the result instead of thrown over it.
  let historyRecorded = true;
  try {
    await ImportHistory.from(ctx).record(run);
  } catch (error) {
    historyRecorded = false;
    const message = error instanceof Error ? error.message : String(error);
    errors.push(`No se pudo registrar la importación en el historial: ${message}`);
    logger.error(`No se pudo registrar la importación: ${message}`);
  }

  // Counts only — never descriptions, amounts or account identifiers.
  logger.info(
    `Importación ${status}: ${breakdown.created} creados, ${breakdown.failed} fallidos, ` +
      `${breakdown.skippedExactDuplicate} duplicados, ${breakdown.skippedProbableDuplicate} posibles duplicados, ` +
      `${breakdown.skippedByRule} ignorados por regla, ${breakdown.skippedByUser} desmarcados.`,
  );

  ctx.api.query.invalidateQueries(['activities']);
  ctx.api.query.invalidateQueries(['portfolio']);

  return { run, createdCount: breakdown.created, breakdown, status, errors, historyRecorded };
}

/**
 * Attribute every detected row to exactly one outcome.
 *
 * Skip reasons are checked in order of how little the user chose them: an exact
 * duplicate is the engine's call, a untick is entirely theirs.
 */
export function buildBreakdown(rows: readonly PreviewRow[], created: number): ImportBreakdown {
  let selected = 0;
  let skippedExactDuplicate = 0;
  let skippedProbableDuplicate = 0;
  let skippedByRule = 0;
  let skippedByUser = 0;

  for (const row of rows) {
    if (row.willImport) {
      selected += 1;
      continue;
    }
    if (row.duplicate.verdict === 'exact') skippedExactDuplicate += 1;
    else if (row.duplicate.verdict === 'probable') skippedProbableDuplicate += 1;
    else if (row.ignoredByRule) skippedByRule += 1;
    else skippedByUser += 1;
  }

  const createdClamped = Math.max(0, Math.min(created, selected));

  return {
    detected: rows.length,
    selected,
    created: createdClamped,
    failed: selected - createdClamped,
    skippedExactDuplicate,
    skippedProbableDuplicate,
    skippedByRule,
    skippedByUser,
  };
}
