import { describe, expect, it } from 'vitest';
import { buildDuplicateIndex } from '../src/core/dedupe/classify';
import { resolveDateOrder } from '../src/core/parsing/date-order';
import { prepareImport } from '../src/core/pipeline';
import { fromText } from './fixtures';

/**
 * El orden de los campos de una fecha numérica.
 *
 * `03/09/2026` admite dos lecturas y el perfil declara cuál usar, así que hasta
 * ahora cada fila con día ≤ 12 llevaba una advertencia y aparecía como
 * «Revisar». En una cartola real eso es cerca de la mitad de las filas: la
 * marca deja de significar nada y el usuario deja de mirarla.
 *
 * Pero la ambigüedad es de la *fila*, no del *archivo*. Un banco no mezcla
 * órdenes dentro de una misma exportación, así que una sola fila con un campo
 * mayor que 12 prueba el orden de todas las demás. Sólo cuando el archivo
 * entero es ambiguo queda algo que advertir — una vez, no cien.
 */

function prepare(rows: string[], parserId = 'generico.cuenta') {
  return prepareImport({
    file: fromText('cartola.csv', ['Fecha;Descripcion;Cargo;Abono;Saldo', ...rows].join('\n')),
    accountId: 'acc-1',
    parserId,
    rules: [],
    duplicateIndex: buildDuplicateIndex([]),
  });
}

describe('resolveDateOrder', () => {
  it('una fila con día mayor que 12 prueba el orden de todo el archivo', () => {
    expect(resolveDateOrder(['03/09/2026', '25/09/2026'], 'DMY')).toEqual({
      order: 'DMY',
      source: 'file',
      ambiguousRows: 0,
    });
  });

  it('lo prueba también contra un perfil que declara lo contrario', () => {
    // El archivo manda: `25/09` no puede ser mes 25.
    expect(resolveDateOrder(['03/09/2026', '25/09/2026'], 'MDY')).toEqual({
      order: 'DMY',
      source: 'file',
      ambiguousRows: 0,
    });
  });

  it('detecta el orden inverso cuando el segundo campo es el que pasa de 12', () => {
    expect(resolveDateOrder(['09/25/2026', '03/09/2026'], 'DMY')).toEqual({
      order: 'MDY',
      source: 'file',
      ambiguousRows: 0,
    });
  });

  it('cae en el perfil cuando el archivo entero es ambiguo, y dice cuántas filas', () => {
    expect(resolveDateOrder(['03/09/2026', '04/09/2026'], 'DMY')).toEqual({
      order: 'DMY',
      source: 'profile',
      ambiguousRows: 2,
    });
  });

  it('ignora las fechas que no son ambiguas por su forma', () => {
    // ISO y nombres de mes no admiten dos lecturas.
    expect(resolveDateOrder(['2026-09-03', '03 ene 2026'], 'DMY')).toEqual({
      order: 'DMY',
      source: 'profile',
      ambiguousRows: 0,
    });
  });

  it('con evidencia en los dos sentidos se queda con lo que declara el perfil', () => {
    // Si aparecen las dos cosas, alguna fila es ilegible en cualquier lectura y
    // el mapeo de filas ya la reporta como error. Aquí no se inventa un orden.
    expect(resolveDateOrder(['25/09/2026', '09/25/2026'], 'DMY')).toMatchObject({
      order: 'DMY',
      source: 'conflict',
    });
  });
});

describe('en el pipeline', () => {
  it('no marca cada fila como pendiente de revisión por una fecha ambigua', () => {
    const prepared = prepare([
      '03/09/2026;COMPRA UNO;10.000;;90.000',
      '04/09/2026;COMPRA DOS;5.000;;85.000',
    ]);

    for (const row of prepared.rows) {
      expect(row.transaction.warnings.map((w) => w.code)).not.toContain('ambiguous-date-format');
    }
    expect(prepared.totals.needsReview).toBe(0);
  });

  it('sigue contando como pendiente lo que de verdad no se pudo clasificar', () => {
    // El contador tiene que significar algo: un abono de tarjeta sin glosa
    // reconocible sí necesita que alguien lo mire.
    const prepared = prepareImport({
      file: fromText(
        'cmr.csv',
        ['Fecha;Descripcion;Monto', '06/09/2026;ABONO;-15.000'].join('\n'),
      ),
      accountId: 'acc-card',
      parserId: 'generico.tarjeta',
      rules: [],
      duplicateIndex: buildDuplicateIndex([]),
    });

    expect(prepared.totals.needsReview).toBe(1);
    expect(prepared.totals.unknownKind).toBe(1);
  });

  it('advierte una sola vez sobre el archivo', () => {
    const prepared = prepare([
      '03/09/2026;COMPRA UNO;10.000;;90.000',
      '04/09/2026;COMPRA DOS;5.000;;85.000',
    ]);

    const issues = prepared.validation.issues.filter((i) => i.code === 'ambiguous-date-order');
    expect(issues).toHaveLength(1);
    expect(issues[0]?.level).toBe('warning');
    expect(issues[0]?.message).toContain('2');
  });

  it('no advierte nada cuando el archivo prueba su propio orden', () => {
    const prepared = prepare([
      '03/09/2026;COMPRA UNO;10.000;;90.000',
      '25/09/2026;COMPRA DOS;5.000;;85.000',
    ]);

    expect(prepared.validation.issues.some((i) => i.code === 'ambiguous-date-order')).toBe(false);
    expect(prepared.rows[0]?.transaction.date).toBe('2026-09-03');
    expect(prepared.rows[1]?.transaction.date).toBe('2026-09-25');
  });

  it('lee el archivo en su propio orden aunque el perfil declare otro', () => {
    // Un banco que exporta MM/DD contra un perfil DMY producía fechas
    // silenciosamente cambiadas: el dedupe deja de reconocer el movimiento y el
    // gasto aparece en el mes equivocado.
    const prepared = prepare([
      '09/25/2026;COMPRA UNO;10.000;;90.000',
      '09/03/2026;COMPRA DOS;5.000;;85.000',
    ]);

    expect(prepared.rows[0]?.transaction.date).toBe('2026-09-25');
    expect(prepared.rows[1]?.transaction.date).toBe('2026-09-03');
    expect(prepared.validation.issues.some((i) => i.code === 'date-order-differs')).toBe(true);
  });
});
