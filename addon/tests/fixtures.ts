import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { money } from '../src/core/money';
import { Confidence, Direction, TransactionKind } from '../src/core/model/kinds';
import type { NormalizedTransaction } from '../src/core/model/transaction';
import type { SourceFile } from '../src/core/parsing/tabular';
import { normalizeDescription } from '../src/core/text';

/**
 * Test fixtures.
 *
 * Every fixture is synthetic: invented account numbers, invented merchants,
 * invented amounts. Real cartolas live in `samples/private/`, which is
 * git-ignored and never read from a test — see docs/PRIVACY.md.
 */

const SYNTHETIC_DIR = fileURLToPath(new URL('../../samples/synthetic/', import.meta.url));

export function loadFixture(name: string): SourceFile {
  const bytes = new Uint8Array(readFileSync(`${SYNTHETIC_DIR}${name}`));
  return { name, bytes };
}

export function fromText(name: string, text: string): SourceFile {
  return { name, bytes: new TextEncoder().encode(text) };
}

/** Encode text as Windows-1252, to exercise the legacy-encoding path. */
export function fromLatin1(name: string, text: string): SourceFile {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) bytes[i] = text.charCodeAt(i) & 0xff;
  return { name, bytes };
}

let txCounter = 0;

export type TransactionOverrides = Partial<Omit<NormalizedTransaction, 'amount'>> & {
  /** Signed minor units at scale 0, e.g. `-85400`. */
  amount: number;
  date: string;
};

/**
 * A canonical transaction with sane defaults.
 *
 * The sign of `amount` drives `direction` and the default `kind`, which is the
 * same invariant the parsers uphold, so a test that overrides only the amount
 * still gets a coherent row.
 */
export function makeTransaction(overrides: TransactionOverrides): NormalizedTransaction {
  txCounter += 1;
  const { amount: amountValue, ...rest } = overrides;
  const amount = money(amountValue, 0, 'CLP');
  const description = overrides.description ?? 'MOVIMIENTO';

  return {
    sourceInstitution: 'banco-chile',
    sourceParser: 'banco-chile.cartola-csv',
    sourceParserVersion: '1.0.0',
    sourceFileHash: 'file-hash',
    fingerprint: `fp-${txCounter}`,
    description,
    normalizedDescription: normalizeDescription(description),
    amount,
    direction: amount.minor < 0 ? Direction.out : Direction.in,
    kind: amount.minor < 0 ? TransactionKind.expense : TransactionKind.income,
    kindConfidence: Confidence.confirmed,
    tags: [],
    warnings: [],
    rawMetadata: {},
    ...rest,
  } as NormalizedTransaction;
}
