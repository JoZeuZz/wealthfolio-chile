import { describe, expect, it } from 'vitest';
import { toDecimalString } from '../src/core/money';
import { Direction } from '../src/core/model/kinds';
import { getParser } from '../src/core/providers/registry';
import { fromText, loadFixture } from './fixtures';
import { computeFileHash } from '../src/core/dedupe/fingerprint';
import { loadWorkbook } from '../src/core/parsing/workbook';
import type { ParserInput } from '../src/core/providers/parser';
import type { SourceFile } from '../src/core/parsing/tabular';

function inputForFile(file: SourceFile): ParserInput {
  return { file, sheets: loadWorkbook(file).sheets, fileHash: computeFileHash(file.bytes) };
}

/**
 * Escala monetaria de "Movimientos Nacionales" — la única pregunta con
 * "prioridad máxima" de este checkpoint.
 *
 * Las 2 muestras reales Nacional (`Mov_Facturado.xls`, `(2)`), leídas sólo con
 * `pnpm calibrate`, siguen reportando `Decimales: 1 filas con 3` y
 * `[warning] ambiguous-amount-format` — el mismo problema de antes, no
 * resuelto por el fix de detección/bloqueo internacional (que no tocó
 * `Monto ($)`). Bajo `numberFormat: 'es-CL'` (`core/money.ts#splitDecimal`),
 * un único punto seguido de 3 dígitos (`38.500`) es miles, NO ambiguo, scale
 * 0 — eso es lo que las cuentas corrientes de Banco de Chile ya prueban. Una
 * única COMA seguida de 3 dígitos (`12,450`) sí es la lectura ambigua: es-CL
 * espera coma como decimal de 2 dígitos, no de 3, así que no se sabe si es
 * miles al revés o una fracción real — exactamente el caso que
 * `banco-estado.cuenta` ya bloquea (`ambiguousAmountCheck: 'authoritative'`).
 *
 * Sólo hay una fila real por muestra: no alcanza para probar un patrón de
 * miles repetido (lo que habilitaría un override tipo
 * `spreadsheetColumnNumberFormatEvidence`, como el que ya existe para
 * BancoEstado). Sin esa evidencia, adivinar el formato replica exactamente el
 * error que este proyecto considera el más caro; la respuesta correcta es
 * bloquear, no adivinar.
 */
describe('Banco de Chile — tarjeta, escala monetaria Nacional', () => {
  const parser = getParser('banco-chile.tarjeta')!;

  it('un monto con coma y 3 dígitos (es-CL) es ambiguo y bloquea la validación', () => {
    const file = fromText(
      'mov-facturado-nacional.csv',
      ['Fecha;Descripcion;Monto;Cuotas', '05/02/2026;COMPRA SINTETICA;12,450;'].join('\n'),
    );
    const statement = parser.parse(inputForFile(file));
    const compra = statement.transactions[0]!;

    expect(toDecimalString(compra.amount)).not.toBe('-12450');
    expect(compra.warnings.some((w) => w.code === 'ambiguous-amount-format')).toBe(true);
    expect(parser.validate(statement).ok).toBe(false);
  });

  it('un monto con punto y 3 dígitos (es-CL) no es ambiguo: son miles, no decimales', () => {
    const file = fromText(
      'mov-facturado-nacional.csv',
      ['Fecha;Descripcion;Monto;Cuotas', '05/02/2026;COMPRA SINTETICA;38.500;'].join('\n'),
    );
    const statement = parser.parse(inputForFile(file));
    const compra = statement.transactions[0]!;

    expect(compra.warnings.some((w) => w.code === 'ambiguous-amount-format')).toBe(false);
    expect(compra.amount).toMatchObject({ minor: -38500, scale: 0 });
    expect(parser.validate(statement).ok).toBe(true);
  });

  it('el fixture sintético existente (miles-punto, sin ambigüedad) sigue pasando entero', () => {
    const parsed = parser.parse(inputForFile(loadFixture('banco-chile-tarjeta.csv')));
    expect(parsed.rowStats).toMatchObject({ mapped: 7, failed: 0 });
    expect(parsed.transactions.every((t) => !t.warnings.some((w) => w.code === 'ambiguous-amount-format'))).toBe(
      true,
    );
  });
});

/**
 * Signo — alcance exacto de lo demostrado.
 *
 * Las 2 muestras reales Nacional sólo traen, cada una, UNA fila y es una
 * compra (`Entradas/salidas/cero: 0/1/0`, `credit_card_purchase`, vía
 * `pnpm calibrate`). Eso confirma únicamente "cargo/compra positiva del
 * export -> outflow" para `amountSign: 'debit-positive'`. No hay ninguna fila
 * real de pago, devolución o reverso en estas 2 muestras — esta prueba fija
 * exactamente ese alcance limitado, no una regla general sobre abonos.
 */
describe('Banco de Chile — tarjeta, signo Nacional (alcance limitado)', () => {
  it('una compra positiva del export es un outflow clasificado como credit_card_purchase', () => {
    const parser = getParser('banco-chile.tarjeta')!;
    const parsed = parser.parse(inputForFile(loadFixture('banco-chile-tarjeta.csv')));
    const compra = parsed.transactions[0]!;

    expect(compra.direction).toBe(Direction.out);
    expect(compra.kind).toBe('credit_card_purchase');
  });
});
