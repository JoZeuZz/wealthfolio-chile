import { describe, expect, it } from 'vitest';
import { buildDuplicateIndex } from '../src/core/dedupe/classify';
import { prepareImport } from '../src/core/pipeline';
import { prepareImportFromHost } from '../src/services/import-preparation';
import { fromLatin1, fromText } from './fixtures';
import { fakeHost } from './host';

/**
 * Archivos rotos de las formas en que se rompen de verdad.
 *
 * El objetivo no es que nada falle: es que cuando algo falla, el resultado sea
 * comprensible y no escriba nada. Una excepción capturada que deja el sistema
 * en un estado que nadie puede explicar es peor que una que se propaga.
 */

function prepare(text: string, parserId = 'generico.cuenta') {
  return prepareImport({
    file: fromText('cartola.csv', text),
    accountId: 'acc-1',
    parserId,
    rules: [],
    duplicateIndex: buildDuplicateIndex([]),
  });
}

describe('archivos que no son cartolas', () => {
  it('un archivo sin cabecera reconocible no revienta: lo dice', () => {
    const prepared = prepare(['esto no es una cartola', 'ni de cerca', 'para nada'].join('\n'));

    expect(prepared.statement.issues.some((i) => i.code === 'no-header')).toBe(true);
    expect(prepared.validation.ok).toBe(false);
    expect(prepared.rows).toHaveLength(0);
  });

  it('una cabecera sin columna de monto no se acepta como cabecera', () => {
    const prepared = prepare(
      ['Fecha;Descripcion;Sucursal', '03/02/2026;COMPRA;Providencia'].join('\n'),
    );
    expect(prepared.validation.ok).toBe(false);
  });

  it('un archivo vacío se reporta como ilegible, no revienta', () => {
    const prepared = prepare('');
    expect(prepared.statement.issues.some((i) => i.code === 'no-header')).toBe(true);
    expect(prepared.validation.ok).toBe(false);
  });
});

describe('celdas rotas', () => {
  it('una fecha inválida cuesta su fila y ninguna más', () => {
    const prepared = prepare(
      [
        'Fecha;Descripcion;Cargo;Abono;Saldo',
        '03/02/2026;COMPRA UNO;10.000;;90.000',
        '99/99/9999;COMPRA MALA;5.000;;85.000',
        '05/02/2026;COMPRA DOS;5.000;;80.000',
      ].join('\n'),
    );

    expect(prepared.statement.rowStats).toMatchObject({ mapped: 2, failed: 1 });
    expect(prepared.validation.ok).toBe(false);
  });

  it('un monto que no cabe en un entero seguro no se aproxima', () => {
    // 10^17 pesos no es un monto: es una celda corrupta. Redondearlo a un
    // float sería meter un número inventado en la contabilidad.
    const prepared = prepare(
      [
        'Fecha;Descripcion;Cargo;Abono;Saldo',
        '03/02/2026;COMPRA UNO;10.000;;90.000',
        '04/02/2026;MONTO IMPOSIBLE;99.999.999.999.999.999.999;;0',
      ].join('\n'),
    );

    expect(prepared.statement.rowStats.failed).toBe(1);
    expect(prepared.validation.issues.some((i) => i.code === 'row-parse-failed')).toBe(true);
  });

  it('un cargo de cero no es un movimiento y se cuenta como omitido', () => {
    const prepared = prepare(
      ['Fecha;Descripcion;Cargo;Abono;Saldo', '03/02/2026;AJUSTE;0;;90.000'].join('\n'),
    );
    expect(prepared.rows).toHaveLength(0);
    expect(prepared.statement.rowStats).toMatchObject({ skipped: 1, failed: 0 });
  });
});

describe('codificaciones', () => {
  it('lee una cartola en Windows-1252 sin corromper los acentos', () => {
    // Sin esto cada `Ñ` y cada `ó` se rompe, y con ellos todos los matches de
    // comercio y de reglas aguas abajo.
    const prepared = prepareImport({
      file: fromLatin1(
        'cartola.csv',
        [
          'Fecha;Descripción;Cargo;Abono;Saldo',
          '03/02/2026;FARMACIA ÑUÑOA;10.000;;90.000',
        ].join('\n'),
      ),
      accountId: 'acc-1',
      parserId: 'generico.cuenta',
      rules: [],
      duplicateIndex: buildDuplicateIndex([]),
    });

    expect(prepared.rows[0]?.transaction.description).toBe('FARMACIA ÑUÑOA');
  });
});

describe('el host falla a mitad de camino', () => {
  const CARTOLA = [
    'Fecha;Descripcion;Cargo;Abono;Saldo',
    '03/02/2026;COMPRA UNO;10.000;;90.000',
  ].join('\n');

  it('si no se pueden leer los movimientos existentes, no se importa', async () => {
    const host = fakeHost();
    host.searchError = new Error('backend unavailable');

    const result = await prepareImportFromHost(host.ctx, {
      file: fromText('cartola.csv', CARTOLA),
      accountId: 'acc-1',
      parserId: 'generico.cuenta',
    });

    expect(result.canImport).toBe(false);
    expect(result.prepared?.rows).toHaveLength(1);
  });

  it('si falla el storage de reglas se sigue con las predefinidas', async () => {
    // Perder las reglas del usuario degrada la categorización; no hace insegura
    // la importación.
    const host = fakeHost();
    host.store.failWith = new Error('storage unavailable');

    const result = await prepareImportFromHost(host.ctx, {
      file: fromText('cartola.csv', CARTOLA),
      accountId: 'acc-1',
      parserId: 'generico.cuenta',
    });

    expect(result.rules.status).toBe('fallback');
    expect(result.canImport).toBe(true);
  });
});
