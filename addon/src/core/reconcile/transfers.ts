import { daysBetween } from '../dates';
import { abs, equals, sign } from '../money';
import { Confidence, Direction, TransactionKind } from '../model/kinds';
import type { NormalizedTransaction } from '../model/transaction';
import { foldCase } from '../text';

/**
 * Internal-transfer matching.
 *
 * Moving $200.000 from Banco de Chile to BancoEstado is not $200.000 of
 * spending followed by $200.000 of income — it is the same money, seen twice.
 * Left unmatched it inflates *both* totals, which is the single most damaging
 * error a personal-finance tool can make.
 *
 * The matcher pairs an outflow with an inflow of the same absolute amount in
 * different accounts, close in time. It never auto-applies a weak match: a
 * pairing that is not clearly right is offered as a suggestion, because wrongly
 * erasing a real salary is worse than leaving a transfer double-counted for one
 * more click.
 */

export interface TransferMatchOptions {
  /** Days between legs still considered the same movement. */
  windowDays?: number;
  /** Days within which a match is strong enough to confirm on its own. */
  confirmWindowDays?: number;
}

const DEFAULTS: Required<TransferMatchOptions> = {
  windowDays: 5,
  confirmWindowDays: 2,
};

/** A transaction paired with the account it was imported into. */
export interface ScopedTransaction {
  /** Wealthfolio account id. Two legs of a transfer are in different accounts. */
  accountId: string;
  transaction: NormalizedTransaction;
}

export interface TransferMatch {
  outflow: ScopedTransaction;
  inflow: ScopedTransaction;
  confidence: Confidence;
  /** Days between the two legs. */
  gapDays: number;
  /** Explanation shown in the review UI. */
  reason: string;
}

export interface TransferMatchResult {
  /** Pairings the data settles. Never contains an arbitrary choice. */
  matches: TransferMatch[];
  /**
   * Movements with more than one equally plausible counterpart.
   *
   * Reported rather than resolved: nothing distinguishes the candidates, so a
   * pairing here would be a coin flip, and applying one writes a wrong
   * counterpart into the activity's metadata.
   */
  ambiguous: AmbiguousTransfer[];
  /** Fingerprints that ended up in a match, for quick lookup. */
  matchedFingerprints: Set<string>;
}

/** One movement and every counterpart the data cannot choose between. */
export interface AmbiguousTransfer {
  movement: ScopedTransaction;
  candidates: ScopedTransaction[];
  reason: string;
}

/** Words that make a movement look like a transfer rather than a purchase. */
const TRANSFER_MARKERS = [
  'TRANSFERENCIA',
  'TRASPASO',
  'TRANSF ',
  'TEF ',
  'ABONO TRANSFERENCIA',
  'CARGO TRANSFERENCIA',
  'ENTRE CUENTAS',
  'CUENTA PROPIA',
];

const OWN_ACCOUNT_MARKERS = ['CUENTA PROPIA', 'ENTRE CUENTAS', 'MIS CUENTAS', 'TRASPASO'];

/**
 * Wording that says the counterpart is *not* the user.
 *
 * `A TERCEROS` used to sit in `TRANSFER_MARKERS`, where it argued *for* an
 * internal transfer. It says the opposite. Confirming such a pair erases a real
 * expense and a real deposit at the same time — the most expensive single
 * mistake this matcher can make — so the phrase now blocks confirmation instead
 * of supporting it.
 */
const THIRD_PARTY_MARKERS = ['A TERCEROS', 'DE TERCEROS', 'TERCERO'];

/**
 * Shortest bank reference worth treating as evidence.
 *
 * A one- or two-digit correlativo collides by chance constantly; a real
 * transfer reference does not.
 */
const MIN_MEANINGFUL_REFERENCE = 6;

/**
 * A candidate pairing and how good it is.
 *
 * `rank` is the evidence tier and `gapDays` the tie-break. Two candidates with
 * the same pair are *indistinguishable*, and that is a state the matcher has to
 * be able to report rather than resolve.
 */
interface Candidate {
  outflow: ScopedTransaction;
  inflow: ScopedTransaction;
  evidence: Evidence;
  rank: number;
  gapDays: number;
}

