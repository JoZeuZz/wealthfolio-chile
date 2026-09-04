import { describe, expect, it } from 'vitest';
import { prepareImport } from '../src/core/pipeline';
import { buildDuplicateIndex } from '../src/core/dedupe/classify';
import { getParser } from '../src/core/providers/registry';
import { fromText } from './fixtures';

/**
 * Qué cuenta como "esta cartola se leyó entera".
 *
 * Las cifras del resumen de validación no son cosmética: son lo único que le
 * dice al usuario si el archivo se leyó completo antes de escribir en su
 * contabilidad. Un `skippedRows: 0` fijo, o un `errorRows` que cuenta
 * *problemas* en vez de *filas*, convierte una lectura parcial en una lectura
 * aparentemente perfecta.
 */

const GENERIC = 'generico.cuenta';

function prepare(text: string, parserId = GENERIC) {
  return prepareImport({
    file: fromText('cartola.csv', text),
    accountId: 'acc-1',
    parserId,
    rules: [],
    duplicateIndex: buildDuplicateIndex([]),
  });
}

describe('conteo de filas', () => {
  it('cuenta las filas de datos, las mapeadas, las omitidas y las fallidas por separado', () => {
    const prepared = prepare(
      [
        'Fecha;Descripcion;Cargo;Abono;Saldo',
        '03/02/2026;COMPRA SUPERMERCADO;10.000;;90.000',
        '', // fila en blanco: omitida
        '04/02/2026;TOTAL DEL PERIODO;;;90.000', // patrón ignorado: omitida
        '05/02/2026;FILA IMPOSIBLE;5.000;5.000;85.000', // cargo y abono: falla
        '06/02/2026;PAGO SERVICIO;5.000;;85.000',
      ].join('\n'),
    );

    expect(prepared.statement.rowStats).toEqual({
      dataRows: 5,
      mapped: 2,
      skipped: 2,
      failed: 1,
    });
  });

  it('reporta esas mismas cifras en el resumen de validación', () => {
    const prepared = prepare(
      [
        'Fecha;Descripcion;Cargo;Abono;Saldo',
        '03/02/2026;COMPRA SUPERMERCADO;10.000;;90.000',
        '',
        '05/02/2026;FILA IMPOSIBLE;5.000;5.000;85.000',
      ].join('\n'),
    );

    const { summary } = prepared.validation;
    expect(summary.totalRows).toBe(3);
    expect(summary.parsedRows).toBe(1);
    expect(summary.skippedRows).toBe(1);
    expect(summary.errorRows).toBe(1);
  });

  it('no inventa filas omitidas cuando el archivo se leyó entero', () => {
    const prepared = prepare(
      [
        'Fecha;Descripcion;Cargo;Abono;Saldo',
        '03/02/2026;COMPRA SUPERMERCADO;10.000;;90.000',
        '04/02/2026;PAGO SERVICIO;5.000;;85.000',
      ].join('\n'),
    );

    expect(prepared.statement.rowStats).toEqual({
      dataRows: 2,
      mapped: 2,
      skipped: 0,
      failed: 0,
    });
    expect(prepared.validation.ok).toBe(true);
  });
});

describe('una fila ilegible invalida la cartola', () => {
  it('marca la validación como fallida', () => {
    const prepared = prepare(
      [
        'Fecha;Descripcion;Cargo;Abono;Saldo',
        '03/02/2026;COMPRA SUPERMERCADO;10.000;;90.000',
        '05/02/2026;FILA IMPOSIBLE;5.000;5.000;85.000',
      ].join('\n'),
    );

    // Las otras filas se leyeron bien, pero el archivo ya no se entiende
    // entero: importar el subconjunto deja un hueco silencioso.
    expect(prepared.validation.ok).toBe(false);
    expect(prepared.validation.issues.some((issue) => issue.code === 'row-parse-failed')).toBe(true);
  });

  it('dice en qué línea', () => {
    const prepared = prepare(
      [
        'Fecha;Descripcion;Cargo;Abono;Saldo',
        '03/02/2026;COMPRA SUPERMERCADO;10.000;;90.000',
        '05/02/2026;FILA IMPOSIBLE;5.000;5.000;85.000',
      ].join('\n'),
    );

    const issue = prepared.validation.issues.find((i) => i.code === 'row-parse-failed');
    expect(issue?.line).toBe(3);
  });
});

