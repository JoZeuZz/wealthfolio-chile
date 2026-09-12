import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as XLSX from 'xlsx';
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

/**
 * Resolved lazily.
 *
 * At module scope this ran under every environment that imports the file,
 * including the DOM one the React tests use, where `import.meta.url` is not a
 * `file:` URL and `fileURLToPath` throws before a single test collects.
 */
function syntheticDir(): string {
  return fileURLToPath(new URL('../../samples/synthetic/', import.meta.url));
}

export function loadFixture(name: string): SourceFile {
  const bytes = new Uint8Array(readFileSync(`${syntheticDir()}${name}`));
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

/**
 * An in-memory XLSX built from literal cell text, string-typed throughout.
 *
 * `loadWorkbook` reads spreadsheet cells with `cellText: true, raw: false`, so
 * a string-typed cell comes back exactly as written here — no numeral
 * reformatting, no locale guessing. That is what makes this the right tool
 * for pinning a real spreadsheet's numeral quirks (e.g. a comma thousands
 * separator in one column and a dot in another) without committing a binary
 * fixture: the test builds the bytes itself, on every run, from a plain
 * array of rows.
 */
export function fromXlsxRows(name: string, rows: readonly (readonly string[])[]): SourceFile {
  const sheet = XLSX.utils.aoa_to_sheet(rows as string[][]);
  for (const address of Object.keys(sheet)) {
    if (address.startsWith('!')) continue;
    const c = sheet[address] as { t?: string; v?: unknown; w?: string };
    if (c && c.v !== undefined && c.v !== null) {
      c.t = 's';
      c.v = String(c.v);
      delete c.w;
    }
  }
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Movimientos');
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  return { name, bytes: new Uint8Array(buffer) };
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
