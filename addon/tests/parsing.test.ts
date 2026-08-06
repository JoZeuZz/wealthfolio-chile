import { describe, expect, it } from 'vitest';
import { detectHeader, mapColumns, normalizeHeader } from '../src/core/parsing/columns';
import {
  decodeText,
  detectDelimiter,
  detectFileKind,
  readDelimited,
  trimSheet,
} from '../src/core/parsing/tabular';
import { loadWorkbook } from '../src/core/parsing/workbook';
import { fromLatin1, fromText, loadFixture } from './fixtures';

describe('detectDelimiter', () => {
  it('prefers the semicolon over commas inside Chilean amounts', () => {
    const text = ['Fecha;Descripcion;Monto', '03/02/2026;COMPRA LIDER;1.234,56'].join('\n');
    expect(detectDelimiter(text)).toBe(';');
  });

  it('detects commas in a plain English export', () => {
    const text = ['Date,Description,Amount', '2026-02-03,GROCERIES,12.50'].join('\n');
    expect(detectDelimiter(text)).toBe(',');
  });

  it('detects tabs', () => {
    const text = ['Fecha\tDescripcion\tMonto', '03/02/2026\tCOMPRA\t1000'].join('\n');
    expect(detectDelimiter(text)).toBe('\t');
  });
});

describe('decodeText', () => {
  it('decodes UTF-8 with a BOM', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('Ñuñoa')]);
    expect(decodeText(bytes)).toEqual({ text: 'Ñuñoa', encoding: 'utf-8' });
  });

  it('falls back to Windows-1252 rather than corrupting accents', () => {
    const { text, encoding } = decodeText(fromLatin1('x.csv', 'DESCRIPCIÓN').bytes);
    expect(encoding).toBe('windows-1252');
    expect(text).toBe('DESCRIPCIÓN');
  });
});

describe('readDelimited', () => {
  it('honours quoted fields containing the delimiter', () => {
    const { sheet } = readDelimited('a;b\n"uno;dos";tres', 'x.csv', { delimiter: ';' });
    expect(sheet.rows[1]).toEqual(['uno;dos', 'tres']);
  });

  it('honours escaped double quotes', () => {
    const { sheet } = readDelimited('a\n"di ""hola"""', 'x.csv', { delimiter: ';' });
    expect(sheet.rows[1]).toEqual(['di "hola"']);
  });

  it('handles CRLF line endings', () => {
    const { sheet } = readDelimited('a;b\r\n1;2\r\n', 'x.csv', { delimiter: ';' });
    expect(sheet.rows).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('drops trailing blank rows', () => {
    const { sheet } = readDelimited('a;b\n1;2\n\n\n', 'x.csv', { delimiter: ';' });
    expect(sheet.rows).toHaveLength(2);
  });
});

describe('detectFileKind', () => {
  it('recognises a ZIP-based spreadsheet regardless of extension', () => {
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
    expect(detectFileKind({ name: 'cartola.xls', bytes })).toBe('xlsx');
  });

  it('recognises a legacy OLE2 workbook', () => {
    const bytes = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0]);
    expect(detectFileKind({ name: 'cartola.xls', bytes })).toBe('xls');
  });

  it('treats an .xls file that is really text as delimited', () => {
    expect(detectFileKind(fromText('cartola.xls', 'Fecha;Monto\n01/01/2026;100'))).toBe(
      'delimited',
    );
  });

  it('refuses PDF', () => {
    expect(detectFileKind(fromText('cartola.pdf', '%PDF-1.7'))).toBe('unsupported');
  });
});

describe('normalizeHeader', () => {
  it('folds accents, case and ordinal marks', () => {
    expect(normalizeHeader('N° Documento')).toBe('N DOCUMENTO');
    expect(normalizeHeader('Descripción')).toBe('DESCRIPCION');
    expect(normalizeHeader('  Monto  $ ')).toBe('MONTO $');
  });
});

describe('mapColumns', () => {
  it('maps a cargo/abono layout', () => {
    const map = mapColumns(['Fecha', 'Descripcion', 'Cargo', 'Abono', 'Saldo']);
    expect(map).toMatchObject({ date: 0, description: 1, debit: 2, credit: 3, balance: 4 });
  });

  it('maps a single signed amount column', () => {
    const map = mapColumns(['Fecha', 'Detalle', 'Monto']);
    expect(map).toMatchObject({ date: 0, description: 1, amount: 2 });
  });

  it('never assigns the same column to two roles', () => {
    const map = mapColumns(['Fecha', 'Fecha Contable', 'Glosa', 'Monto']);
    const indexes = Object.values(map);
    expect(new Set(indexes).size).toBe(indexes.length);
  });
});

describe('detectHeader', () => {
  it('finds a header buried under preamble rows', () => {
    const { sheet } = readDelimited(
      ['Banco X', 'Titular: alguien', '', 'Fecha;Descripcion;Monto', '01/02/2026;COMPRA;100'].join(
        '\n',
      ),
      'x.csv',
      { delimiter: ';' },
    );
    const detection = detectHeader(trimSheet(sheet));
    expect(detection.headerRow).toBe(3);
    expect(detection.firstDataRow).toBe(4);
  });

  it('reports -1 when no plausible header exists', () => {
    const { sheet } = readDelimited('sin;cabecera\nutil;alguna', 'x.csv', { delimiter: ';' });
    expect(detectHeader(sheet).headerRow).toBe(-1);
  });
});

describe('loadWorkbook', () => {
  it('loads every synthetic fixture as a single sheet', () => {
    for (const name of [
      'banco-chile-cuenta-corriente.csv',
      'banco-estado-cuentarut.csv',
      'falabella-cmr.csv',
    ]) {
      const workbook = loadWorkbook(loadFixture(name));
      expect(workbook.sheets).toHaveLength(1);
      expect(workbook.sheets[0]!.rows.length).toBeGreaterThan(5);
    }
  });

  it('refuses a PDF with an actionable message', () => {
    expect(() => loadWorkbook(fromText('cartola.pdf', '%PDF-1.7 blah'))).toThrow(/CSV o XLSX/);
  });
});
