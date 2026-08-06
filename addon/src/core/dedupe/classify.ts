import { daysBetween } from '../dates';
import { equals, type Money } from '../money';
import type { NormalizedTransaction } from '../model/transaction';
import { descriptionKey, similarity } from '../text';
import { computeFingerprint, computeWeakFingerprint, type FingerprintScope } from './fingerprint';

/**
 * Duplicate classification.
 *
 * Three outcomes, and the difference between them is who decides:
 *
 * - `exact` — same fingerprint as something already imported. Skipped without
 *   asking; this is what makes re-importing a file a no-op.
 * - `probable` — same account, day and amount, similar description. Shown to
 *   the user, defaulted to "skip", never applied silently.
 * - `none` — imported.
 *
 * Two genuinely identical charges on the same day (two $2.500 coffees) are the
 * reason `probable` exists as a separate outcome instead of being folded into
 * `exact`.
 */

export type DuplicateVerdict = 'exact' | 'probable' | 'none';

export interface DuplicateFinding {
  verdict: DuplicateVerdict;
  /** Fingerprint of the movement already present, when known. */
  existingFingerprint?: string;
  /** Wealthfolio activity id of the existing movement, when known. */
  existingActivityId?: string;
  /** 0..1 similarity that produced a `probable` verdict. */
  score?: number;
  /** Shown verbatim in the preview so the user can judge the call. */
  reason: string;
}

/** A movement already stored in Wealthfolio, as far as deduplication cares. */
export interface ExistingMovement {
  fingerprint?: string;
  weakFingerprint?: string;
  activityId: string;
  date: string;
  amount: Money;
  description: string;
}

export interface DuplicateIndex {
  byFingerprint: Map<string, ExistingMovement>;
  byWeakFingerprint: Map<string, ExistingMovement[]>;
}

/** Build the lookup structures once per import run. */
export function buildDuplicateIndex(existing: readonly ExistingMovement[]): DuplicateIndex {
  const byFingerprint = new Map<string, ExistingMovement>();
  const byWeakFingerprint = new Map<string, ExistingMovement[]>();

  for (const movement of existing) {
    if (movement.fingerprint) byFingerprint.set(movement.fingerprint, movement);
    if (movement.weakFingerprint) {
      const bucket = byWeakFingerprint.get(movement.weakFingerprint);
      if (bucket) bucket.push(movement);
      else byWeakFingerprint.set(movement.weakFingerprint, [movement]);
    }
  }

  return { byFingerprint, byWeakFingerprint };
}

export interface ClassifyOptions {
  /** Description similarity at or above which a weak match becomes `probable`. */
  similarityThreshold?: number;
  /** Days apart still considered "the same movement" for a probable match. */
  dateTolerance?: number;
}

const DEFAULTS: Required<ClassifyOptions> = {
  similarityThreshold: 0.72,
  dateTolerance: 3,
};

/**
 * Classify one candidate against what is already stored.
 *
 * `withinBatch` carries the rows already accepted from the *same* file, so a
 * statement that lists a movement twice is caught too.
 */
export function classifyDuplicate(
  candidate: NormalizedTransaction,
  index: DuplicateIndex,
  scope: FingerprintScope,
  withinBatch: ReadonlyMap<string, NormalizedTransaction>,
  options: ClassifyOptions = {},
): DuplicateFinding {
  const { similarityThreshold, dateTolerance } = { ...DEFAULTS, ...options };
  const fingerprint = candidate.fingerprint || computeFingerprint(candidate, scope);

  const stored = index.byFingerprint.get(fingerprint);
  if (stored) {
    return {
      verdict: 'exact',
      existingFingerprint: fingerprint,
      existingActivityId: stored.activityId,
      reason: 'Ya fue importado antes (huella idéntica).',
    };
  }

  const inBatch = withinBatch.get(fingerprint);
  if (inBatch) {
    return {
      verdict: 'exact',
      existingFingerprint: fingerprint,
      reason: 'El archivo contiene esta misma fila dos veces.',
    };
  }

  const weak = computeWeakFingerprint(candidate, scope);
  const sameDayAmount = index.byWeakFingerprint.get(weak) ?? [];
  const candidateKey = descriptionKey(candidate.description);

  let best: { movement: ExistingMovement; score: number } | undefined;
  for (const movement of sameDayAmount) {
    if (Math.abs(daysBetween(movement.date, candidate.date)) > dateTolerance) continue;
    if (!equals(movement.amount, candidate.amount)) continue;
    const score = similarity(candidateKey, descriptionKey(movement.description));
    if (!best || score > best.score) best = { movement, score };
  }

  if (best && best.score >= similarityThreshold) {
    return {
      verdict: 'probable',
      existingActivityId: best.movement.activityId,
      score: best.score,
      reason: `Coincide en fecha y monto con un movimiento existente (descripción ${Math.round(best.score * 100)}% similar).`,
    };
  }

  return { verdict: 'none', reason: 'Movimiento nuevo.' };
}

export interface DedupeResult {
  transaction: NormalizedTransaction;
  finding: DuplicateFinding;
}

export interface DedupeBatchResult {
  results: DedupeResult[];
  counts: Record<DuplicateVerdict, number>;
}

/** Classify a whole parsed statement in one pass. */
export function dedupeBatch(
  transactions: readonly NormalizedTransaction[],
  index: DuplicateIndex,
  scope: FingerprintScope,
  options: ClassifyOptions = {},
): DedupeBatchResult {
  const seen = new Map<string, NormalizedTransaction>();
  const results: DedupeResult[] = [];
  const counts: Record<DuplicateVerdict, number> = { exact: 0, probable: 0, none: 0 };

  for (const transaction of transactions) {
    const fingerprint = transaction.fingerprint || computeFingerprint(transaction, scope);
    const withFingerprint = { ...transaction, fingerprint };
    const finding = classifyDuplicate(withFingerprint, index, scope, seen, options);
    counts[finding.verdict] += 1;
    if (finding.verdict === 'none') seen.set(fingerprint, withFingerprint);
    results.push({ transaction: withFingerprint, finding });
  }

  return { results, counts };
}
