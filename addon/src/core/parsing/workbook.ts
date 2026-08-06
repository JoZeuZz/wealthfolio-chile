import * as XLSX from 'xlsx';
import {
  decodeText,
  detectFileKind,
  ParseError,
  readDelimited,
  trimSheet,
  type FileKind,
  type Sheet,
  type SourceFile,
} from './tabular';

/**
 * Turns any supported file into sheets.
 *
 * Spreadsheet decoding uses SheetJS from its official distribution rather than
 * the npm `xlsx` package, which has been frozen at 0.18.5 with open advisories;
 * see docs/adr/0004-spreadsheet-library.md. SheetJS also reads legacy BIFF
 * `.xls`, which is why this project can accept the format at all.
 */
export interface LoadedWorkbook {
  kind: FileKind;
  sheets: Sheet[];
  /** Encoding used for text sources; undefined for spreadsheets. */
  encoding?: string;
  /** Delimiter used for text sources. */
  delimiter?: string;
}

export function loadWorkbook(file: SourceFile): LoadedWorkbook {
  const kind = detectFileKind(file);

  if (kind === 'unsupported') {
    throw new ParseError(
      `No se puede leer "${file.name}". Exporta la cartola como CSV o XLSX desde el sitio del banco.`,
      'unsupported-file',
    );
  }

  if (kind === 'xlsx' || kind === 'xls') {
    return { kind, sheets: readSpreadsheet(file) };
  }

  const { text, encoding } = decodeText(file.bytes);
  const { sheet, delimiter } = readDelimited(text, file.name);
  return { kind, sheets: [trimSheet(sheet)], encoding, delimiter };
}

function readSpreadsheet(file: SourceFile): Sheet[] {
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(file.bytes, {
      type: 'array',
      // Dates arrive as text so a single code path handles every source; the
      // date parser in `core/dates` is stricter than SheetJS's coercion and is
      // the only place allowed to decide what "03/02" means.
      raw: false,
      cellDates: false,
      cellText: true,
      cellNF: false,
      // Formulas and styles are irrelevant to a statement and only widen the
      // attack surface of a file that came from a browser download.
      cellFormula: false,
      cellStyles: false,
      bookVBA: false,
    });
  } catch (error) {
    throw new ParseError(
      `No se pudo abrir la planilla "${file.name}": ${(error as Error).message}`,
      'spreadsheet-read-failed',
    );
  }

  const sheets: Sheet[] = [];
  for (const name of workbook.SheetNames) {
    const worksheet = workbook.Sheets[name];
    if (!worksheet) continue;
    const rows = XLSX.utils.sheet_to_json<string[]>(worksheet, {
      header: 1,
      raw: false,
      defval: '',
      blankrows: true,
    });
    sheets.push(
      trimSheet({
        name,
        rows: rows.map((row) => (Array.isArray(row) ? row.map(toCellText) : [])),
      }),
    );
  }

  if (sheets.length === 0) {
    throw new ParseError(`La planilla "${file.name}" no tiene hojas.`, 'empty-workbook');
  }
  return sheets;
}

function toCellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

/**
 * Pick the sheet that actually holds the movements.
 *
 * Bank workbooks routinely ship a cover sheet plus the data; the widest sheet
 * with the most rows is the data one in every layout seen so far.
 */
export function pickDataSheet(sheets: readonly Sheet[]): Sheet {
  if (sheets.length === 0) throw new ParseError('archivo sin hojas', 'empty-workbook');
  let best = sheets[0] as Sheet;
  let bestScore = -1;
  for (const sheet of sheets) {
    const width = Math.max(0, ...sheet.rows.map((r) => r.length));
    const score = sheet.rows.length * width;
    if (score > bestScore) {
      bestScore = score;
      best = sheet;
    }
  }
  return best;
}
