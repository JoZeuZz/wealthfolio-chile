import * as XLSX from 'xlsx';
import { detectFileKind, type SourceFile } from './tabular';
import {
  classifyNativeCellType,
  classifyNumberFormatCode,
  type NativeCellType,
  type NumberFormatShape,
} from './spreadsheet-format';

/**
 * Reads only a spreadsheet's cell *format metadata* — never a cell's value.
 *
 * This is a second, independent SheetJS read of the same bytes, scoped to
 * `src/tooling`'s calibration report. It shares nothing with
 * `core/parsing/workbook.ts#loadWorkbook`, which is the actual financial
 * parser's read path (`raw: false, cellText: true, cellNF: false` — chosen so
 * every source reduces to the same string grid, see that file's own comment).
 * Keeping this call fully separate means it can enable `cellNF` to recover
 * `CellObject.z` (Excel's own number-format code) without the smallest risk
 * of changing what the financial parser reads from a real cartola.
 */

export interface SpreadsheetCellFormat {
  nativeType: NativeCellType;
  numberFormatShape: NumberFormatShape;
}

export interface SpreadsheetSheetFormats {
  name: string;
  container: 'xls' | 'xlsx';
  /** Row/column-indexed exactly like `Sheet.rows` before trimming. */
  cells: (SpreadsheetCellFormat | undefined)[][];
}

/** `undefined` for a non-spreadsheet source (CSV/TXT) or an unreadable one. */
export function readSpreadsheetCellFormats(file: SourceFile): SpreadsheetSheetFormats[] | undefined {
  const kind = detectFileKind(file);
  if (kind !== 'xlsx' && kind !== 'xls') return undefined;

  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(file.bytes, {
      type: 'array',
      cellNF: true,
      cellText: false,
      cellDates: false,
      cellFormula: false,
      cellStyles: false,
      bookVBA: false,
    });
  } catch {
    return undefined;
  }

  const sheets: SpreadsheetSheetFormats[] = [];
  for (const name of workbook.SheetNames) {
    const worksheet = workbook.Sheets[name];
    const ref = worksheet?.['!ref'];
    if (!worksheet || !ref) continue;

    const range = XLSX.utils.decode_range(ref);
    const cells: (SpreadsheetCellFormat | undefined)[][] = [];
    for (let r = range.s.r; r <= range.e.r; r += 1) {
      const row: (SpreadsheetCellFormat | undefined)[] = [];
      for (let c = range.s.c; c <= range.e.c; c += 1) {
        const raw = worksheet[XLSX.utils.encode_cell({ r, c })] as
          | { t?: string; z?: string; v?: unknown }
          | undefined;
        // `aoa_to_sheet` writes a real cell object for `''` too (`t: 's', v: ''`),
        // which is not a value at all — treated the same as no cell object, so a
        // blank column reads as `blank` here exactly like `isBlankRow` elsewhere
        // treats an empty trimmed string.
        const hasValue = raw !== undefined && raw.v !== undefined && raw.v !== null && raw.v !== '';
        row.push(
          hasValue
            ? {
                nativeType: classifyNativeCellType(raw!.t),
                numberFormatShape: classifyNumberFormatCode(raw!.z),
              }
            : undefined,
        );
      }
      cells.push(row);
    }
    sheets.push({ name, container: kind, cells });
  }
  return sheets;
}
