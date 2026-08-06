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
  matches: TransferMatch[];
  /** Fingerprints that ended up in a match, for quick lookup. */
  matchedFingerprints: Set<string>;
}

/** Words that make a movement look like a transfer rather than a purchase. */
const TRANSFER_MARKERS = [
  'TRANSFERENCIA',
  'TRASPASO',
  'TRANSF ',
  'TEF ',
  'ABONO TRANSFERENCIA',
  'CARGO TRANSFERENCIA',
  'A TERCEROS',
  'ENTRE CUENTAS',
  'CUENTA PROPIA',
];

const OWN_ACCOUNT_MARKERS = ['CUENTA PROPIA', 'ENTRE CUENTAS', 'MIS CUENTAS', 'TRASPASO'];

/**
 * Pair transfer legs across accounts.
 *
 * Runs over the union of newly parsed rows and recent history, so a transfer
 * whose legs arrive in two separate imports still matches when the second file
 * is loaded.
 */
export function matchTransfers(
  scoped: readonly ScopedTransaction[],
  options: TransferMatchOptions = {},
): TransferMatchResult {
  const { windowDays, confirmWindowDays } = { ...DEFAULTS, ...options };

  const outflows = scoped.filter((s) => s.transaction.direction === Direction.out);
  const inflows = scoped.filter((s) => s.transaction.direction === Direction.in);

  const matches: TransferMatch[] = [];
  const used = new Set<string>();

  // Deterministic order: same input always yields the same pairing, which
  // matters because the user's decisions are stored against these pairs.
  const sortedOutflows = [...outflows].sort(byDateThenFingerprint);

  for (const outflow of sortedOutflows) {
    if (used.has(key(outflow))) continue;

    const candidates = inflows
      .filter((inflow) => !used.has(key(inflow)))
      .filter((inflow) => inflow.accountId !== outflow.accountId)
      .filter((inflow) => equals(abs(inflow.transaction.amount), abs(outflow.transaction.amount)))
      .filter(
        (inflow) =>
          Math.abs(daysBetween(outflow.transaction.date, inflow.transaction.date)) <= windowDays,
      )
      .sort((a, b) => {
        const gapA = Math.abs(daysBetween(outflow.transaction.date, a.transaction.date));
        const gapB = Math.abs(daysBetween(outflow.transaction.date, b.transaction.date));
        return gapA - gapB || compareKeys(a, b);
      });

    // More than one equally plausible counterpart means the engine cannot tell
    // which is which; the whole group is left for the user rather than guessing.
    const best = candidates[0];
    if (!best) continue;

    const gapDays = Math.abs(daysBetween(outflow.transaction.date, best.transaction.date));
    const ambiguous = candidates.length > 1 &&
      Math.abs(daysBetween(outflow.transaction.date, (candidates[1] as ScopedTransaction).transaction.date)) === gapDays;

    const evidence = scoreEvidence(outflow, best);
    const confidence = resolveConfidence({
      gapDays,
      confirmWindowDays,
      evidence,
      ambiguous,
    });

    matches.push({
      outflow,
      inflow: best,
      confidence,
      gapDays,
      reason: buildReason({ gapDays, evidence, ambiguous }),
    });

    used.add(key(outflow));
    used.add(key(best));
  }

  return {
    matches,
    matchedFingerprints: new Set(
      matches.flatMap((m) => [m.outflow.transaction.fingerprint, m.inflow.transaction.fingerprint]),
    ),
  };
}

interface Evidence {
  /** Either description names a transfer. */
  transferWording: boolean;
  /** Wording explicitly says the counterpart is the user's own account. */
  ownAccountWording: boolean;
  /** One description mentions the other leg's institution. */
  institutionMentioned: boolean;
  /** Same bank reference on both legs. */
  sharedReference: boolean;
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

  const sharedReference =
    !!outflow.transaction.reference &&
    outflow.transaction.reference === inflow.transaction.reference;

  return { transferWording, ownAccountWording, institutionMentioned, sharedReference };
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
  ambiguous: boolean;
}

/**
 * Only a same-or-next-day pair with explicit transfer wording is confirmed on
 * its own. Everything else is a suggestion.
 */
function resolveConfidence(input: ConfidenceInput): Confidence {
  const { gapDays, confirmWindowDays, evidence, ambiguous } = input;
  if (ambiguous) return Confidence.suggested;

  const strong =
    evidence.sharedReference ||
    (evidence.transferWording && (evidence.ownAccountWording || evidence.institutionMentioned));

  if (strong && gapDays <= confirmWindowDays) return Confidence.confirmed;
  return Confidence.suggested;
}

function buildReason(input: { gapDays: number; evidence: Evidence; ambiguous: boolean }): string {
  const parts: string[] = [];
  parts.push(
    input.gapDays === 0 ? 'Mismo día' : `${input.gapDays} día(s) de diferencia`,
  );
  parts.push('mismo monto en cuentas distintas');
  if (input.evidence.sharedReference) parts.push('misma referencia bancaria');
  if (input.evidence.transferWording) parts.push('la glosa menciona una transferencia');
  if (input.evidence.ownAccountWording) parts.push('la glosa indica cuenta propia');
  if (input.evidence.institutionMentioned) parts.push('la glosa nombra al otro banco');
  if (input.ambiguous) parts.push('hay más de un candidato igual de probable');
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
