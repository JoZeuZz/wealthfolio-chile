import { describe, expect, it } from 'vitest';
import { readSpreadsheetCellFormats } from '../src/core/parsing/spreadsheet-cell-facts';
import { fromXlsxCells, fromText } from './fixtures';

/**
 * Lectura de metadatos NATIVOS de celda (tipo, formato numérico de Excel),
 * nunca el valor. Independiente de `loadWorkbook`/`readSpreadsheet`: una
 * segunda lectura de SheetJS con sus propias opciones, para que esta
 * instrumentación de calibración no pueda cambiar cómo el parser financiero
 * interpreta una celda.
 */

describe('readSpreadsheetCellFormats', () => {
  it('lee tipo nativo y forma de formato de una celda numérica agrupada', () => {
    const file = fromXlsxCells('cartola.xlsx', [
      ['Monto ($)'],
      [{ value: 12450, numberFormat: '#,##0' }],
    ]);

    const sheets = readSpreadsheetCellFormats(file);
    const cell = sheets?.[0]?.cells[1]?.[0];

    expect(cell).toEqual({ nativeType: 'number', numberFormatShape: 'grouped-integer' });
    expect(sheets?.[0]?.container).toBe('xlsx');
  });

  it('celda de texto se lee como string, no como número', () => {
    const file = fromXlsxCells('cartola.xlsx', [['Monto ($)'], ['12.450']]);

    const sheets = readSpreadsheetCellFormats(file);
    const cell = sheets?.[0]?.cells[1]?.[0];

    expect(cell?.nativeType).toBe('string');
  });

  it('celda vacía no produce metadato', () => {
    const file = fromXlsxCells('cartola.xlsx', [['Monto ($)'], ['']]);

    const sheets = readSpreadsheetCellFormats(file);
    const cell = sheets?.[0]?.cells[1]?.[0];

    expect(cell).toBeUndefined();
  });

  it('un archivo CSV/TXT no produce metadatos de celda', () => {
    const file = fromText('cartola.csv', 'Fecha;Monto\n03/02/2026;45.000\n');

    expect(readSpreadsheetCellFormats(file)).toBeUndefined();
  });

  it('formato de tres decimales se distingue del entero agrupado', () => {
    const file = fromXlsxCells('cartola.xlsx', [
      ['Monto ($)'],
      [{ value: 12450, numberFormat: '0.000' }],
    ]);

    const sheets = readSpreadsheetCellFormats(file);
    expect(sheets?.[0]?.cells[1]?.[0]?.numberFormatShape).toBe('decimal-3');
  });
});
