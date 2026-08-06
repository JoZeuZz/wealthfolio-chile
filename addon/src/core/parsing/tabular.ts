/**
 * File-shape readers.
 *
 * Everything above this layer works on a `Sheet`: a rectangular grid of already
 * decoded strings. CSV, semicolon-delimited TXT, XLSX and legacy XLS all reduce
 * to the same shape, so a bank adapter never needs to know which container its
 * data arrived in — only which columns it wants.
 */

/** A decoded rectangular grid. Cells are trimmed strings; absent cells are ''. */
export interface Sheet {
  /** Sheet name for spreadsheet sources; the file name for text sources. */
  name: string;
  rows: string[][];
}

export interface SourceFile {
  name: string;
  bytes: Uint8Array;
}

export type FileKind = 'csv' | 'delimited' | 'xlsx' | 'xls' | 'unsupported';

export class ParseError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'ParseError';
  }
}

/**
 * Classify a file by magic bytes first, extension second.
 *
 * Extensions lie constantly in this domain: banks serve `.xls` files that are
 * really HTML tables or tab-separated text, so the content gets the final say.
 */
export function detectFileKind(file: SourceFile): FileKind {
  const { bytes, name } = file;
  const extension = name.toLowerCase().split('.').pop() ?? '';

  // XLSX and every other OOXML file is a ZIP archive: "PK\x03\x04".
  if (bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b) return 'xlsx';

  // Legacy BIFF / OLE2 compound document: D0 CF 11 E0 A1 B1 1A E1.
  if (
    bytes.length > 8 &&
    bytes[0] === 0xd0 &&
    bytes[1] === 0xcf &&
    bytes[2] === 0x11 &&
    bytes[3] === 0xe0
  ) {
    return 'xls';
  }

  if (extension === 'csv') return 'csv';
  if (extension === 'txt' || extension === 'tsv') return 'delimited';
  // A file claiming to be a spreadsheet whose bytes say otherwise is text.
  if (extension === 'xls' || extension === 'xlsx') return 'delimited';
  if (extension === 'pdf') return 'unsupported';

  return looksLikeText(bytes) ? 'delimited' : 'unsupported';
}

function looksLikeText(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, Math.min(512, bytes.length));
  let control = 0;
  for (const b of sample) {
    if (b === 0) return false;
    if (b < 9 || (b > 13 && b < 32)) control += 1;
  }
  return control / Math.max(1, sample.length) < 0.05;
}

/** Text encodings seen in Chilean bank exports. */
export type TextEncoding = 'utf-8' | 'windows-1252';

/**
 * Decode bytes to text, honouring a BOM and falling back to Latin-1.
 *
 * Chilean banks still emit Windows-1252, so a strict UTF-8 decode would turn
 * every `Ñ` and `ó` into replacement characters — which silently corrupts
 * merchant names and therefore every downstream match.
 */
export function decodeText(bytes: Uint8Array): { text: string; encoding: TextEncoding } {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'utf-8' };
  }

  const strict = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  if (!strict.includes('\ufffd')) return { text: strict, encoding: 'utf-8' };

  return { text: new TextDecoder('windows-1252').decode(bytes), encoding: 'windows-1252' };
}

const DELIMITERS = [';', ',', '\t', '|'] as const;
export type Delimiter = (typeof DELIMITERS)[number];

/**
 * Pick the delimiter by consistency, not by frequency.
 *
 * The winner is the candidate that yields the same column count on the most
 * lines. Counting raw occurrences instead would pick `,` for a semicolon file
 * full of `1.234,56` amounts — the single most common way to mis-parse a
 * Chilean statement.
 */
export function detectDelimiter(text: string): Delimiter {
  const lines = text
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
    .slice(0, 40);
  if (lines.length === 0) return ';';

  let best: Delimiter = ';';
  let bestScore = -1;

  for (const delimiter of DELIMITERS) {
    const counts = lines.map((line) => splitDelimitedLine(line, delimiter).length);
    const withFields = counts.filter((c) => c > 1);
    if (withFields.length === 0) continue;

    const frequency = new Map<number, number>();
    for (const c of withFields) frequency.set(c, (frequency.get(c) ?? 0) + 1);

    let modeCount = 0;
    let modeColumns = 0;
    for (const [columns, count] of frequency) {
      if (count > modeCount || (count === modeCount && columns > modeColumns)) {
        modeCount = count;
        modeColumns = columns;
      }
    }

    // Consistency dominates; column count only breaks ties.
    const score = modeCount * 1000 + modeColumns;
    if (score > bestScore) {
      bestScore = score;
      best = delimiter;
    }
  }

  return best;
}

/** Split one line, honouring RFC 4180 double quoting. */
export function splitDelimitedLine(line: string, delimiter: string): string[] {
  const fields: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === delimiter) {
      fields.push(field);
      field = '';
    } else {
      field += ch;
    }
  }
  fields.push(field);
  return fields;
}

export interface ReadDelimitedOptions {
  delimiter?: Delimiter;
  /** Maximum rows to read. Guards the UI against a pathological file. */
  maxRows?: number;
}

export const MAX_ROWS = 100_000;

/**
 * Read delimited text into a `Sheet`.
 *
 * Quoted fields may span lines, so the reader consumes the text as a stream of
 * characters rather than splitting on newlines first.
 */
export function readDelimited(
  text: string,
  name: string,
  options: ReadDelimitedOptions = {},
): { sheet: Sheet; delimiter: Delimiter } {
  const delimiter = options.delimiter ?? detectDelimiter(text);
  const maxRows = options.maxRows ?? MAX_ROWS;

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  const endField = () => {
    row.push(field.trim());
    field = '';
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  const body = text.replace(/^\ufeff/, '');

  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i] as string;

    if (quoted) {
      if (ch === '"') {
        if (body[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      quoted = true;
    } else if (ch === delimiter) {
      endField();
    } else if (ch === '\n') {
      endRow();
      if (rows.length >= maxRows) break;
    } else if (ch !== '\r') {
      field += ch;
    }
  }

  if (field !== '' || row.length > 0) endRow();

  return { sheet: { name, rows: dropTrailingBlankRows(rows) }, delimiter };
}

function dropTrailingBlankRows(rows: string[][]): string[][] {
  let end = rows.length;
  while (end > 0 && isBlankRow(rows[end - 1] as string[])) end -= 1;
  return rows.slice(0, end);
}

export function isBlankRow(row: readonly string[]): boolean {
  return row.every((cell) => cell.trim() === '');
}

/** Index of the first non-blank row at or after `from`. */
export function firstContentRow(rows: readonly string[][], from = 0): number {
  for (let i = from; i < rows.length; i += 1) {
    if (!isBlankRow(rows[i] as string[])) return i;
  }
  return -1;
}

/** Trim the grid to its used width so ragged exports do not create phantom columns. */
export function trimSheet(sheet: Sheet): Sheet {
  let width = 0;
  for (const row of sheet.rows) {
    for (let i = row.length - 1; i >= 0; i -= 1) {
      if ((row[i] ?? '').trim() !== '') {
        width = Math.max(width, i + 1);
        break;
      }
    }
  }
  return {
    name: sheet.name,
    rows: sheet.rows.map((row) =>
      Array.from({ length: width }, (_, i) => (row[i] ?? '').trim()),
    ),
  };
}