describe('cuadratura de saldos', () => {
  const mismatched = (rows: string[]) =>
    ['Fecha;Descripcion;Cargo;Abono;Saldo', ...rows].join('\n');

  it('cuadra cuando el saldo declarado sigue a los montos', () => {
    const prepared = prepare(
      mismatched([
        '03/02/2026;COMPRA UNO;10.000;;90.000',
        '04/02/2026;COMPRA DOS;5.000;;85.000',
        '05/02/2026;ABONO;;20.000;105.000',
      ]),
    );

    expect(prepared.validation.summary.balanceReconciles).toBe(true);
    expect(prepared.validation.ok).toBe(true);
  });

  it('un desajuste aislado en un perfil sin cartola real es advertencia, no bloqueo', () => {
    // El perfil de BancoEstado está `pending-real-sample`: todavía no sabemos si
    // su columna de saldo es fiable, así que un desajuste puntual no puede
    // costar la importación entera.
    const prepared = prepare(
      [
        'BancoEstado',
        'CuentaRUT N: 12345678',
        '',
        'Fecha;Descripcion;Cargo;Abono;Saldo',
        '03/02/2026;COMPRA UNO;10.000;;90.000',
        '04/02/2026;COMPRA DOS;5.000;;85.000',
        '05/02/2026;COMPRA TRES;5.000;;79.999',
        '06/02/2026;COMPRA CUATRO;1.000;;78.999',
      ].join('\n'),
      'banco-estado.cuenta',
    );

    const issue = prepared.validation.issues.find((i) => i.code === 'balance-walk-mismatch');
    expect(issue?.level).toBe('warning');
    expect(prepared.validation.summary.balanceReconciles).toBe(false);
    expect(prepared.validation.ok).toBe(true);
  });

  it('un desajuste sistemático es un error de lectura, aunque el perfil no esté validado', () => {
    // Todos los pasos fallan: eso no es una rareza del banco, es que el signo o
    // una columna se están leyendo mal. Importar eso sería importar otra cosa.
    // Cinco filas, cuatro pasos: la proporción sólo significa algo con muestra
    // suficiente — ver «no llama sistemático a un solo paso».
    const prepared = prepare(
      [
        'BancoEstado',
        'CuentaRUT N: 12345678',
        '',
        'Fecha;Descripcion;Cargo;Abono;Saldo',
        '03/02/2026;COMPRA UNO;10.000;;90.000',
        '04/02/2026;COMPRA DOS;5.000;;70.000',
        '05/02/2026;COMPRA TRES;5.000;;40.000',
        '06/02/2026;COMPRA CUATRO;1.000;;10.000',
        '07/02/2026;COMPRA CINCO;1.000;;5.000',
      ].join('\n'),
      'banco-estado.cuenta',
    );

    const issue = prepared.validation.issues.find((i) => i.code === 'balance-walk-systematic');
    expect(issue?.level).toBe('error');
    expect(prepared.validation.ok).toBe(false);
  });

  it('en un perfil que declara su saldo autoritativo, un solo desajuste bloquea', () => {
    const generic = getParser(GENERIC);
    expect(generic?.profile.balanceCheck).toBe('authoritative');

    const prepared = prepare(
      mismatched([
        '03/02/2026;COMPRA UNO;10.000;;90.000',
        '04/02/2026;COMPRA DOS;5.000;;85.000',
        '05/02/2026;COMPRA TRES;5.000;;79.999',
        '06/02/2026;COMPRA CUATRO;1.000;;78.999',
        '07/02/2026;COMPRA CINCO;1.000;;77.999',
      ]),
    );

    const issue = prepared.validation.issues.find((i) => i.code === 'balance-walk-mismatch');
    expect(issue?.level).toBe('error');
    expect(prepared.validation.ok).toBe(false);
  });
});

