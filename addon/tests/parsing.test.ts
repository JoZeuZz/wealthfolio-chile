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
import { buildDuplicateIndex } from '../src/core/dedupe/classify';
import { Direction, TransactionKind } from '../src/core/model/kinds';
import { prepareImport } from '../src/core/pipeline';
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

/**
 * El signo de una fila: quién decide y en qué orden.
 *
 * Tres fuentes pueden decirlo, y estaban mal ordenadas:
 *
 * 1. Un marcador en la propia celda (`80.000 CR`). Se reconocía y se tiraba.
 * 2. Una columna de dirección (`D/C`, `Cargo/Abono`). Su vocabulario estaba
 *    codificado en una sola tabla que trataba `C` como cargo — cierto bajo una
 *    cabecera `Cargo/Abono`, falso bajo una `D/C`, donde `C` es Crédito. Con una
 *    sola tabla, una de las dos lecturas está garantizadamente equivocada.
 * 3. El `amountSign` del perfil, que es el default y sólo eso.
 */
describe('quién decide el signo de una fila', () => {
  function cardRows(rows: string[]) {
    return prepareImport({
      file: fromText(
        'estado-cuenta.csv',
        ['Fecha;Descripcion;Monto;Cuotas', ...rows].join('\n'),
      ),
      accountId: 'acc-card',
      parserId: 'generico.tarjeta',
      rules: [],
      duplicateIndex: buildDuplicateIndex([]),
    }).rows;
  }

  it('un sufijo de abono gana al amountSign del perfil', () => {
    // `generico.tarjeta` es `debit-positive`: sin esto, un pago recibido de
    // 80.000 se guardaba como una compra de 80.000.
    const rows = cardRows([
      '05/02/2026;COMPRA SUPERMERCADO;35.000;',
      '13/02/2026;PAGO RECIBIDO GRACIAS;80.000 CR;',
    ]);

    expect(rows[1]?.transaction.amount.minor).toBe(80000);
    expect(rows[1]?.transaction.direction).toBe(Direction.in);
    expect(rows[1]?.transaction.kind).toBe(TransactionKind.credit_card_payment);
  });

  it('un sufijo de cargo también gana, en el mismo perfil', () => {
    const rows = cardRows(['05/02/2026;COMPRA SUPERMERCADO;35.000 CARGO;']);
    expect(rows[0]?.transaction.amount.minor).toBe(-35000);
  });

  it('sin sufijo el perfil sigue mandando', () => {
    const rows = cardRows(['05/02/2026;COMPRA SUPERMERCADO;35.000;']);
    expect(rows[0]?.transaction.amount.minor).toBe(-35000);
  });

  function flagged(header: string, rows: string[]) {
    return prepareImport({
      file: fromText(
        'cartola.csv',
        [`Fecha;Descripcion;Monto;${header};Saldo`, ...rows].join('\n'),
      ),
      accountId: 'acc-1',
      parserId: 'generico.cuenta',
      rules: [],
      duplicateIndex: buildDuplicateIndex([]),
    });
  }

  it('bajo una cabecera D/C, una C es Crédito', () => {
    const prepared = flagged('D/C', ['01/02/2026;SUELDO;500.000;C;600.000']);
    expect(prepared.rows[0]?.transaction.amount.minor).toBe(500000);
    expect(prepared.rows[0]?.transaction.direction).toBe(Direction.in);
  });

  it('bajo una cabecera D/C, una D es Débito', () => {
    const prepared = flagged('D/C', ['01/02/2026;COMPRA;500.000;D;100.000']);
    expect(prepared.rows[0]?.transaction.amount.minor).toBe(-500000);
  });

  it('bajo una cabecera Cargo/Abono, una C es Cargo', () => {
    const prepared = flagged('Cargo/Abono', ['01/02/2026;COMPRA;500.000;C;100.000']);
    expect(prepared.rows[0]?.transaction.amount.minor).toBe(-500000);
  });

  it('bajo una cabecera Cargo/Abono, una A es Abono', () => {
    const prepared = flagged('Cargo/Abono', ['01/02/2026;SUELDO;500.000;A;600.000']);
    expect(prepared.rows[0]?.transaction.amount.minor).toBe(500000);
  });

  it('un valor que la cabecera no explica hace fallar la fila, no adivina', () => {
    const prepared = flagged('D/C', ['01/02/2026;MOVIMIENTO;500.000;X;600.000']);
    expect(prepared.statement.rowStats.failed).toBe(1);
    expect(prepared.validation.ok).toBe(false);
  });
});