/**
 * Pair transfer legs across accounts.
 *
 * Runs over the union of newly parsed rows and recent history, so a transfer
 * whose legs arrive in two separate imports still matches when the second file
 * is loaded.
 *
 * Pairs are accepted only when the choice is *mutual*: the inflow is this
 * outflow's single best candidate and the outflow is that inflow's. The
 * previous greedy pass walked the outflows in order and consumed the first
 * acceptable inflow, which had two consequences. It could cross a pair — with
 * two $100.000 transfers on consecutive days it might match day 10 to day 11
 * and day 11 to day 10, both at a one-day gap, when the right answer was two
 * same-day pairs. And when two candidates were genuinely indistinguishable it
 * still committed to one of them, tie-broken by fingerprint, which is a coin
 * flip presented as a finding — and `applyTransferMatch` would then write that
 * arbitrary counterpart into the activity's metadata.
 *
 * Indistinguishable groups are now reported as {@link AmbiguousTransfer} with
 * every candidate attached, and no pair at all.
 */
export function matchTransfers(
  scoped: readonly ScopedTransaction[],
  options: TransferMatchOptions = {},
): TransferMatchResult {
  const { windowDays, confirmWindowDays } = { ...DEFAULTS, ...options };

  const outflows = [...scoped.filter((s) => s.transaction.direction === Direction.out)].sort(
    byDateThenFingerprint,
  );
  const inflows = [...scoped.filter((s) => s.transaction.direction === Direction.in)].sort(
    byDateThenFingerprint,
  );

  const candidates: Candidate[] = [];
  for (const outflow of outflows) {
    for (const inflow of inflows) {
      if (inflow.accountId === outflow.accountId) continue;
      if (!equals(abs(inflow.transaction.amount), abs(outflow.transaction.amount))) continue;
      const gapDays = Math.abs(daysBetween(outflow.transaction.date, inflow.transaction.date));
      if (gapDays > windowDays) continue;
      const evidence = scoreEvidence(outflow, inflow);
      candidates.push({ outflow, inflow, evidence, rank: evidenceRank(evidence), gapDays });
    }
  }

  const byOutflow = groupBy(candidates, (c) => key(c.outflow));
  const byInflow = groupBy(candidates, (c) => key(c.inflow));

  const matches: TransferMatch[] = [];
  const ambiguous: AmbiguousTransfer[] = [];
  const resolved = new Set<string>();

  for (const outflow of outflows) {
    const group = byOutflow.get(key(outflow));
    if (!group || group.length === 0) continue;

    const best = pickBest(group);
    if (!best) {
      ambiguous.push(describeAmbiguity(outflow, group.map((c) => c.inflow)));
      resolved.add(key(outflow));
      continue;
    }

    const rival = byInflow.get(key(best.inflow));
    const bestForInflow = rival ? pickBest(rival) : undefined;
    if (!bestForInflow || key(bestForInflow.outflow) !== key(outflow)) {
      // Either the inflow cannot choose between its own suitors, or it prefers
      // a different outflow. Both mean this pairing is not settled.
      ambiguous.push(describeAmbiguity(outflow, group.map((c) => c.inflow)));
      resolved.add(key(outflow));
      continue;
    }

    matches.push({
      outflow,
      inflow: best.inflow,
      confidence: resolveConfidence({
        gapDays: best.gapDays,
        confirmWindowDays,
        evidence: best.evidence,
      }),
      gapDays: best.gapDays,
      reason: buildReason({ gapDays: best.gapDays, evidence: best.evidence }),
    });
    resolved.add(key(outflow));
    resolved.add(key(best.inflow));
  }

  // An inflow several outflows want, none of which won it, is also unresolved
  // and the user should see it from that side too.
  for (const inflow of inflows) {
    if (resolved.has(key(inflow))) continue;
    const group = byInflow.get(key(inflow));
    if (!group || group.length < 2) continue;
    if (group.every((c) => resolved.has(key(c.outflow)) && !isMatched(matches, c))) {
      ambiguous.push(describeAmbiguity(inflow, group.map((c) => c.outflow)));
    }
  }

  return {
    matches,
    ambiguous,
    matchedFingerprints: new Set(
      matches.flatMap((m) => [m.outflow.transaction.fingerprint, m.inflow.transaction.fingerprint]),
    ),
  };
}