/**
 * El recorrido de saldos, contra cartolas reales y no contra la que teníamos a
 * mano.
 *
 * Los tres casos de abajo salieron de una revisión adversarial del primer
 * intento: los tres son cartolas correctas que el chequeo declaraba
 * ilegibles. Un control de integridad que bloquea archivos buenos no es
 * conservador, es inservible — el usuario aprende a ignorarlo o abandona.
 */
describe('el saldo se recorre en el orden del libro, no en el del archivo', () => {
  it('acepta una cartola exportada de la más nueva a la más antigua', () => {
    // Banco de Chile y Santander exportan así por defecto. Recorrer el archivo
    // de arriba abajo hace que *todos* los pasos fallen, y el desajuste
    // sistemático bloqueaba la importación entera.
    const prepared = prepare(
      [
        'BancoEstado',
        'CuentaRUT N: 12345678',
        '',
        'Fecha;Descripcion;Cargo;Abono;Saldo',
        '06/02/2026;COMPRA CUATRO;1.000;;78.999',
        '05/02/2026;COMPRA TRES;5.000;;79.999',
        '04/02/2026;COMPRA DOS;5.000;;84.999',
        '03/02/2026;COMPRA UNO;10.000;;89.999',
      ].join('\n'),
      'banco-estado.cuenta',
    );

    expect(prepared.validation.summary.balanceReconciles).toBe(true);
    expect(prepared.validation.ok).toBe(true);
  });

  it('suma los movimientos intermedios cuando sólo algunas filas traen saldo', () => {
    // Varias cartolas chilenas imprimen el saldo una vez por día. Comparar sólo
    // contra el monto de la última fila deja fuera los del medio y casi todos
    // los pasos fallan.
    const prepared = prepare(
      [
        'Fecha;Descripcion;Cargo;Abono;Saldo',
        '03/02/2026;COMPRA UNO;10.000;;90.000',
        '03/02/2026;COMPRA DOS;5.000;;',
        '04/02/2026;COMPRA TRES;5.000;;80.000',
        '04/02/2026;COMPRA CUATRO;1.000;;',
        '05/02/2026;COMPRA CINCO;2.000;;77.000',
      ].join('\n'),
    );

    expect(prepared.validation.summary.balanceReconciles).toBe(true);
    expect(prepared.validation.ok).toBe(true);
  });

  it('no opina cuando el archivo no viene ordenado por fecha', () => {
    // Sin un orden de libro no hay recorrido posible. Decir "no se pudo
    // comprobar" es honesto; inventar un desajuste no.
    const prepared = prepare(
      [
        'Fecha;Descripcion;Cargo;Abono;Saldo',
        '05/02/2026;COMPRA UNO;10.000;;90.000',
        '03/02/2026;COMPRA DOS;5.000;;85.000',
        '04/02/2026;COMPRA TRES;5.000;;80.000',
      ].join('\n'),
    );

    expect(prepared.validation.summary.balanceReconciles).toBeUndefined();
    expect(prepared.validation.ok).toBe(true);
  });

  it('no llama sistemático a un solo paso que no cuadra', () => {
    // Con dos filas hay un paso: cualquier rareza es el 100 %. Un umbral por
    // proporción sin mínimo de muestra convierte una cartola de dos líneas en
    // una importación bloqueada.
    const prepared = prepare(
      [
        'BancoEstado',
        'CuentaRUT N: 12345678',
        '',
        'Fecha;Descripcion;Cargo;Abono;Saldo',
        '03/02/2026;COMPRA UNO;10.000;;90.000',
        '04/02/2026;COMPRA DOS;5.000;;80.000',
      ].join('\n'),
      'banco-estado.cuenta',
    );

    expect(prepared.validation.issues.some((i) => i.code === 'balance-walk-systematic')).toBe(false);
    expect(prepared.validation.ok).toBe(true);
  });
});

