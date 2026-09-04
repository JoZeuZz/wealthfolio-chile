import { describe, expect, it } from 'vitest';
import { money } from '../src/core/money';
import { currenciesOf, summarizeByCurrency } from '../src/core/metrics/monthly';
import { TransactionKind } from '../src/core/model/kinds';
import { buildDuplicateIndex } from '../src/core/dedupe/classify';
import { prepareImport } from '../src/core/pipeline';
import { fromText, makeTransaction } from './fixtures';

/**
 * Más de una moneda.
 *
 * Sumar CLP con USD sin tipo de cambio da un número inventado, así que
 * `summarizeMonth` se niega. Pero negarse dejaba el panel entero en un mensaje
 * de error: quien tiene una cuenta en dólares no veía tampoco sus totales en
 * pesos. Separar por moneda dice la verdad y además la dice completa.
 *
 * `ExchangeRatesAPI` del SDK 3.7.0 expone `getAll`, `update` y `add`: tipos
 * vigentes, no históricos. Convertir un movimiento de hace ocho meses con el
 * tipo de hoy sería otro número inventado, sólo que más difícil de detectar.
 */

const clp = (amount: number, date: string) =>
  makeTransaction({ amount, date, description: 'MOVIMIENTO CLP' });

const usd = (amount: number, date: string) => ({
  ...makeTransaction({ amount, date, description: 'MOVIMIENTO USD' }),
  amount: money(amount, 2, 'USD'),
});

describe('currenciesOf', () => {
  it('lista las monedas presentes, en orden estable', () => {
    expect(currenciesOf([usd(-1000, '2026-02-03'), clp(-50000, '2026-02-04')])).toEqual([
      'CLP',
      'USD',
    ]);
  });

  it('no inventa ninguna cuando no hay movimientos', () => {
    expect(currenciesOf([])).toEqual([]);
  });
});

describe('summarizeByCurrency', () => {
  const rows = [
    clp(-50000, '2026-02-04'),
    clp(900000, '2026-02-01'),
    usd(-1000, '2026-02-03'),
  ];

  it('devuelve un resumen por moneda, nunca uno mezclado', () => {
    const summaries = summarizeByCurrency('2026-02', rows);
    expect(summaries.map((s) => s.currency)).toEqual(['CLP', 'USD']);
  });

  it('cada resumen contiene sólo los movimientos de su moneda', () => {
    const [clpSummary, usdSummary] = summarizeByCurrency('2026-02', rows);
    expect(clpSummary?.summary.grossSpending).toEqual(money(50000, 0, 'CLP'));
    expect(usdSummary?.summary.grossSpending).toEqual(money(1000, 2, 'USD'));
  });

  it('ordena por cantidad de movimientos, de mayor a menor', () => {
    const summaries = summarizeByCurrency('2026-02', rows);
    expect(summaries[0]?.transactions).toHaveLength(2);
    expect(summaries[1]?.transactions).toHaveLength(1);
  });

  it('con una sola moneda devuelve exactamente un resumen', () => {
    const summaries = summarizeByCurrency('2026-02', [clp(-50000, '2026-02-04')]);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.currency).toBe('CLP');
  });

  it('sin movimientos devuelve la moneda de respaldo y totales en cero', () => {
    const summaries = summarizeByCurrency('2026-02', [], { fallbackCurrency: 'CLP' });
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.summary.grossSpending.minor).toBe(0);
  });

  it('nunca suma monedas distintas', () => {
    const summaries = summarizeByCurrency('2026-02', rows);
    for (const entry of summaries) {
      expect(entry.summary.grossSpending.currency).toBe(entry.currency);
      expect(entry.summary.income.currency).toBe(entry.currency);
    }
  });

  it('las devoluciones se agrupan con su propia moneda', () => {
    const summaries = summarizeByCurrency('2026-02', [
      clp(-100000, '2026-02-10'),
      { ...clp(20000, '2026-02-11'), kind: TransactionKind.refund },
      usd(-1000, '2026-02-12'),
    ]);
    const clpSummary = summaries.find((s) => s.currency === 'CLP');
    expect(clpSummary?.summary.refunds.minor).toBe(20000);
    expect(summaries.find((s) => s.currency === 'USD')?.summary.refunds.minor).toBe(0);
  });
});

/**
 * Una columna `Moneda` que se detecta y no se lee es peor que no detectarla.
 *
 * `ColumnRole.currency` existe, está en los sinónimos y se le reserva su
 * columna — y no tiene un solo lector fuera de `columns.ts`. La moneda de cada
 * fila salía del preámbulo, que a su vez cae en `profile.defaultCurrency`.
 *
 * Una cartola con `USD` y `CLP` en la misma columna guardaba las dos como CLP:
 * un cargo de USD 120,50 quedaba como $120 en vez de unos $115.000. Y
 * `matchStatementToAccount` comparaba después ese CLP inventado contra una
 * cuenta CLP y decía `compatible`, así que la guarda de moneda tampoco podía
 * atraparlo.
 */