function isMatched(matches: readonly TransferMatch[], candidate: Candidate): boolean {
  return matches.some(
    (m) => key(m.outflow) === key(candidate.outflow) && key(m.inflow) === key(candidate.inflow),
  );
}

/**
 * The single best candidate, or `undefined` when two are equally good.
 *
 * "Equally good" is the whole point: same evidence tier and same day gap means
 * nothing in the data distinguishes them, and picking one would be inventing an
 * answer.
 */
function pickBest(group: readonly Candidate[]): Candidate | undefined {
  const sorted = [...group].sort(byQuality);
  const best = sorted[0];
  const runnerUp = sorted[1];
  if (!best) return undefined;
  if (runnerUp && best.rank === runnerUp.rank && best.gapDays === runnerUp.gapDays) {
    return undefined;
  }
  return best;
}

function byQuality(a: Candidate, b: Candidate): number {
  if (a.rank !== b.rank) return b.rank - a.rank;
  if (a.gapDays !== b.gapDays) return a.gapDays - b.gapDays;
  return compareKeys(a.inflow, b.inflow) || compareKeys(a.outflow, b.outflow);
}

function describeAmbiguity(
  movement: ScopedTransaction,
  candidates: readonly ScopedTransaction[],
): AmbiguousTransfer {
  return {
    movement,
    candidates: [...candidates],
    reason: `Hay ${candidates.length} candidatos igual de plausibles (mismo monto, cuentas distintas, fechas cercanas) y nada en los datos permite decidir cuál corresponde. Elígelo tú.`,
  };
}

function groupBy<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const bucket = out.get(keyOf(item));
    if (bucket) bucket.push(item);
    else out.set(keyOf(item), [item]);
  }
  return out;
}

interface Evidence {
  /** Either description names a transfer. */
  transferWording: boolean;
  /** Wording explicitly says the counterpart is the user's own account. */
  ownAccountWording: boolean;
  /** One description mentions the other leg's institution. */
  institutionMentioned: boolean;
  /** Same, non-trivial bank reference on both legs. */
  sharedReference: boolean;
  /** Either description says the counterpart belongs to somebody else. */
  thirdParty: boolean;
}

function scoreEvidence(outflow: ScopedTransaction, inflow: ScopedTransaction): Evidence {
  const outText = foldCase(outflow.transaction.description);
  const inText = foldCase(inflow.transaction.description);

  const transferWording =
    TRANSFER_MARKERS.some((marker) => outText.includes(marker)) ||
    TRANSFER_MARKERS.some((marker) => inText.includes(marker));

  const ownAccountWording =
    OWN_ACCOUNT_MARKERS.some((marker) => outText.includes(marker)) ||
    OWN_ACCOUNT_MARKERS.some((marker) => inText.includes(marker));

  const outInstitution = institutionWords(outflow.transaction.sourceInstitution);
  const inInstitution = institutionWords(inflow.transaction.sourceInstitution);
  const institutionMentioned =
    inInstitution.some((word) => outText.includes(word)) ||
    outInstitution.some((word) => inText.includes(word));

  const reference = outflow.transaction.reference ?? '';
  const sharedReference =
    reference.length >= MIN_MEANINGFUL_REFERENCE &&
    reference === inflow.transaction.reference;

  const thirdParty =
    THIRD_PARTY_MARKERS.some((marker) => outText.includes(marker)) ||
    THIRD_PARTY_MARKERS.some((marker) => inText.includes(marker));

  return { transferWording, ownAccountWording, institutionMentioned, sharedReference, thirdParty };
}

/**
 * Evidence tier, for choosing between candidates.
 *
 * Ordering only — it never decides whether a pair is confirmed, which
 * {@link resolveConfidence} does on the evidence itself.
 */
