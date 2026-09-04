import { daysBetween } from '../dates';
import { abs, canonicalAmountString } from '../money';
import { Confidence, Direction, TransactionKind } from '../model/kinds';
import type { NormalizedTransaction } from '../model/transaction';
import { normalizeDescription } from '../text';

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

/**
 * A knot of movements whose pairings the data cannot separate.
 *
 * Reported per knot rather than per leg: a two-outflows-one-inflow tangle is
 * one problem to look at, not three, and listing it three times offered the
 * same counterpart in each — including counterparts other findings in the same
 * run had already claimed.
 */
export interface AmbiguousTransfer {
  /** Every leg involved, outflows and inflows, in ledger order. */
  movements: ScopedTransaction[];
  /** The pairings still open inside the knot, best first. */
  candidates: Array<{ outflow: ScopedTransaction; inflow: ScopedTransaction; gapDays: number }>;
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
const THIRD_PARTY_MARKERS = ['A TERCEROS', 'DE TERCEROS', 'TERCEROS', 'TERCERO'];

/**
 * Markers are matched on whole words.
 *
 * `TERCERO` as a bare substring made `PAGO PROVEEDOR TERCEROSOFT SPA` a
 * third-party transfer.
 */
function mentionsWord(text: string, markers: readonly string[]): boolean {
  const normalized = normalizeDescription(text);
  return markers.some((marker) => {
    const needle = normalizeDescription(marker);
    const index = normalized.indexOf(needle);
    if (index < 0) return false;
    const before = index === 0 ? ' ' : normalized[index - 1];
    const after = normalized[index + needle.length] ?? ' ';
    return before === ' ' && (after === ' ' || after === undefined);
  });
}

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
 * outflow's single best candidate and the outflow is that inflow's. A greedy
 * pass walking the outflows in order could cross a pair — two $100.000
 * transfers on consecutive days matched day 10 to day 11 and day 11 to day 10 —
 * and, worse, committed to one of two indistinguishable candidates, tie-broken
 * by fingerprint. A coin flip presented as a finding, which
 * `applyTransferMatch` then wrote into the activity's metadata.
 *
 * Mutual choice alone is not enough either. Preferences shift as legs are
 * consumed: once one pair is settled, two legs that each had two candidates can
 * be left with only each other, and computing preferences once abandoned those.
 * Measured against the greedy pass it replaced, a single round found fewer
 * pairs in roughly half of small multi-leg scenarios — and an unmatched
 * transfer inflates income and expenses at the same time, which is the whole
 * reason this module exists. So the rounds repeat until one settles nothing new.
 *
 * What is left after that is a genuine knot: legs whose candidates the data
 * cannot separate. Each connected group is reported once as an
 * {@link AmbiguousTransfer} — every leg and every pairing still open — rather
 * than as one finding per leg listing counterparts that other findings already
 * claimed.
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

  // Inflows are bucketed by amount before the pairing loop. Comparing every
  // outflow against every inflow is quadratic in the size of the window, and a
  // window is a year of two accounts: 5.000 movements took 1,5 s of pure
  // comparison, almost all of it on pairs that differ in amount and can never
  // match. Equal amount is a hard requirement, so it is the index.
  const byAmount = new Map<string, ScopedTransaction[]>();
  for (const inflow of inflows) {
    const bucketKey = amountKey(inflow);
    const bucket = byAmount.get(bucketKey);
    if (bucket) bucket.push(inflow);
    else byAmount.set(bucketKey, [inflow]);
  }

  let candidates: Candidate[] = [];
  for (const outflow of outflows) {
    for (const inflow of byAmount.get(amountKey(outflow)) ?? []) {
      if (inflow.accountId === outflow.accountId) continue;
      const gapDays = Math.abs(daysBetween(outflow.transaction.date, inflow.transaction.date));
      if (gapDays > windowDays) continue;
      const evidence = scoreEvidence(outflow, inflow);
      candidates.push({ outflow, inflow, evidence, rank: evidenceRank(evidence), gapDays });
    }
  }

