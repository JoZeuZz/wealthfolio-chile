import { describe, expect, it } from 'vitest';
import { toDecimalString } from '../src/core/money';
import { Direction } from '../src/core/model/kinds';
import { getParser } from '../src/core/providers/registry';
import { fromText, fromXlsxCells, loadFixture } from './fixtures';
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
 * Evidencia estructural del contenedor XLS resuelve `Monto ($)` — checkpoint
 * posterior al de arriba.
 *
 * `pnpm calibrate --parser banco-chile.tarjeta` sobre las 2 muestras reales
 * Nacional (`Mov_Facturado.xls`, `(2)`), ahora con
 * `core/parsing/spreadsheet-cell-facts.ts`, reportó para `Monto ($)` en
 * ambas: `number / grouped-integer` — celda numérica nativa, formato Excel
 * sin decimales declarados y con agrupación. Eso es justo lo que el texto solo
 * no puede probar (`core/money.ts#splitDecimal`): que el separador agrupa
 * miles y no parte una fracción. `spreadsheetColumnStructuralEvidence`
 * gatea `spreadsheetColumnNumberFormats: { amount: 'en-US' }` en esa
 * evidencia — nunca en el conteo de decimales del texto.
 */
describe('Banco de Chile — tarjeta, evidencia estructural (XLS) para Monto ($)', () => {
  const parser = getParser('banco-chile.tarjeta')!;

  it('celda numérica nativa con formato entero agrupado resuelve sin bloquear', () => {
    const file = fromXlsxCells('mov-facturado-nacional.xlsx', [
      ['Fecha', 'Descripcion', 'Monto ($)', 'Cuotas'],
      ['05/02/2026', 'COMPRA SINTETICA', { value: 12450, numberFormat: '#,##0' }, ''],
    ]);
    const statement = parser.parse(inputForFile(file));
    const compra = statement.transactions[0]!;

    expect(compra.warnings.some((w) => w.code === 'ambiguous-amount-format')).toBe(false);
    expect(compra.amount).toMatchObject({ minor: -12450, scale: 0 });
    expect(parser.validate(statement).ok).toBe(true);
  });

  it('celda de TEXTO con el mismo dígito no trae evidencia estructural y sigue bloqueada', () => {
    const file = fromXlsxCells('mov-facturado-nacional.xlsx', [
      ['Fecha', 'Descripcion', 'Monto ($)', 'Cuotas'],
      ['05/02/2026', 'COMPRA SINTETICA', '12,450', ''],
    ]);
    const statement = parser.parse(inputForFile(file));
    const compra = statement.transactions[0]!;

    expect(compra.warnings.some((w) => w.code === 'ambiguous-amount-format')).toBe(true);
    expect(parser.validate(statement).ok).toBe(false);
  });

  it('un CSV del mismo banco no hereda la inferencia aunque el texto coincida', () => {
    // Mismo caso que el primer test de este archivo: CSV nunca trae metadato
    // de celda XLS, así que `isSpreadsheet` es falso y el override ni se evalúa.
    const file = fromText(
      'mov-facturado-nacional.csv',
      ['Fecha;Descripcion;Monto;Cuotas', '05/02/2026;COMPRA SINTETICA;12,450;'].join('\n'),
    );
    const statement = parser.parse(inputForFile(file));
    const compra = statement.transactions[0]!;

    expect(compra.warnings.some((w) => w.code === 'ambiguous-amount-format')).toBe(true);
    expect(parser.validate(statement).ok).toBe(false);
  });
});

