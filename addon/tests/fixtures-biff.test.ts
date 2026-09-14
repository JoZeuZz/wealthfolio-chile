import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { detectFileKind } from '../src/core/parsing/tabular';
import { fromXlsCells, fromXlsxCells } from './fixtures';

/**
 * Pins that `fromXlsCells` writes a real BIFF/OLE2 container, not an OOXML
 * one with a `.xls` name slapped on it.
 *
 * Re-review found that every "XLS" test in this project actually called
 * `fromXlsxRows`/`fromXlsxCells` — both hardcode `bookType: 'xlsx'` — and
 * only changed the fixture's filename to end in `.xls`. `detectFileKind`
 * reads the magic bytes, not the extension, so those files were read back as
 * `xlsx` and the BIFF path was never exercised at all, in this project's
 * source code or in its own tests. This pins the actual container bytes so
 * that claim can never regress silently again.
 */
describe('fromXlsCells — real BIFF/OLE2 bytes, not an XLSX file wearing a .xls name', () => {
  it('writes the OLE2 compound-document magic (D0 CF 11 E0), never the ZIP one (PK)', () => {
    const file = fromXlsCells('cartola.xls', [['Monto'], [{ value: 12450, numberFormat: '#,##0' }]]);
    expect([...file.bytes.slice(0, 4)]).toEqual([0xd0, 0xcf, 0x11, 0xe0]);
  });

  it('detectFileKind reads it back as xls from the bytes, matching the filename', () => {
    const file = fromXlsCells('cartola.xls', [['Monto'], [{ value: 12450, numberFormat: '#,##0' }]]);
    expect(detectFileKind(file)).toBe('xls');
  });

  it('fromXlsxCells, by contrast, writes ZIP/OOXML bytes even when named .xls — the bug this fixture exists to stop hiding', () => {
    const file = fromXlsxCells('cartola-que-dice-xls-pero-es-xlsx.xls', [['Monto'], [{ value: 12450 }]]);
    expect([...file.bytes.slice(0, 2)]).toEqual([0x50, 0x4b]);
    expect(detectFileKind(file)).toBe('xlsx');
  });

  it('round trip through SheetJS preserves native type and number format under BIFF', () => {
    const file = fromXlsCells('cartola.xls', [
      ['Fecha', 'Monto'],
      ['05/02/2026', { value: 12450, numberFormat: '#,##0' }],
    ]);
    const workbook = XLSX.read(file.bytes, { type: 'array', cellNF: true, cellText: false });
    const sheet = workbook.Sheets[workbook.SheetNames[0] as string];
    const cell = sheet?.['B2'] as { t?: string; z?: string; v?: unknown } | undefined;

    expect(cell?.t).toBe('n');
    expect(cell?.z).toBe('#,##0');
    expect(cell?.v).toBe(12450);
  });
});