  const matches: TransferMatch[] = [];
  const taken = new Set<string>();

  for (;;) {
    // `candidates` shrinks as legs are taken, so a round never re-walks a pair
    // that is already out of the running.
    const open = candidates.filter(
      (c) => !taken.has(key(c.outflow)) && !taken.has(key(c.inflow)),
    );
    candidates = open;
    if (open.length === 0) break;

    const byOutflow = groupBy(open, (c) => key(c.outflow));
    const byInflow = groupBy(open, (c) => key(c.inflow));

    const settled: Candidate[] = [];
    for (const [outflowKey, group] of byOutflow) {
      const best = pickBest(group);
      if (!best) continue;
      const rivals = byInflow.get(key(best.inflow));
      const bestForInflow = rivals ? pickBest(rivals) : undefined;
      if (!bestForInflow || key(bestForInflow.outflow) !== outflowKey) continue;
      settled.push(best);
    }

    if (settled.length === 0) break;

    // Sorted so the accepted set does not depend on Map iteration order when two
    // settlements collide on a leg — they cannot, being mutual, but the sort
    // keeps that a property of the code rather than of the input's order.
    for (const candidate of [...settled].sort(byQuality)) {
      if (taken.has(key(candidate.outflow)) || taken.has(key(candidate.inflow))) continue;
      taken.add(key(candidate.outflow));
      taken.add(key(candidate.inflow));
      matches.push({
        outflow: candidate.outflow,
        inflow: candidate.inflow,
        confidence: resolveConfidence({
          gapDays: candidate.gapDays,
          confirmWindowDays,
          evidence: candidate.evidence,
        }),
        gapDays: candidate.gapDays,
        reason: buildReason({ gapDays: candidate.gapDays, evidence: candidate.evidence }),
      });
    }
  }

  candidates = candidates.filter(
    (c) => !taken.has(key(c.outflow)) && !taken.has(key(c.inflow)),
  );

  return {
    matches: matches.sort(
      (a, b) =>
        byDateThenFingerprint(a.outflow, b.outflow) || compareKeys(a.inflow, b.inflow),
    ),
    ambiguous: knots(candidates),
    matchedFingerprints: new Set(
      matches.flatMap((m) => [m.outflow.transaction.fingerprint, m.inflow.transaction.fingerprint]),
    ),
  };
}

/**
 * Group the leftover candidates into connected knots.
 *
 * One finding per knot, not per leg. Reporting each leg separately produced
 * three findings for one two-outflows-one-inflow tangle, one of them offering a
 * single counterpart under the words "there are 1 equally plausible
 * candidates".
 */
