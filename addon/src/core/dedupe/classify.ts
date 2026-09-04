import { daysBetween } from '../dates';
import { equals, type Money } from '../money';
import type { NormalizedTransaction } from '../model/transaction';
import { descriptionKey, similarity } from '../text';
import {
  computeFingerprint,
  computeWeakFingerprint,
  legacyFingerprintsOf,
  type FingerprintScope,
} from './fingerprint';

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

/**
 * Why the verdict came out the way it did.
 *
 * A code rather than only the prose, because callers need to *count* these and
 * to style them: "one row is a possible duplicate because you edited it in
 * Wealthfolio" and "one row looks like something already there" are different
 * things to tell someone, and matching on the message text to tell them apart
 * is how copy edits silently change behaviour.
 */
export type DuplicateReason =
  | 'exact-fingerprint'
  | 'repeated-within-file'
  | 'host-modified'
  | 'similar'
  | 'new';

export interface DuplicateFinding {
  verdict: DuplicateVerdict;
  reason_code: DuplicateReason;
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
  /**
   * The activity changed after this addon created it.
   *
   * Its fingerprint is therefore a fingerprint of what *was* imported, not of
   * what the ledger now holds. See {@link classifyDuplicate}.
   */
  hostModified?: boolean;
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

  // A row this addon wrote under 0.1.x carries the fingerprint that version
  // computed, and for an amount with cents that is a different hash. Looking it
  // up too is what keeps the recipe change from re-importing every statement
  // that prints decimals. See `legacyFingerprintsOf`.
  const legacy = legacyFingerprintsOf(candidate, scope);
  const stored = index.byFingerprint.get(fingerprint) ??
    (legacy ? index.byFingerprint.get(legacy.fingerprint) : undefined);
  if (stored) {
    if (stored.hostModified) {
      // The fingerprint says "we imported this row"; the host says "and then it
      // was changed". Skipping silently would leave the original movement out
      // of the ledger for good, with nothing anywhere to show it went missing.
      // Importing silently would sit a second copy next to the edited one.
      // Neither is ours to decide.
      return {
        verdict: 'probable',
        reason_code: 'host-modified',
        existingFingerprint: fingerprint,
        existingActivityId: stored.activityId,
        reason:
          'Este movimiento se importó antes, pero la actividad fue editada después en Wealthfolio, así que ya no coincide con la fila del archivo. Decide tú si la fila original falta o si la editada la reemplaza.',
      };
    }
    return {
      verdict: 'exact',
      reason_code: 'exact-fingerprint',
      existingFingerprint: fingerprint,
      existingActivityId: stored.activityId,
      reason: 'Ya fue importado antes (huella idéntica).',
    };
  }

  const inBatch = withinBatch.get(fingerprint);
  if (inBatch) {
    // `probable`, not `exact`. This module's own contract says `probable` exists
    // precisely because two genuinely identical charges on the same day — two
    // $2.500 coffees, two ATM withdrawals of the same amount — are a real thing
    // that has to stay distinguishable from one movement listed twice. That
    // promise held against the stored ledger and not within a single file,
    // where the second row was called a proven duplicate. Nothing here proves
    // it: an export that repeats a line and a day that contained two identical
    // purchases look the same from here.
    //
    // It stays unticked either way — a wrong skip costs one movement the user
    // can re-add, a wrong import doubles an expense silently — but the badge
    // now says what is actually known, and the row can be ticked on its own
    // (see `PreviewRow.key`).
    return {
      verdict: 'probable',
      reason_code: 'repeated-within-file',
      existingFingerprint: fingerprint,
      reason:
        'El archivo lista esta misma fila dos veces. Si de verdad hubo dos movimientos iguales, márcala.',
    };
  }

  const weak = computeWeakFingerprint(candidate, scope);
  const sameDayAmount = [
    ...(index.byWeakFingerprint.get(weak) ?? []),
    ...(legacy ? (index.byWeakFingerprint.get(legacy.weakFingerprint) ?? []) : []),
  ];
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
      reason_code: 'similar',
      existingActivityId: best.movement.activityId,
      score: best.score,
      reason: `Coincide en fecha y monto con un movimiento existente (descripción ${Math.round(best.score * 100)}% similar).`,
    };
  }

  return { verdict: 'none', reason_code: 'new', reason: 'Movimiento nuevo.' };
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
