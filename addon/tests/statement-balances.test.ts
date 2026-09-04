import { describe, expect, it } from 'vitest';
import { prepareImport } from '../src/core/pipeline';
import { buildDuplicateIndex } from '../src/core/dedupe/classify';
import { fromText } from './fixtures';

/**
 * El saldo antes del primer movimiento y el saldo después del último.
 *
 * `openingBalance` y `closingBalance` llevaban desde 0.1 declarados en
 * `ParsedStatement` y nadie los poblaba nunca, así que el recorrido de saldos
 * empezaba sin punto de partida: el primer movimiento del archivo no se
 * comprobaba contra nada, y una cartola sin columna de saldo no se comprobaba
 * en absoluto.
 *
 * Lo que hace falta antes de poblarlos es decidir qué significan, porque
 * "primera fila" no es "primer movimiento": las cartolas chilenas vienen tanto
 * de más antigua a más nueva como al revés, y muchas imprimen el saldo una vez
 * al día y lo dejan en blanco en las demás. Aquí se fija esa semántica.
 *
 * `source` importa tanto como el monto. Un saldo **derivado** sale de la misma
 * columna, el mismo parser y el mismo convenio de signo que los montos, así
 * que compararlo con ellos es aritmética. Un saldo **declarado** sale de texto
 * suelto de la cabecera, donde nada dice si un número sin signo es deuda o
 * fondo.
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

describe('saldos derivados de la columna de saldo', () => {
  it('cronológica: el saldo de apertura es el del primer movimiento menos su monto', () => {
    const { statement } = prepare(
      [
        'Fecha;Descripcion;Cargo;Abono;Saldo',
        '03/02/2026;COMPRA;10.000;;90.000',
        '04/02/2026;SUELDO;;50.000;140.000',
      ].join('\n'),
    );

    expect(statement.openingBalance).toEqual({
      amount: { minor: 100_000, scale: 0, currency: 'CLP' },
      source: 'derived',
    });
    expect(statement.closingBalance).toEqual({
      amount: { minor: 140_000, scale: 0, currency: 'CLP' },
      source: 'derived',
    });
  });

  it('inversa: apertura y cierre siguen siendo los del orden del libro, no los del archivo', () => {
    const { statement } = prepare(
      [
        'Fecha;Descripcion;Cargo;Abono;Saldo',
        '04/02/2026;SUELDO;;50.000;140.000',
        '03/02/2026;COMPRA;10.000;;90.000',
      ].join('\n'),
    );

    expect(statement.openingBalance?.amount.minor).toBe(100_000);
    expect(statement.closingBalance?.amount.minor).toBe(140_000);
  });

  it('sin saldo en la primera fila no se inventa una apertura', () => {
    const { statement } = prepare(
      [
        'Fecha;Descripcion;Cargo;Abono;Saldo',
        '03/02/2026;COMPRA;10.000;;',
        '04/02/2026;SUELDO;;50.000;140.000',
      ].join('\n'),
    );

    expect(statement.openingBalance).toBeUndefined();
    expect(statement.closingBalance?.amount.minor).toBe(140_000);
  });

  it('sin saldo en la última fila no se inventa un cierre', () => {
    const { statement } = prepare(
      [
        'Fecha;Descripcion;Cargo;Abono;Saldo',
        '03/02/2026;COMPRA;10.000;;90.000',
        '04/02/2026;SUELDO;;50.000;',
      ].join('\n'),
    );

    expect(statement.openingBalance?.amount.minor).toBe(100_000);
    expect(statement.closingBalance).toBeUndefined();
  });

  it('sin columna de saldo no hay ni apertura ni cierre derivados', () => {
    const { statement } = prepare(
      ['Fecha;Descripcion;Cargo;Abono', '03/02/2026;COMPRA;10.000;'].join('\n'),
    );

    expect(statement.openingBalance).toBeUndefined();
    expect(statement.closingBalance).toBeUndefined();
  });

  it('con las filas en desorden de fechas no se elige un primero ni un último', () => {
    const { statement } = prepare(
      [
        'Fecha;Descripcion;Cargo;Abono;Saldo',
        '05/02/2026;A;1.000;;99.000',
        '03/02/2026;B;1.000;;98.000',
        '04/02/2026;C;1.000;;97.000',
      ].join('\n'),
    );

    expect(statement.openingBalance).toBeUndefined();
    expect(statement.closingBalance).toBeUndefined();
  });

  it('una fila ilegible deja de ser la lista de movimientos del archivo', () => {
    // El primer movimiento del archivo no llegó a `transactions`, así que
    // restarle su monto al saldo del segundo daría una apertura que no es la
    // del periodo. Sin evidencia suficiente, nada.
    const { statement } = prepare(
      [
        'Fecha;Descripcion;Cargo;Abono;Saldo',
        '03/02/2026;IMPOSIBLE;5.000;5.000;95.000',
        '04/02/2026;COMPRA;10.000;;85.000',
      ].join('\n'),
    );

    expect(statement.rowStats.failed).toBe(1);
    expect(statement.openingBalance).toBeUndefined();
    expect(statement.closingBalance).toBeUndefined();
  });
});

describe('saldos declarados en la cabecera', () => {
  it('lee «Saldo inicial» y «Saldo final» de la cabecera', () => {
    const { statement } = prepare(
      [
        'Banco Generico',
        'Saldo inicial;100.000',
        'Saldo final;140.000',
        '',
        'Fecha;Descripcion;Cargo;Abono',
        '03/02/2026;COMPRA;10.000;',
        '04/02/2026;SUELDO;;50.000',
      ].join('\n'),
    );

    expect(statement.openingBalance).toEqual({
      amount: { minor: 100_000, scale: 0, currency: 'CLP' },
      source: 'declared',
    });
    expect(statement.closingBalance?.source).toBe('declared');
  });

  it('«Saldo anterior» también es una apertura', () => {
    const { statement } = prepare(
      [
        'Saldo anterior: 100.000',
        'Fecha;Descripcion;Cargo;Abono',
        '03/02/2026;COMPRA;10.000;',
      ].join('\n'),
    );

    expect(statement.openingBalance?.amount.minor).toBe(100_000);
  });

  it('«Saldo disponible» no es un saldo de cierre', () => {
    // En una cuenta corriente chilena el disponible incluye la línea de
    // crédito, así que tomarlo por el saldo del periodo inventa fondos que no
    // existen — y encima lo haría con la autoridad de un dato «declarado».
    const { statement } = prepare(
      [
        'Saldo disponible: 1.400.000',
        'Fecha;Descripcion;Cargo;Abono',
        '03/02/2026;COMPRA;10.000;',
      ].join('\n'),
    );

    expect(statement.closingBalance).toBeUndefined();
  });

  it('el saldo derivado gana al declarado, porque comparte convenio de signo', () => {
    const { statement } = prepare(
      [
        'Saldo inicial;999.999',
        'Fecha;Descripcion;Cargo;Abono;Saldo',
        '03/02/2026;COMPRA;10.000;;90.000',
      ].join('\n'),
    );

    expect(statement.openingBalance).toEqual({
      amount: { minor: 100_000, scale: 0, currency: 'CLP' },
      source: 'derived',
    });
  });

  it('en una tarjeta no se lee un saldo declarado', () => {
    // «Saldo anterior $450.000» en una tarjeta es deuda, no fondo, y la
    // cabecera no trae columna de signo que lo diga. Un número cuyo signo es
    // una suposición no es evidencia.
    const { statement } = prepare(
      [
        'Saldo anterior: 450.000',
        'Fecha;Descripcion;Cargo;Abono',
        '03/02/2026;COMPRA;10.000;',
      ].join('\n'),
      'generico.tarjeta',
    );

    expect(statement.openingBalance).toBeUndefined();
  });
});

describe('lo que los saldos permiten comprobar', () => {
  it('con saldos parciales, la apertura declarada hace comprobable el primer tramo', () => {
    // El banco imprime el saldo una vez y lo deja en blanco en la primera
    // fila, así que no hay apertura derivada que sembrar. La declarada sí
    // convierte el primer movimiento en un paso: 120.000 menos 10.000 son
    // 110.000, y la cartola dice 90.000.
    const { validation } = prepare(
      [
        'Saldo inicial;120.000',
        'Fecha;Descripcion;Cargo;Abono;Saldo',
        '03/02/2026;COMPRA;10.000;;',
        '04/02/2026;SUELDO;;50.000;90.000',
      ].join('\n'),
    );

    expect(validation.summary.balanceReconciles).toBe(false);
    expect(validation.issues.some((i) => i.code.startsWith('balance-walk'))).toBe(true);
  });

  it('sin la apertura declarada ese mismo primer tramo no se comprueba', () => {
    const { validation } = prepare(
      [
        'Fecha;Descripcion;Cargo;Abono;Saldo',
        '03/02/2026;COMPRA;10.000;;',
        '04/02/2026;SUELDO;;50.000;90.000',
      ].join('\n'),
    );

    expect(validation.summary.balanceReconciles).toBeUndefined();
  });

  it('la cabecera y la columna de saldo discrepando es en sí un hallazgo', () => {
    const { statement, validation } = prepare(
      [
        'Saldo inicial;120.000',
        'Fecha;Descripcion;Cargo;Abono;Saldo',
        '03/02/2026;COMPRA;10.000;;90.000',
      ].join('\n'),
    );

    // La derivada es la que se conserva: comparte convenio de signo con los montos.
    expect(statement.openingBalance).toEqual({
      amount: { minor: 100_000, scale: 0, currency: 'CLP' },
      source: 'derived',
    });
    expect(validation.issues.some((i) => i.code === 'balance-declared-mismatch')).toBe(true);
  });

  it('una cartola sin columna de saldo se comprueba de punta a punta con los declarados', () => {
    // 100.000 menos 10.000 más 50.000 son 140.000, y la cartola dice 190.000:
    // falta un movimiento o alguno tiene el signo al revés. Sin columna de
    // saldo, ésta es la única comprobación que existe sobre este archivo.
    const { validation } = prepare(
      [
        'Saldo inicial;100.000',
        'Saldo final;190.000',
        'Fecha;Descripcion;Cargo;Abono',
        '03/02/2026;COMPRA;10.000;',
        '04/02/2026;SUELDO;;50.000',
      ].join('\n'),
    );

    expect(validation.issues.some((i) => i.code === 'balance-total-mismatch')).toBe(true);
  });

  it('y no se queja cuando sí cuadra', () => {
    const { validation } = prepare(
      [
        'Saldo inicial;100.000',
        'Saldo final;140.000',
        'Fecha;Descripcion;Cargo;Abono',
        '03/02/2026;COMPRA;10.000;',
        '04/02/2026;SUELDO;;50.000',
        '05/02/2026;DEVOLUCION;;0;',
      ].join('\n'),
    );

    expect(validation.issues.some((i) => i.code === 'balance-total-mismatch')).toBe(false);
  });

  it('no compara punta a punta cuando una fila no se pudo leer', () => {
    // Faltaría un monto en la suma, así que la comprobación fallaría por una
    // razón que no es la que informa.
    const { validation } = prepare(
      [
        'Saldo inicial;100.000',
        'Saldo final;140.000',
        'Fecha;Descripcion;Cargo;Abono',
        '03/02/2026;IMPOSIBLE;5.000;5.000',
        '04/02/2026;SUELDO;;50.000',
      ].join('\n'),
    );

    expect(validation.issues.some((i) => i.code === 'balance-total-mismatch')).toBe(false);
  });
});

/**
 * Varios movimientos el mismo día, y un archivo que viene al revés.
 *
 * `inLedgerOrder` decide entre ascendente y descendente mirando sólo si alguna
 * fecha rompe la monotonía, así que un archivo entero de un solo día cumple las
 * dos y se toma tal cual. Y al invertir un archivo descendente también se
 * invierte el orden *dentro* de cada día, que es una suposición sobre cómo
 * imprime el banco, no un dato del archivo.
 *
 * Ninguna de las dos cosas se puede resolver escogiendo un orden: el archivo no
 * lo entrega. Lo que sí se puede es no derivar un saldo cuyo extremo está
 * empatado, porque «el saldo después del último movimiento» no significa nada
 * si no se sabe cuál fue el último.
 */