describe('la columna de moneda del archivo', () => {
  function parse(rows: string[]) {
    return prepareImport({
      file: fromText('cartola.csv', ['Fecha;Descripcion;Moneda;Monto', ...rows].join('\n')),
      accountId: 'acc-1',
      parserId: 'generico.cuenta',
      rules: [],
      duplicateIndex: buildDuplicateIndex([]),
    });
  }

  it('bloquea la cartola cuando las filas no están todas en la misma moneda', () => {
    const prepared = parse([
      '01/02/2026;COMPRA AMAZON;USD;-120,50',
      '02/02/2026;COMPRA LIDER;CLP;-10.000',
    ]);

    expect(prepared.validation.ok).toBe(false);
    expect(prepared.validation.issues.map((i) => i.code)).toContain('mixed-currency');
  });

  it('cuando todas coinciden, esa moneda gana al preámbulo', () => {
    const prepared = parse([
      '01/02/2026;COMPRA AMAZON;USD;-120,50',
      '02/02/2026;SUSCRIPCION;USD;-9,99',
    ]);

    expect(prepared.validation.ok).toBe(true);
    expect(prepared.statement.account.currency).toBe('USD');
    expect(prepared.rows[0]?.transaction.amount.currency).toBe('USD');
  });

  it('sin columna de moneda nada cambia', () => {
    const prepared = prepareImport({
      file: fromText(
        'cartola.csv',
        ['Fecha;Descripcion;Monto;Saldo', '01/02/2026;COMPRA LIDER;-10.000;90.000'].join('\n'),
      ),
      accountId: 'acc-1',
      parserId: 'generico.cuenta',
      rules: [],
      duplicateIndex: buildDuplicateIndex([]),
    });

    expect(prepared.validation.ok).toBe(true);
    expect(prepared.rows[0]?.transaction.amount.currency).toBe('CLP');
  });
});

/**
 * `PESOS`, `$` y `CLP` son la misma moneda.
 *
 * `readCurrencyColumn` comparaba el texto crudo de la celda, así que una
 * cartola con `$` en unas filas y `CLP` en otras se declaraba mezclada, y una
 * que dijera `PESOS` en todas adoptaba literalmente `PESOS` como código de
 * moneda — que después no coincide con la cuenta CLP y bloquea una cartola
 * perfectamente normal. Además el barrido incluía los pies de tabla, así que un
 * `TOTAL DEL PERIODO;PESOS;…` bastaba para inventar una segunda moneda.
 */
describe('la columna de moneda se normaliza antes de comparar', () => {
  function parseRows(rows: string[]) {
    return prepareImport({
      file: fromText('cartola.csv', ['Fecha;Descripcion;Moneda;Monto', ...rows].join('\n')),
      accountId: 'acc-1',
      parserId: 'generico.cuenta',
      rules: [],
      duplicateIndex: buildDuplicateIndex([]),
    });
  }

  it('$ y CLP no son dos monedas', () => {
    const prepared = parseRows([
      '01/02/2026;COMPRA LIDER;$;-10.000',
      '02/02/2026;COMPRA PARIS;CLP;-20.000',
    ]);

    expect(prepared.validation.ok).toBe(true);
    expect(prepared.statement.account.currency).toBe('CLP');
  });

  it('una cartola que dice PESOS se importa como CLP, no como «PESOS»', () => {
    const prepared = parseRows(['01/02/2026;COMPRA LIDER;PESOS;-10.000']);

    expect(prepared.validation.ok).toBe(true);
    expect(prepared.rows[0]?.transaction.amount.currency).toBe('CLP');
  });

  it('un pie de tabla no inventa una segunda moneda', () => {
    const prepared = parseRows([
      '01/02/2026;COMPRA LIDER;CLP;-10.000',
      ';TOTAL DEL PERIODO;PESOS;-10.000',
    ]);

    expect(prepared.validation.ok).toBe(true);
    expect(prepared.validation.issues.map((i) => i.code)).not.toContain('mixed-currency');
  });

  it('una mezcla de verdad sigue bloqueando', () => {
    const prepared = parseRows([
      '01/02/2026;COMPRA AMAZON;USD;-120,50',
      '02/02/2026;COMPRA LIDER;CLP;-10.000',
    ]);

    expect(prepared.validation.ok).toBe(false);
    expect(prepared.validation.issues.map((i) => i.code)).toContain('mixed-currency');
  });

  it('una moneda que no reconocemos se conserva tal cual, en mayúsculas', () => {
    const prepared = parseRows(['01/02/2026;COMPRA;EUR;-10,00']);
    expect(prepared.rows[0]?.transaction.amount.currency).toBe('EUR');
  });
});