/**
 * Una fila con datos no puede desaparecer sin decirlo.
 *
 * `skipped` existe para las filas que no son movimientos: un pie `TOTAL`, una
 * línea de página, una fila vacía. Tres caminos distintos mandaban a ese mismo
 * cubo filas que **sí** llevaban dinero:
 *
 * - `/^\s*$/` en `COMMON_IGNORE_PATTERNS`. `isBlankRow` ya descarta las filas
 *   realmente vacías, así que ese patrón sólo llegaba a dispararse sobre filas
 *   con datos y la celda de glosa en blanco — y las clasificaba como pie.
 * - una fecha vacía con un monto presente.
 * - un monto vacío con una fecha presente.
 *
 * En los tres casos `validation.ok` seguía en `true` y la vista previa decía
 * «N omitidas», indistinguible del caso esperado. Un cargo de $250.000
 * desaparecía sin error, sin advertencia y sin bloqueo: exactamente el fallo
 * que todo el gate de importación existe para evitar.
 */
describe('ninguna fila con dinero se omite en silencio', () => {
  function parse(rows: string[]) {
    return prepareImport({
      file: fromText('cartola.csv', ['Fecha;Descripcion;Cargo;Abono', ...rows].join('\n')),
      accountId: 'acc-1',
      parserId: 'banco-estado.cuenta',
      rules: [],
      duplicateIndex: buildDuplicateIndex([]),
    });
  }

  it('una glosa en blanco no convierte un cargo en un pie de tabla', () => {
    const prepared = parse([
      '01/02/2026;COMPRA LIDER;10.000;',
      '15/02/2026;;250.000;',
      '20/02/2026;SUELDO;;500.000',
    ]);

    expect(prepared.statement.rowStats).toMatchObject({ dataRows: 3, skipped: 0 });
    expect(prepared.rows).toHaveLength(3);
    expect(prepared.rows[1]?.transaction.amount.minor).toBe(-250000);
  });

  it('y la fila queda marcada, porque una glosa vacía sí es raro', () => {
    const prepared = parse(['01/02/2026;;250.000;']);
    expect(prepared.rows[0]?.transaction.warnings.map((w) => w.code)).toContain(
      'missing-description',
    );
  });

  it('un monto sin fecha falla la fila en vez de omitirla', () => {
    const prepared = parse(['01/02/2026;COMPRA LIDER;10.000;', ';COMPRA SIN FECHA;99.000;']);

    expect(prepared.statement.rowStats).toMatchObject({ failed: 1, skipped: 0 });
    expect(prepared.validation.ok).toBe(false);
  });

  it('una fila sin monto en ninguna columna sí se omite: no lleva dinero', () => {
    // El límite es el dinero, no la forma. Una fila con fecha y glosa pero sin
    // monto es una línea de continuación o un separador; omitirla no pierde
    // nada. Lo que no puede omitirse es una fila que sí trae plata.
    const prepared = parse(['01/02/2026;COMPRA LIDER;10.000;', '02/02/2026;GLOSA SIN MONTO;;']);

    expect(prepared.statement.rowStats).toMatchObject({ mapped: 1, skipped: 1, failed: 0 });
    expect(prepared.validation.ok).toBe(true);
  });

  it('un cargo con contenido ilegible sí falla', () => {
    const prepared = parse(['01/02/2026;COMPRA LIDER;10.000;', '02/02/2026;COMPRA RARA;no-es-un-monto;']);

    expect(prepared.statement.rowStats).toMatchObject({ failed: 1, skipped: 0 });
    expect(prepared.validation.ok).toBe(false);
  });

  it('un pie de tabla de verdad se sigue omitiendo sin ruido', () => {
    const prepared = parse([
      '01/02/2026;COMPRA LIDER;10.000;',
      ';TOTAL DEL PERIODO;10.000;',
    ]);

    expect(prepared.statement.rowStats).toMatchObject({ mapped: 1, skipped: 1, failed: 0 });
    expect(prepared.validation.ok).toBe(true);
  });
});
