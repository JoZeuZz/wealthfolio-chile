import type { AddonContext } from '@wealthfolio/addon-sdk';
import { addDays } from '../core/dates';
import { buildDuplicateIndex, type DuplicateIndex } from '../core/dedupe/classify';
import type { SourceFile } from '../core/parsing/tabular';
import { prepareImport, type PreparedImport } from '../core/pipeline';
import { defaultRules } from '../core/rules/builtin';
import type { Rule } from '../core/rules/engine';
import { loadDuplicateIndexResult } from './activity-index';
import { loadEffectiveRules } from './settings';

/**
 * Preparing a preview against a live Wealthfolio.
 *
 * `prepareImport()` is pure and stays that way: it takes a duplicate index, it
 * does not know how to fetch one. This is the impure half — read the host, hand
 * the result to the pure pipeline, and report *separately* on each thing that
 * can go wrong.
 *
 * The separation matters because the three failures have three different
 * consequences:
 *
 * - the file cannot be parsed        → there is nothing to show
 * - the rules cannot be read         → show the preview with the built-ins
 * - existing movements cannot be read → show the preview, refuse to import
 *
 * That last one is the whole point. Importing without a duplicate check can
 * silently double a month of expenses, so "we could not check" must block the
 * write rather than fall back to an empty index and call every row new.
 */

/** Days either side of the statement period to scan for existing movements. */
const INDEX_MARGIN_DAYS = 7;

export interface PrepareFromHostInput {
  file: SourceFile;
  accountId: string;
  accountName?: string;
  /** Parser chosen by the user; omitted means auto-detect. */
  parserId?: string;
}

export type ParseStatus = { status: 'ok' } | { status: 'error'; message: string };

export type DuplicateIndexStatus =
  | { status: 'ready'; scanned: number }
  | { status: 'unavailable'; reason: 'error' | 'truncated'; message: string };

export type RulesStatus = { status: 'ok' } | { status: 'fallback'; message: string };

export interface PreparationResult {
  /** Present whenever the file could be parsed at all. */
  prepared?: PreparedImport;
  parse: ParseStatus;
  duplicateIndex: DuplicateIndexStatus;
  rules: RulesStatus;
  /**
   * Whether confirming is allowed.
   *
   * Requires both a preview to approve and a duplicate check we can trust.
   */
  canImport: boolean;
}

const EMPTY_INDEX: DuplicateIndex = buildDuplicateIndex([]);

export async function prepareImportFromHost(
  ctx: AddonContext,
  input: PrepareFromHostInput,
): Promise<PreparationResult> {
  const rulesOutcome = await loadRules(ctx);

  // Pass one parses with no duplicate context. It is only used to learn which
  // period the statement covers, so the activity scan can ask the host for that
  // window instead of the whole account.
  const probe = runPipeline(input, rulesOutcome.rules, EMPTY_INDEX);
  if (probe.status === 'error') {
    return {
      parse: { status: 'error', message: probe.message },
      duplicateIndex: {
        status: 'unavailable',
        reason: 'error',
        message: 'No se revisaron los movimientos existentes porque el archivo no se pudo leer.',
      },
      rules: rulesOutcome.status,
      canImport: false,
    };
  }

  const indexOutcome = await loadIndex(ctx, input.accountId, probe.prepared);

  // Pass two is the preview the user actually approves. Re-running the pure
  // pipeline is cheap and deterministic — the same bytes and the same index
  // always give the same rows.
  const final =
    indexOutcome.status.status === 'ready'
      ? runPipeline(input, rulesOutcome.rules, indexOutcome.index)
      : probe;

  if (final.status === 'error') {
    return {
      parse: { status: 'error', message: final.message },
      duplicateIndex: indexOutcome.status,
      rules: rulesOutcome.status,
      canImport: false,
    };
  }

  return {
    prepared: final.prepared,
    parse: { status: 'ok' },
    duplicateIndex: indexOutcome.status,
    rules: rulesOutcome.status,
    canImport: indexOutcome.status.status === 'ready',
  };
}

type PipelineOutcome =
  | { status: 'ok'; prepared: PreparedImport }
  | { status: 'error'; message: string };

function runPipeline(
  input: PrepareFromHostInput,
  rules: readonly Rule[],
  duplicateIndex: DuplicateIndex,
): PipelineOutcome {
  try {
    return {
      status: 'ok',
      prepared: prepareImport({
        file: input.file,
        accountId: input.accountId,
        ...(input.accountName !== undefined ? { accountName: input.accountName } : {}),
        ...(input.parserId !== undefined ? { parserId: input.parserId } : {}),
        rules,
        duplicateIndex,
      }),
    };
  } catch (error) {
    return { status: 'error', message: messageOf(error) };
  }
}

async function loadRules(
  ctx: AddonContext,
): Promise<{ rules: readonly Rule[]; status: RulesStatus }> {
  try {
    return { rules: await loadEffectiveRules(ctx.api.storage), status: { status: 'ok' } };
  } catch (error) {
    // Losing the user's rule edits degrades categorisation; it does not make an
    // import unsafe, so the built-ins carry the preview.
    return {
      rules: defaultRules(),
      status: {
        status: 'fallback',
        message: `No se pudieron leer tus reglas (${messageOf(error)}). Se usaron sólo las reglas predefinidas.`,
      },
    };
  }
}

async function loadIndex(
  ctx: AddonContext,
  accountId: string,
  prepared: PreparedImport,
): Promise<{ index: DuplicateIndex; status: DuplicateIndexStatus }> {
  const { from, to } = prepared.statement.period;

  try {
    const result = await loadDuplicateIndexResult(ctx, {
      accountId,
      // Without a known period the whole account is scanned: a narrower guess
      // could miss the movement that proves a row is a duplicate.
      ...(from ? { fromDate: addDays(from, -INDEX_MARGIN_DAYS) } : {}),
      ...(to ? { toDate: addDays(to, INDEX_MARGIN_DAYS) } : {}),
    });

    if (result.truncated) {
      return {
        index: EMPTY_INDEX,
        status: {
          status: 'unavailable',
          reason: 'truncated',
          message:
            'La cuenta tiene más movimientos de los que se alcanzaron a revisar, así que no se puede garantizar que no haya duplicados.',
        },
      };
    }

    return { index: result.index, status: { status: 'ready', scanned: result.scanned } };
  } catch (error) {
    return {
      index: EMPTY_INDEX,
      status: {
        status: 'unavailable',
        reason: 'error',
        message: `No se pudieron leer los movimientos existentes (${messageOf(error)}).`,
      },
    };
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