describe('empates de fecha en los extremos', () => {
  it('en un archivo descendente, un último día con varias filas no da cierre', () => {
    const { statement } = prepare(
      [
        'Fecha;Descripcion;Cargo;Abono;Saldo',
        '05/02/2026;C;1.000;;97.000',
        '05/02/2026;B;1.000;;98.000',
        '03/02/2026;A;1.000;;99.000',
      ].join('\n'),
    );

    // Tras invertir, las dos filas del 05 quedan en un orden que el archivo no
    // afirma, así que cuál de las dos es la última es una suposición.
    expect(statement.closingBalance).toBeUndefined();
    // El extremo que sí es inequívoco sigue derivándose.
    expect(statement.openingBalance?.amount.minor).toBe(100_000);
  });

  it('en un archivo ascendente el orden del día es el que imprimió el banco', () => {
    const { statement } = prepare(
      [
        'Fecha;Descripcion;Cargo;Abono;Saldo',
        '03/02/2026;A;1.000;;99.000',
        '05/02/2026;B;1.000;;98.000',
        '05/02/2026;C;1.000;;97.000',
      ].join('\n'),
    );

    expect(statement.closingBalance?.amount.minor).toBe(97_000);
    expect(statement.openingBalance?.amount.minor).toBe(100_000);
  });

  it('un archivo de un solo día no afirma su propio orden, y no se derivan saldos', () => {
    const { statement, validation } = prepare(
      [
        'Fecha;Descripcion;Cargo;Abono;Saldo',
        '03/02/2026;A;1.000;;99.000',
        '03/02/2026;B;1.000;;98.000',
      ].join('\n'),
    );

    expect(statement.openingBalance).toBeUndefined();
    expect(statement.closingBalance).toBeUndefined();
    expect(validation.issues.some((i) => i.code === 'balance-order-ambiguous')).toBe(true);
  });

  it('un archivo de una sola fila sí tiene extremos', () => {
    const { statement } = prepare(
      ['Fecha;Descripcion;Cargo;Abono;Saldo', '03/02/2026;A;1.000;;99.000'].join('\n'),
    );

    expect(statement.openingBalance?.amount.minor).toBe(100_000);
    expect(statement.closingBalance?.amount.minor).toBe(99_000);
  });

  it('un empate en medio no impide nada: los extremos siguen siendo únicos', () => {
    const { statement } = prepare(
      [
        'Fecha;Descripcion;Cargo;Abono;Saldo',
        '03/02/2026;A;1.000;;99.000',
        '04/02/2026;B;1.000;;98.000',
        '04/02/2026;C;1.000;;97.000',
        '05/02/2026;D;1.000;;96.000',
      ].join('\n'),
    );

    expect(statement.openingBalance?.amount.minor).toBe(100_000);
    expect(statement.closingBalance?.amount.minor).toBe(96_000);
  });
});