function evidenceRank(evidence: Evidence): number {
  if (evidence.thirdParty) return 0;
  if (evidence.sharedReference) return 3;
  if (evidence.transferWording && (evidence.ownAccountWording || evidence.institutionMentioned)) {
    return 2;
  }
  if (evidence.transferWording) return 1;
  return 0;
}

function institutionWords(institution: string): string[] {
  switch (institution) {
    case 'banco-chile':
      return ['BANCO DE CHILE', 'BCH', 'BANCHILE', 'EDWARDS'];
    case 'banco-estado':
      return ['BANCOESTADO', 'BANCO ESTADO', 'ESTADO', 'CUENTARUT'];
    case 'banco-falabella':
      return ['FALABELLA', 'CMR'];
    default:
      return [];
  }
}

interface ConfidenceInput {
  gapDays: number;
  confirmWindowDays: number;
  evidence: Evidence;
}

/**
 * Only a same-or-next-day pair with explicit transfer wording is confirmed on
 * its own. Everything else is a suggestion.
 *
 * Wording that names a third party blocks confirmation outright, whatever else
 * lines up: an amount and a date matching by coincidence is ordinary, and
 * confirming that pair would remove a real expense and a real deposit together.
 */
function resolveConfidence(input: ConfidenceInput): Confidence {
  const { gapDays, confirmWindowDays, evidence } = input;
  if (evidence.thirdParty) return Confidence.suggested;

  const strong =
    evidence.sharedReference ||
    (evidence.transferWording && (evidence.ownAccountWording || evidence.institutionMentioned));

  if (strong && gapDays <= confirmWindowDays) return Confidence.confirmed;
  return Confidence.suggested;
}

function buildReason(input: { gapDays: number; evidence: Evidence }): string {
  const parts: string[] = [];
  parts.push(
    input.gapDays === 0 ? 'Mismo día' : `${input.gapDays} día(s) de diferencia`,
  );
  parts.push('mismo monto en cuentas distintas');
  if (input.evidence.sharedReference) parts.push('misma referencia bancaria');
  if (input.evidence.transferWording) parts.push('la glosa menciona una transferencia');
  if (input.evidence.ownAccountWording) parts.push('la glosa indica cuenta propia');
  if (input.evidence.institutionMentioned) parts.push('la glosa nombra al otro banco');
  if (input.evidence.thirdParty) {
    parts.push('pero la glosa menciona a un tercero, así que no se confirma sola');
  }
  return `${parts.join('; ')}.`;
}

function key(scoped: ScopedTransaction): string {
  return `${scoped.accountId}:${scoped.transaction.fingerprint}`;
}

function compareKeys(a: ScopedTransaction, b: ScopedTransaction): number {
  return key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;
}

function byDateThenFingerprint(a: ScopedTransaction, b: ScopedTransaction): number {
  if (a.transaction.date !== b.transaction.date) {
    return a.transaction.date < b.transaction.date ? -1 : 1;
  }
  return compareKeys(a, b);
}

/**
 * Apply a decided match to both legs.
 *
 * Reclassifying is all it takes to fix the totals: `internal_transfer` is
 * excluded from every income and expense aggregate by construction.
 */
export function applyTransferMatch(
  match: TransferMatch,
  kind: TransactionKind = TransactionKind.internal_transfer,
): [NormalizedTransaction, NormalizedTransaction] {
  const stamp = (
    transaction: NormalizedTransaction,
    counterpart: NormalizedTransaction,
  ): NormalizedTransaction => ({
    ...transaction,
    kind,
    kindConfidence: match.confidence,
    transferCandidate: {
      counterpartFingerprint: counterpart.fingerprint,
      counterpartInstitution: counterpart.sourceInstitution,
      confidence: match.confidence,
      reason: match.reason,
    },
  });

  return [
    stamp(match.outflow.transaction, match.inflow.transaction),
    stamp(match.inflow.transaction, match.outflow.transaction),
  ];
}

/** True when a single row looks like a transfer even without a counterpart. */
export function looksLikeTransfer(transaction: NormalizedTransaction): boolean {
  const text = foldCase(transaction.description);
  return TRANSFER_MARKERS.some((marker) => text.includes(marker)) && sign(transaction.amount) !== 0;
}
