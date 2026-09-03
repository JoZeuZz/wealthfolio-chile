import type { AddonContext } from '@wealthfolio/addon-sdk';
import { toActivityCreate } from '../core/mapping/activities';
import { createRedactingLogger, sanitizeFileName } from '../core/privacy';
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
 *
 * "Loses little work" is literal: v3.6.2 validates a bulk request as a unit and
 * persists nothing if any row in it fails, so one bad row costs its whole batch.
 * That is the cost being bounded here.
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
  const batches = Math.ceil(activities.length / BATCH_SIZE);
  let created = 0;

  for (let offset = 0; offset < activities.length; offset += BATCH_SIZE) {
    const batch = activities.slice(offset, offset + BATCH_SIZE);
    const batchNumber = offset / BATCH_SIZE + 1;
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
      // Position and count, never the host's text. A host message can quote the
      // request back — and the request is a bank statement row, complete with
      // whatever name, RUT or account number the glosa carried. Redaction is
      // not enough for that: it strips identifiers with a known shape, and a
      // counterparty's name has no shape.
      logger.error(`Falló el lote ${batchNumber} de ${batches} al importar.`);
    }
  }

  const breakdown = buildBreakdown(prepared.rows, created);

  // Every entry in `errors` is a row that was *not* created.
  //
  // In v3.6.2 `bulk_mutate_activities` validates the whole request first and, if
  // anything at all failed validation, returns `{ errors, ..Default::default() }`
  // — created empty, nothing persisted. Past that check the write is one
  // transaction, so a database failure comes back as a rejected promise, not as
  // an `errors` entry. There is therefore no v3.6.2 path where the host reports
  // an error and still created the row.
  //
  // `failed` alone would be enough against that contract. `errors.length === 0`
  // stays as the conservative half of the test: if some future host did report
  // an error while creating everything, calling that run `completed` would tell
  // the user there is nothing to look at. `partial` sends them to the detail.
  //
  // The history failure is appended to `errors` *after* this, on purpose: it
  // happens once the money is already in the ledger and must never downgrade a
  // financially complete run.
  const status: ImportRun['status'] =
    breakdown.failed === 0 && errors.length === 0
      ? 'completed'
      : created > 0
        ? 'partial'
        : 'failed';

  const run: ImportRun = {
    id: runId,
    timestamp: new Date().toISOString(),
    // Sanitised, not stored as downloaded. Chilean banks name the file after
    // whatever identifies the account — `CartolaCuentaRut_12345678-9_202602.csv`
    // — and this goes into a store that replicates across the user's paired
    // devices. The hash below is what actually identifies the file.
    fileName: sanitizeFileName(prepared.statement.fileName),
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
    // Counts and a code, never the host's own text. Redaction only removes what
    // has a shape, and a counterparty's name has none — the message that
    // reached storage in testing said `no se pudo guardar "TRANSFERENCIA A JUAN
    // PEREZ ..."` with the name intact. The full text stays in `errors`, which
    // is in memory and on the screen the user is looking at; the history
    // outlives that screen and keeps only what answers "why did this not
    // finish".
    ...(errors.length > 0
      ? {
          failureCode: 'host-rejected' as const,
          message: `El host rechazó ${breakdown.failed} de ${breakdown.selected} movimiento(s) aprobados. El detalle estaba en la pantalla de importación.`,
        }
      : {}),
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
