import { describe, expect, it } from 'vitest';
import { computeFileHash } from '../src/core/dedupe/fingerprint';
import { getParser } from '../src/core/providers/registry';
import { loadWorkbook } from '../src/core/parsing/workbook';
import { fromText } from './fixtures';

/**
 * Cómo `banco-chile.cuenta-corriente` resuelve el año de una fecha `dd/mm`.
 *
 * Calibrado 2026-09 contra 8 cartolas reales: el archivo nunca declara un
 * período `desde/hasta`, sólo una `Fecha de Emisión` (fecha completa) en el
 * preámbulo y dos filas contables fijas, `SALDO INICIAL` y `SALDO FINAL`, cuyo
 * `dd/mm` es el límite de la cartola — con `SALDO FINAL` compartiendo siempre
 * día/mes con la emisión (confirmado en las 8, incluida una que cruza
 * diciembre → enero). Ver `derivePeriodFromBalanceRows`
 * (core/providers/profile-parser.ts) y `StatementProfile.periodFromBalanceRows`.
 *
 * Cada test de acá prueba una promesa distinta de esa derivación, y cada
 * promesa rota debe fallar cerrado — nunca inventar un año.
 */

function parse(rows: string[]) {
  const parser = getParser('banco-chile.cuenta-corriente')!;
  const text = [
    'Banco de Chile - Cartola Cuenta Corriente',
    'Cuenta Corriente N: 00-999-11111-22',
    ...rows,
  ].join('\n');
  const file = fromText('cartola.csv', text);
  return parser.parse({
    file,
    sheets: loadWorkbook(file).sheets,
    fileHash: computeFileHash(file.bytes),
    accountId: 'acc-banco-chile',
  });
}

const HEADER = 'Fecha;Descripcion;Canal o Sucursal;Cargos (PESOS);Abonos (PESOS);Saldo (PESOS)';

describe('período dentro del mismo año', () => {
  const statement = parse([
    'Fecha de Emision: 10/05/2026',
    '',
    HEADER,
    '01/05;SALDO INICIAL;;;;500.000',
    '05/05;COMPRA UNO;INTERNET;20.000;;480.000',
    '10/05;SALDO FINAL;;;;480.000',
  ]);

  it('resuelve el período desde SALDO INICIAL/FINAL y la emisión', () => {
    expect(statement.period).toEqual({ from: '2026-05-01', to: '2026-05-10' });
  });

  it('resuelve el año del movimiento dentro de ese período', () => {
    expect(statement.rowStats.failed).toBe(0);
    expect(statement.transactions).toHaveLength(1);
    expect(statement.transactions[0]!.date).toBe('2026-05-05');
  });

  it('SALDO INICIAL y SALDO FINAL nunca se convierten en Activities', () => {
    expect(
      statement.transactions.some((t) => /^SALDO\s+(INICIAL|FINAL)/i.test(t.description)),
    ).toBe(false);
  });
});

describe('período que cruza diciembre a enero (caso real observado)', () => {
  const statement = parse([
    'Fecha de Emision: 03/01/2026',
    '',
    HEADER,
    '28/12;SALDO INICIAL;;;;100.000',
    '30/12;COMPRA DICIEMBRE;INTERNET;10.000;;90.000',
    '02/01;COMPRA ENERO;INTERNET;5.000;;85.000',
    '03/01;SALDO FINAL;;;;85.000',
  ]);

  it('el límite inicial queda en el año anterior al de la emisión', () => {
    expect(statement.period).toEqual({ from: '2025-12-28', to: '2026-01-03' });
  });

  it('cada movimiento cae en el año de su propio lado del corte', () => {
    expect(statement.rowStats.failed).toBe(0);
    expect(statement.transactions.map((t) => t.date)).toEqual(['2025-12-30', '2026-01-02']);
  });
});

describe('SALDO FINAL no comparte día/mes con la Fecha de Emisión', () => {
  const statement = parse([
    'Fecha de Emision: 11/05/2026',
    '',
    HEADER,
    '01/05;SALDO INICIAL;;;;500.000',
    '05/05;COMPRA UNO;INTERNET;20.000;;480.000',
    // SALDO FINAL queda en 10/05, no 11/05 como declara la emisión.
    '10/05;SALDO FINAL;;;;480.000',
  ]);

  it('rechaza en vez de adivinar el año', () => {
    expect(statement.transactions).toHaveLength(0);
    expect(statement.rowStats.failed).toBe(1);
    expect(statement.issues.some((i) => i.code === 'no-transactions')).toBe(true);
  });
});

describe('sin Fecha de Emisión en el preámbulo', () => {
  const statement = parse([
    HEADER,
    '01/05;SALDO INICIAL;;;;500.000',
    '05/05;COMPRA UNO;INTERNET;20.000;;480.000',
    '10/05;SALDO FINAL;;;;480.000',
  ]);

  it('rechaza en vez de adivinar el año', () => {
    expect(statement.transactions).toHaveLength(0);
    expect(statement.rowStats.failed).toBe(1);
  });
});

describe('falta SALDO INICIAL o SALDO FINAL', () => {
  it('sin SALDO INICIAL, rechaza', () => {
    const statement = parse([
      'Fecha de Emision: 10/05/2026',
      '',
      HEADER,
      '05/05;COMPRA UNO;INTERNET;20.000;;480.000',
      '10/05;SALDO FINAL;;;;480.000',
    ]);
    expect(statement.transactions).toHaveLength(0);
    expect(statement.rowStats.failed).toBe(1);
  });

  it('sin SALDO FINAL, rechaza', () => {
    const statement = parse([
      'Fecha de Emision: 10/05/2026',
      '',
      HEADER,
      '01/05;SALDO INICIAL;;;;500.000',
      '05/05;COMPRA UNO;INTERNET;20.000;;480.000',
    ]);
    expect(statement.transactions).toHaveLength(0);
    expect(statement.rowStats.failed).toBe(1);
  });
});

describe('un movimiento cae fuera del intervalo resuelto', () => {
  const statement = parse([
    'Fecha de Emision: 10/02/2026',
    '',
    HEADER,
    '01/02;SALDO INICIAL;;;;500.000',
    '05/02;COMPRA DENTRO;INTERNET;10.000;;490.000',
    // Mismo mes que el período, pero el día cae después del cierre.
    '15/02;COMPRA FUERA;INTERNET;20.000;;470.000',
    '10/02;SALDO FINAL;;;;470.000',
  ]);

  it('importa la fila dentro del intervalo y rechaza la que cae fuera', () => {
    expect(statement.transactions).toHaveLength(1);
    expect(statement.transactions[0]!.description).toContain('DENTRO');
    expect(statement.rowStats.failed).toBe(1);
    const issue = statement.issues.find(
      (i) => i.code === 'row-parse-failed' && /fuera del per[ií]odo/i.test(i.message),
    );
    expect(issue).toBeDefined();
  });
});
