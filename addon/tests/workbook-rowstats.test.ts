import * as XLSX from 'xlsx';
import { describe, expect, it } from 'vitest';
import { buildDuplicateIndex } from '../src/core/dedupe/classify';
import { prepareImport } from '../src/core/pipeline';

/**
 * «¿Leímos la cartola entera?» sobre una planilla.
 *
 * La cifra que responde esa pregunta es la que el wizard muestra en grande, así
 * que tiene que ser verdad también en XLSX — el formato en que la mitad de los
 * bancos chilenos exporta. Excel escribe un rango que se estira hasta donde
 * llegue el formato, muy por debajo de la última fila con datos.
 */

function workbook(rows: string[][], ref?: string, extraSheet?: string[][]) {
  const book = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  if (ref) sheet['!ref'] = ref;
  XLSX.utils.book_append_sheet(book, sheet, 'Movimientos');
  if (extraSheet) {
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(extraSheet), 'Otra');
  }
  const bytes = XLSX.write(book, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
  return { name: 'cartola.xlsx', bytes: new Uint8Array(bytes) };
}

function prepare(file: { name: string; bytes: Uint8Array }) {
  return prepareImport({
    file,
    accountId: 'acc-1',
    parserId: 'generico.cuenta',
    rules: [],
    duplicateIndex: buildDuplicateIndex([]),
  });
}

const ROWS = [
  ['Fecha', 'Descripcion', 'Cargo', 'Abono', 'Saldo'],
  ['2026-02-03', 'COMPRA UNO', '10.000', '', '90.000'],
  ['2026-02-04', 'COMPRA DOS', '5.000', '', '85.000'],
];

describe('planillas', () => {
  it('no cuenta como omitidas las filas vacías que Excel arrastra al final', () => {
    // `!ref` hasta A1:E40 es lo que escribe Excel cuando el formato pasa de los
    // datos. Sin recortar, la cartola informaba «2 de 39 filas leídas · 37
    // omitidas» para un archivo leído perfecto.
    const prepared = prepare(workbook(ROWS, 'A1:E40'));

    expect(prepared.statement.rowStats).toEqual({
      dataRows: 2,
      mapped: 2,
      skipped: 0,
      failed: 0,
    });
  });

  it('avisa cuando el libro trae más de una hoja con datos', () => {
    // Sólo se lee una. Sin avisar, «se leyó entera» sería falso y nada lo diría.
    const prepared = prepare(
      workbook(ROWS, undefined, [
        ['Fecha', 'Descripcion', 'Cargo', 'Abono', 'Saldo'],
        ['2026-03-01', 'OTRA COMPRA', '1.000', '', '84.000'],
      ]),
    );

    const issue = prepared.validation.issues.find((i) => i.code === 'multiple-sheets');
    expect(issue?.level).toBe('warning');
    expect(issue?.message).toContain('Movimientos');
  });

  it('no avisa cuando la otra hoja está vacía', () => {
    const prepared = prepare(workbook(ROWS, undefined, [['']]));
    expect(prepared.validation.issues.some((i) => i.code === 'multiple-sheets')).toBe(false);
  });
});
