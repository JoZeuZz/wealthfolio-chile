import type { AddonContext } from '@wealthfolio/addon-sdk';
import { toActivityCreate } from '../core/mapping/activities';
import { createRedactingLogger } from '../core/privacy';
import type { PreparedImport } from '../core/pipeline';
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

export interface RunImportResult {
  run: ImportRun;
  createdCount: number;
  errors: string[];
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

  const status: ImportRun['status'] =
    errors.length === 0 ? 'completed' : created > 0 ? 'partial' : 'failed';

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
    detectedRows: prepared.rows.length,
    importedRows: created,
    exactDuplicates: prepared.totals.exactDuplicates,
    probableDuplicates: prepared.totals.probableDuplicates,
    ignoredRows: prepared.totals.ignored,
    errorRows: prepared.validation.summary.errorRows,
    status,
    ...(errors.length > 0 ? { message: errors.slice(0, 3).join(' · ') } : {}),
  };

  await ImportHistory.from(ctx).record(run);

  // Counts only — never descriptions, amounts or account identifiers.
  logger.info(
    `Importación ${status}: ${created} de ${selected.length} movimientos (${prepared.totals.exactDuplicates} duplicados omitidos).`,
  );

  ctx.api.query.invalidateQueries(['activities']);
  ctx.api.query.invalidateQueries(['portfolio']);

  return { run, createdCount: created, errors };
}