/**
 * P1 (review independiente): metadata nativa EXPLÍCITA que contradice
 * `spreadsheetColumnStructuralEvidence`, no ausencia de metadata.
 *
 * Antes: si ni una fila cumplía TODAS las formas permitidas
 * (`integer`/`grouped-integer`/`currency-integer`), el override simplemente
 * no se aplicaba y la columna caía al parser léxico `es-CL` — que para un
 * único punto + cola de 3 dígitos NO es ambiguo (ver el primer describe de
 * este archivo), así que "12.450" se leía como 12450 sin ningún warning,
 * aunque la celda dijera explícitamente `decimal-3` (formato nativo `0.000`,
 * es decir 12,45 real). `spreadsheet-number-format-conflict` distingue esa
 * contradicción explícita de la mera ausencia (General/texto/sin metadata),
 * que sigue el comportamiento fail-closed existente vía
 * `ambiguous-amount-format`.
 */
describe('Banco de Chile — tarjeta, conflicto de formato nativo contradictorio', () => {
  const parser = getParser('banco-chile.tarjeta')!;

  it('XLSX: decimal-3 nativo explícito contradice integer/grouped-integer/currency-integer y bloquea', () => {
    const file = fromXlsxCells('mov-facturado-nacional-contradiccion.xlsx', [
      ['Fecha', 'Descripcion', 'Monto ($)', 'Cuotas'],
      ['05/02/2026', 'COMPRA SINTETICA', { value: 12.45, numberFormat: '0.000' }, ''],
    ]);
    const statement = parser.parse(inputForFile(file));

    expect(statement.issues.some((i) => i.code === 'spreadsheet-number-format-conflict')).toBe(true);
    expect(parser.validate(statement).ok).toBe(false);
  });

  it('XLS (mismo contenido, extensión .xls): mismo bloqueo', () => {
    const file = fromXlsxCells('mov-facturado-nacional-contradiccion.xls', [
      ['Fecha', 'Descripcion', 'Monto ($)', 'Cuotas'],
      ['05/02/2026', 'COMPRA SINTETICA', { value: 12.45, numberFormat: '0.000' }, ''],
    ]);
    const statement = parser.parse(inputForFile(file));

    expect(statement.issues.some((i) => i.code === 'spreadsheet-number-format-conflict')).toBe(true);
    expect(parser.validate(statement).ok).toBe(false);
  });

  it('ausencia (General, sin metadata explícita) NO dispara el conflicto — sigue el fail-closed existente', () => {
    const file = fromXlsxCells('mov-facturado-nacional-general.xlsx', [
      ['Fecha', 'Descripcion', 'Monto ($)', 'Cuotas'],
      ['05/02/2026', 'COMPRA SINTETICA', { value: 12450 }, ''],
    ]);
    const statement = parser.parse(inputForFile(file));

    expect(statement.issues.some((i) => i.code === 'spreadsheet-number-format-conflict')).toBe(false);
  });

  it('celda de texto (no nativa) tampoco dispara el conflicto — sigue bloqueada por ambigüedad léxica, no por conflicto', () => {
    const file = fromXlsxCells('mov-facturado-nacional-texto.xlsx', [
      ['Fecha', 'Descripcion', 'Monto ($)', 'Cuotas'],
      ['05/02/2026', 'COMPRA SINTETICA', '12,450', ''],
    ]);
    const statement = parser.parse(inputForFile(file));

    expect(statement.issues.some((i) => i.code === 'spreadsheet-number-format-conflict')).toBe(false);
    expect(statement.transactions[0]?.warnings.some((w) => w.code === 'ambiguous-amount-format')).toBe(
      true,
    );
  });

  it('el caso ya cubierto (grouped-integer coincidente) sigue resolviendo sin conflicto', () => {
    const file = fromXlsxCells('mov-facturado-nacional-ok.xlsx', [
      ['Fecha', 'Descripcion', 'Monto ($)', 'Cuotas'],
      ['05/02/2026', 'COMPRA SINTETICA', { value: 12450, numberFormat: '#,##0' }, ''],
    ]);
    const statement = parser.parse(inputForFile(file));

    expect(statement.issues.some((i) => i.code === 'spreadsheet-number-format-conflict')).toBe(false);
    expect(parser.validate(statement).ok).toBe(true);
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
