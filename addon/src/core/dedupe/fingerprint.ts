import { hashFields } from '../hash';
import { canonicalAmountString, toDecimalString, type Money } from '../money';
import type { NormalizedTransaction } from '../model/transaction';
import { descriptionKey } from '../text';

/**
 * Deterministic transaction identity.
 *
 * Importing the same cartola twice must produce zero new movements. Since most
 * Chilean exports carry no transaction id, identity has to be derived from
 * content — and derived the *same way every time*, including across app
 * versions, machines and re-parses of the same file.
 *
 * The fingerprint therefore uses only fields a bank cannot change between two
 * exports of the same period: account, date, exact amount, normalised
 * description and the bank reference. Anything volatile (row number, file name,
 * running balance, our own classification) is excluded on purpose — including
 * them would make the same movement look new after a re-download.
 *
 * The amount goes in through `canonicalAmountString`, not `toDecimalString`.
 * The latter encodes the scale, which is a fact about the export's formatting
 * and not about the money: the same period re-exported with `1.234,00` instead
 * of `1.234` hashed differently in *both* fingerprints, came back `nuevo`
 * rather than even `probable`, and was written a second time in full with every
 * row ticked. For a CLP amount with no fraction the two spellings are already
 * identical, so hashes written by 0.1.x keep matching.
 */

/** Bumped only when the fingerprint recipe changes; old rows keep their hash. */
export const FINGERPRINT_VERSION = 'v1';

export interface FingerprintScope {
  /**
   * Wealthfolio account id the row will be imported into.
   *
   * Identity is scoped to the account so the same $10.000 on the same day in
   * two different accounts stays two movements.
   */
  accountId: string;
}

/**
 * Content hash of a transaction, scoped to a target account.
 *
 * Stable across: re-downloading the file, re-running the parser, changing the
 * category, or reordering rows.
 */
export function computeFingerprint(
  transaction: NormalizedTransaction,
  scope: FingerprintScope,
): string {
  return hashFields([
    FINGERPRINT_VERSION,
    scope.accountId,
    transaction.date,
    canonicalAmountString(transaction.amount),
    transaction.amount.currency,
    // The aggressive key absorbs the formatting drift banks introduce between
    // exports (extra spaces, changing card tails) while keeping the merchant.
    descriptionKey(transaction.description),
    transaction.reference ?? '',
    // Real CMR Banco Falabella statements (2026-09): a billed cuota's own
    // `date` does not advance between statement cycles, so without this an
    // open plan's second charge hashes identically to its first — same date,
    // same amount, same glosa — and reimporting the next cycle would silently
    // drop it as an exact duplicate. Appended only when the field is present,
    // so every fingerprint computed before this field existed is unchanged:
    // no version bump, no legacy dual-hash, because nothing that shipped ever
    // produced this field before now.
    ...(transaction.installmentRemaining !== undefined
      ? [String(transaction.installmentRemaining)]
      : []),
  ]);
}

/**
 * A weaker hash used to find *probable* duplicates.
 *
 * Drops the description entirely, so it groups movements that agree on account,
 * day and amount. Two of those are usually the same movement described
 * differently by two exports — but they are equally often two genuine identical
 * charges, which is why this never auto-skips anything.
 */
export function computeWeakFingerprint(
  transaction: NormalizedTransaction,
  scope: FingerprintScope,
): string {
  return weakFingerprintOf({
    accountId: scope.accountId,
    date: transaction.date,
    amount: transaction.amount,
  });
}

/**
 * The same weak hash, from the fields alone.
 *
 * A stored Wealthfolio activity has an account, a day and a signed amount, but
 * it is not a `NormalizedTransaction` and it may not be one of ours at all.
 * Deriving the hash from the parts is what lets the duplicate index cover
 * movements this addon never wrote — a row entered by hand, or imported with
 * Wealthfolio's own CSV importer — instead of only the ones carrying our
 * metadata.
 */
export function weakFingerprintOf(movement: {
  accountId: string;
  date: string;
  amount: Money;
}): string {
  return hashFields([
    FINGERPRINT_VERSION,
    'weak',
    movement.accountId,
    movement.date,
    canonicalAmountString(movement.amount),
    movement.amount.currency,
  ]);
}

/**
 * The fingerprints a movement would have had under 0.1.x.
 *
 * 0.1.x hashed `toDecimalString`, which carries the scale, so a movement parsed
 * from `49.990,50` is stored in the user's ledger under `…"49990.50"…` while
 * the current recipe hashes `…"49990.5"…`. For an amount with no fraction the
 * two spellings are identical and this returns the same hashes as
 * {@link computeFingerprint} — which is why the change looked harmless.
 *
 * It was not: every row of every statement that prints cents came back `nuevo`,
 * ticked by default, and imported a second time. The index therefore accepts
 * both spellings rather than the version being bumped, because bumping it would
 * orphan the whole existing ledger instead of just the fractional part of it.
 */
export function legacyFingerprintsOf(
  transaction: NormalizedTransaction,
  scope: FingerprintScope,
): { fingerprint: string; weakFingerprint: string } | undefined {
  const canonical = canonicalAmountString(transaction.amount);
  const legacyText = toDecimalString(transaction.amount);
  if (legacyText === canonical) return undefined;

  return {
    fingerprint: hashFields([
      FINGERPRINT_VERSION,
      scope.accountId,
      transaction.date,
      legacyText,
      transaction.amount.currency,
      descriptionKey(transaction.description),
      transaction.reference ?? '',
    ]),
    weakFingerprint: hashFields([
      FINGERPRINT_VERSION,
      'weak',
      scope.accountId,
      transaction.date,
      legacyText,
      transaction.amount.currency,
    ]),
  };
}

/** Assign fingerprints to a batch of freshly parsed rows. */
export function withFingerprints(
  transactions: readonly NormalizedTransaction[],
  scope: FingerprintScope,
): NormalizedTransaction[] {
  return transactions.map((transaction) => ({
    ...transaction,
    fingerprint: computeFingerprint(transaction, scope),
  }));
}

/** SHA-256 of the source file, recorded in the import history. */
export { sha256Hex as computeFileHash } from '../hash';
