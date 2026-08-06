import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { SourceFile } from '../src/core/parsing/tabular';

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
