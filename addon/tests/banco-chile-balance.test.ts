import { describe, expect, it } from 'vitest';
import { computeFileHash } from '../src/core/dedupe/fingerprint';
import { getParser } from '../src/core/providers/registry';
import { loadWorkbook } from '../src/core/parsing/workbook';
import { fromText } from './fixtures';

/**
 * El saldo declarado de `banco-chile.cuenta-corriente` no debe salir de un
 * preámbulo aplanado a texto libre.
 *
 * Estructura real (revisada a mano por el operador, sin exponer valores):
 * el preámbulo trae dos bloques tabulares, cada uno una fila de etiquetas
 * seguida de una fila de valores en las mismas columnas —
 * `Saldo Contable | Retenciones 24 Hrs. | Retenciones 48 Hrs.` es uno de
 * ellos. `readDeclaredBalances` (core/providers/profile-parser.ts) aplana
 * todo el preámbulo con `row.join(' ')` + `join('\n')` y busca "el primer
 * número después de la palabra SALDO CONTABLE" — y ese primer número es el
 * `24` de la etiqueta vecina "Retenciones 24 Hrs.", en la misma fila,
 * mucho antes de llegar al valor real de la fila siguiente.
 *
 * Este perfil ya tiene una fuente de verdad mejor para el saldo declarado:
 * las mismas filas ancla `SALDO INICIAL`/`SALDO FINAL` que
 * `periodFromBalanceRows` usa para el año, cuya propia celda de saldo es
 * exactamente la columna `Saldo (PESOS)` de un movimiento real — no texto
 * libre. `readBalances` debe preferir esa fuente sobre el escaneo genérico
 * de preámbulo cuando el perfil declara `periodFromBalanceRows`.
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

/**
 * El bloque matricial exacto que dispara el bug: la etiqueta de cierre
 * ("Saldo Contable") comparte fila con otra etiqueta que sí trae un número
 * pequeño incrustado ("Retenciones 24 Hrs."), a menos de 40 caracteres.
 */
const MATRIX_PREAMBLE_BLOCK = [
  'Saldo Contable;Retenciones 24 Hrs.;Retenciones 48 Hrs.',
  '2.010.500;0;0',
];

describe('saldo declarado: filas ancla, no el preámbulo aplanado', () => {
  // La última fila con movimiento no trae saldo (columna dispersa, como en
  // las 8 cartolas reales) — eso es justo lo que impide derivar el cierre
  // desde "el propio saldo de la última fila" y fuerza caer al declarado, que
  // es donde vive el bug si no se usa la fila ancla.
  const statement = parse([
    ...MATRIX_PREAMBLE_BLOCK,
    'Fecha de Emision: 10/05/2026',
    '',
    HEADER,
    '01/05;SALDO INICIAL;;;;500.000',
    '03/05;COMPRA UNO;INTERNET;20.000;;480.000',
    '07/05;COMPRA DOS;INTERNET;5.000;;',
    '10/05;SALDO FINAL;;;;475.000',
  ]);

  it('el saldo final declarado es el de la fila SALDO FINAL, no un número de una etiqueta vecina', () => {
    expect(statement.closingBalance?.amount.minor).toBe(475_000);
    expect(statement.closingBalance?.source).toBe('declared');
  });

  it('el saldo inicial declarado es el de la fila SALDO INICIAL', () => {
    expect(statement.openingBalance?.amount.minor).toBe(500_000);
  });

  it('el total reconcilia: sin balance-total-mismatch', () => {
    expect(statement.issues.some((i) => i.code === 'balance-total-mismatch')).toBe(false);
  });

  it('SALDO INICIAL y SALDO FINAL siguen sin ser Activities', () => {
    expect(
      statement.transactions.some((t) => /^SALDO\s+(INICIAL|FINAL)/i.test(t.description)),
    ).toBe(false);
  });
});

describe('sin filas ancla, el mecanismo de anclaje no aporta nada (ni bueno ni malo)', () => {
  it('sin SALDO INICIAL/SALDO FINAL, la lectura por filas ancla no encuentra nada que usar', () => {
    // Sin las filas, `findAnchorRowCell` no tiene qué devolver — el
    // comportamiento cae íntegro al mecanismo genérico preexistente, sin
    // regresión para un perfil que nunca tuvo esas filas.
    const statement = parse([
      'Fecha de Emision: 10/05/2026',
      '',
      HEADER,
      '05/05;COMPRA UNO;INTERNET;20.000;;480.000',
    ]);
    // Sin período resuelto (no hay filas ancla para inferir el año), la fila
    // falla por falta de año.
    expect(statement.transactions).toHaveLength(0);
    expect(statement.rowStats.failed).toBe(1);
  });
});