function knots(candidates: readonly Candidate[]): AmbiguousTransfer[] {
  const component = new Map<string, string>();
  const find = (k: string): string => {
    const parent = component.get(k);
    if (parent === undefined || parent === k) return k;
    const root = find(parent);
    component.set(k, root);
    return root;
  };
  const union = (a: string, b: string) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) component.set(rootA < rootB ? rootB : rootA, rootA < rootB ? rootA : rootB);
  };

  for (const candidate of candidates) {
    component.set(key(candidate.outflow), component.get(key(candidate.outflow)) ?? key(candidate.outflow));
    component.set(key(candidate.inflow), component.get(key(candidate.inflow)) ?? key(candidate.inflow));
    union(key(candidate.outflow), key(candidate.inflow));
  }

  const grouped = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const root = find(key(candidate.outflow));
    const bucket = grouped.get(root);
    if (bucket) bucket.push(candidate);
    else grouped.set(root, [candidate]);
  }

  return [...grouped.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([, group]) => {
      const movements = new Map<string, ScopedTransaction>();
      for (const candidate of group) {
        movements.set(key(candidate.outflow), candidate.outflow);
        movements.set(key(candidate.inflow), candidate.inflow);
      }
      const legs = [...movements.values()].sort(byDateThenFingerprint);
      return {
        movements: legs,
        candidates: [...group]
          .sort(byQuality)
          .map((c) => ({ outflow: c.outflow, inflow: c.inflow, gapDays: c.gapDays })),
        reason:
          `${legs.length} movimientos del mismo monto en cuentas distintas admiten ` +
          `${group.length} emparejamientos y nada en los datos permite decidir entre ellos. ` +
          'Elígelo tú.',
      };
    });
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
  return compareKeys(a.outflow, b.outflow) || compareKeys(a.inflow, b.inflow);
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
  // Normalised, not merely case-folded. The rule engine compares against
  // `normalizedDescription`, and matching raw text here meant a double space —
  // routine in exports derived from fixed-width reports — silently downgraded a
  // confirmed own-account transfer to a suggestion.
  const outText = normalizeDescription(outflow.transaction.description);
  const inText = normalizeDescription(inflow.transaction.description);

  const transferWording =
    mentionsWord(outText, TRANSFER_MARKERS) || mentionsWord(inText, TRANSFER_MARKERS);

  const ownAccountWording =
    mentionsWord(outText, OWN_ACCOUNT_MARKERS) || mentionsWord(inText, OWN_ACCOUNT_MARKERS);

  const outInstitution = institutionWords(outflow.transaction.sourceInstitution);
  const inInstitution = institutionWords(inflow.transaction.sourceInstitution);
  const institutionMentioned =
    inInstitution.some((word) => outText.includes(normalizeDescription(word))) ||
    outInstitution.some((word) => inText.includes(normalizeDescription(word)));

  const sharedReference =
    isMeaningfulReference(outflow.transaction.reference) &&
    outflow.transaction.reference === inflow.transaction.reference;

  const thirdParty =
    mentionsWord(outText, THIRD_PARTY_MARKERS) || mentionsWord(inText, THIRD_PARTY_MARKERS);

  return { transferWording, ownAccountWording, institutionMentioned, sharedReference, thirdParty };
}

/**
 * Is this reference distinctive enough to be evidence?
 *
 * Length alone was not the test it claimed to be: Chilean statements
 * zero-pad correlativos, so `000001` cleared a six-character floor and
 * auto-confirmed a cash withdrawal against an unrelated deposit. The padding
 * carries no information, so it does not count toward the length.
 */
function isMeaningfulReference(reference: string | undefined): boolean {
  const significant = String(reference ?? '').trim().replace(/^0+/, '');
  return significant.length >= MIN_MEANINGFUL_REFERENCE;
}

/**
 * Evidence tier, for choosing between candidates.
 *
 * Ordering only — it never decides whether a pair is confirmed, which
 * {@link resolveConfidence} does on the evidence itself.
 */
function evidenceRank(evidence: Evidence): number {
  // Third-party wording is deliberately absent: this ranks candidates, and
  // flattening every candidate of a leg to the same tier is precisely what
  // `pickBest` reads as "indistinguishable". A matching nine-digit reference
  // was being discarded and the pair put to a coin flip against an unrelated
  // deposit. `resolveConfidence` still refuses to confirm it, which is the part
  // that was worth doing — in Chile, moving money to your own account at
  // another bank goes through the "a terceros" flow, so the wording is weak
  // evidence against, not proof.
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

/**
 * Bucket key for "these two amounts are the same money".
 *
 * The magnitude, normalised so a scale difference does not split a bucket:
 * `equals` in `core/money` compares values, not representations, and the index
 * has to agree with it or a legitimate pair silently stops being a candidate.
 */
function amountKey(scoped: ScopedTransaction): string {
  // Trailing fractional zeros are representation, not value: `200000` and
  // `200000.00` are the same money, and `equals` in `core/money` says so. The
  // key has to agree, or a legitimate pair lands in two buckets and stops being
  // a candidate with nothing to show for it. Same rule the fingerprints use.
  const magnitude = abs(scoped.transaction.amount);
  return `${magnitude.currency}:${canonicalAmountString(magnitude)}`;
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
