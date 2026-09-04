import { describe, expect, it } from 'vitest';
import { buildDuplicateIndex } from '../src/core/dedupe/classify';
import { buildInsights } from '../src/core/insights/rules';
import {
  currencyOf,
  summarizeAll,
  summarizeMonth,
  totalsByCategory,
  totalsByMerchant,
} from '../src/core/metrics/monthly';
import { normalizeMerchant } from '../src/core/merchants/normalize';
import { money, toDecimalString } from '../src/core/money';
import { Confidence, Direction, TransactionKind } from '../src/core/model/kinds';
import type { NormalizedTransaction } from '../src/core/model/transaction';
import { prepareImport } from '../src/core/pipeline';
import { applyRules, type Rule } from '../src/core/rules/engine';
import { defaultRules } from '../src/core/rules/builtin';
import { normalizeDescription } from '../src/core/text';
import { loadFixture } from './fixtures';

let counter = 0;

function tx(
  date: string,
  amount: number,
  description: string,
  extra: Partial<NormalizedTransaction> = {},
): NormalizedTransaction {
  counter += 1;
  const value = money(amount, 0, 'CLP');
  return {
    sourceInstitution: 'banco-chile',
    sourceParser: 'test',
    sourceParserVersion: '1.0.0',
    sourceFileHash: 'hash',
    fingerprint: `fp-${counter}`,
    date,
    description,
    normalizedDescription: normalizeDescription(description),
    amount: value,
    direction: amount < 0 ? Direction.out : Direction.in,
    kind: amount < 0 ? TransactionKind.expense : TransactionKind.income,
    kindConfidence: Confidence.confirmed,
    tags: [],
    warnings: [],
    rawMetadata: {},
    ...extra,
  };
}

describe('normalizeMerchant', () => {
  it('peels the processor off a Webpay purchase', () => {
    const result = normalizeMerchant('COMPRA INT WEBPAY TRANSBANK 1234 SUPERMERCADO LIDER LAS CONDES');
    expect(result.merchant).toBe('Lider');
    expect(result.processor).toBe('Webpay');
  });

  it('resolves brand aliases to one name', () => {
    expect(normalizeMerchant('WALMART CHILE SA').merchant).toBe('Lider');
    expect(normalizeMerchant('HOMECENTER SODIMAC MAIPU').merchant).toBe('Sodimac');
  });

  it('strips reference noise and card tails', () => {
    expect(normalizeMerchant('UBER *TRIP 4821 SANTIAGO').merchant).toBe('Uber');
  });

  it('groups the same merchant despite varying reference numbers', () => {
    const a = normalizeMerchant('COMPRA REDCOMPRA PANADERIA SAN JOSE 4821');
    const b = normalizeMerchant('COMPRA REDCOMPRA PANADERIA SAN JOSE 9930');
    expect(a.key).toBe(b.key);
  });

  it('returns nothing rather than inventing a merchant', () => {
    expect(normalizeMerchant('COMPRA').merchant).toBeUndefined();
    expect(normalizeMerchant('').merchant).toBeUndefined();
  });
});

describe('rule engine', () => {
  const context = { accountId: 'a', accountName: 'Cuenta' };

  it('applies actions in priority order and records what fired', () => {
    const rules: Rule[] = [
      {
        id: 'r1',
        name: 'Genérica',
        enabled: true,
        priority: 100,
        match: 'any',
        conditions: [{ field: 'description', operator: 'contains', value: 'LIDER' }],
        actions: [{ type: 'set_category', value: 'compras' }],
        origin: 'user',
      },
      {
        id: 'r0',
        name: 'Específica',
        enabled: true,
        priority: 10,
        match: 'any',
        conditions: [{ field: 'description', operator: 'contains', value: 'LIDER' }],
        actions: [{ type: 'set_category', value: 'alimentacion.supermercado' }],
        origin: 'user',
        stopProcessing: true,
      },
    ];

    const outcome = applyRules(tx('2026-02-04', -10000, 'COMPRA LIDER'), rules, context);

    expect(outcome.transaction.category).toBe('alimentacion.supermercado');
    expect(outcome.transaction.appliedRules).toEqual(['r0']);
  });

  it('matches numeric ranges', () => {
    const rules: Rule[] = [
      {
        id: 'big',
        name: 'Compras grandes',
        enabled: true,
        priority: 1,
        match: 'all',
        conditions: [{ field: 'absAmount', operator: 'gte', value: 100000 }],
        actions: [{ type: 'add_tag', value: 'grande' }],
        origin: 'user',
      },
    ];

    expect(applyRules(tx('2026-02-04', -150000, 'X'), rules, context).transaction.tags).toContain(
      'grande',
    );
    expect(applyRules(tx('2026-02-04', -1000, 'X'), rules, context).transaction.tags).toEqual([]);
  });

  it('requires every condition under match:all', () => {
    const rules: Rule[] = [
      {
        id: 'both',
        name: 'Ambas',
        enabled: true,
        priority: 1,
        match: 'all',
        conditions: [
          { field: 'description', operator: 'contains', value: 'UBER' },
          { field: 'absAmount', operator: 'gt', value: 50000 },
        ],
        actions: [{ type: 'add_tag', value: 'caro' }],
        origin: 'user',
      },
    ];

    expect(applyRules(tx('2026-02-04', -5000, 'UBER TRIP'), rules, context).transaction.tags).toEqual(
      [],
    );
  });

  it('disables a rule with a broken regular expression instead of failing', () => {
    const rules: Rule[] = [
      {
        id: 'bad',
        name: 'Regex inválida',
        enabled: true,
        priority: 1,
        match: 'any',
        conditions: [{ field: 'description', operator: 'matches', value: '([' }],
        actions: [{ type: 'add_tag', value: 'x' }],
        origin: 'user',
      },
    ];

    expect(() => applyRules(tx('2026-02-04', -1000, 'X'), rules, context)).not.toThrow();
  });

  it('skips disabled rules', () => {
    const rules = defaultRules().map((rule) => ({ ...rule, enabled: false }));
    const outcome = applyRules(tx('2026-02-04', -10000, 'COMPRA LIDER'), rules, context);
    expect(outcome.transaction.category).toBeUndefined();
  });
});

describe('monthly summary', () => {
  const rows = [
    tx('2026-02-03', 1000000, 'SUELDO', { category: 'ingresos.sueldo' }),
    tx('2026-02-05', -300000, 'ARRIENDO', { category: 'vivienda.arriendo' }),
    tx('2026-02-06', -100000, 'SUPERMERCADO', { category: 'alimentacion.supermercado' }),
    tx('2026-02-07', -200000, 'TRASPASO', { kind: TransactionKind.internal_transfer }),
    tx('2026-02-08', -150000, 'PAGO TARJETA', { kind: TransactionKind.credit_card_payment }),
  ];

  const summary = summarizeMonth('2026-02', rows);

  it('excludes transfers and card payments from income and expenses', () => {
    expect(toDecimalString(summary.income)).toBe('1000000');
    expect(toDecimalString(summary.grossSpending)).toBe('400000');
    expect(toDecimalString(summary.internalTransfers)).toBe('200000');
    expect(toDecimalString(summary.cardPayments)).toBe('150000');
  });

  it('computes the net flow and savings rate', () => {
    expect(toDecimalString(summary.netCashFlow)).toBe('600000');
    expect(summary.savingsRate).toBeCloseTo(0.6, 5);
  });

  it('splits fixed from variable spending', () => {
    expect(toDecimalString(summary.fixedExpenses)).toBe('300000');
    expect(toDecimalString(summary.variableExpenses)).toBe('100000');
  });

  it('omits the savings rate when there was no income', () => {
    expect(summarizeMonth('2026-03', [tx('2026-03-01', -1000, 'X')]).savingsRate).toBeUndefined();
  });

  it('buckets months independently', () => {
    const all = summarizeAll([...rows, tx('2026-03-01', -50000, 'OTRO')]);
    expect(all.map((s) => s.month)).toEqual(['2026-02', '2026-03']);
  });
});

describe('category and merchant totals', () => {
  const rows = [
    tx('2026-02-05', -300000, 'ARRIENDO', { category: 'vivienda.arriendo', merchant: 'Arrendador' }),
    tx('2026-02-06', -100000, 'LIDER', { category: 'alimentacion.supermercado', merchant: 'Lider' }),
    tx('2026-02-09', -50000, 'LIDER', { category: 'alimentacion.supermercado', merchant: 'Lider' }),
  ];

  it('ranks categories by amount with shares that sum to one', () => {
    const totals = totalsByCategory(rows);
    expect(totals[0]!.category).toBe('vivienda.arriendo');
    expect(totals[1]!.transactionCount).toBe(2);
    expect(totals.reduce((sum, t) => sum + t.share, 0)).toBeCloseTo(1, 5);
  });

  it('ranks merchants by amount', () => {
    const totals = totalsByMerchant(rows);
    expect(totals[1]!.merchant).toBe('Lider');
    expect(toDecimalString(totals[1]!.amount)).toBe('150000');
  });
});

describe('insights', () => {
  const current = summarizeMonth('2026-02', [
    tx('2026-02-03', 1000000, 'SUELDO'),
    tx('2026-02-06', -400000, 'RESTAURANTES', { category: 'alimentacion.restaurantes' }),
  ]);
  const previous = summarizeMonth('2026-01', [
    tx('2026-01-03', 1000000, 'SUELDO'),
    tx('2026-01-06', -200000, 'RESTAURANTES', { category: 'alimentacion.restaurantes' }),
  ]);

  it('reports a significant increase with the figures behind it', () => {
    const insights = buildInsights({
      month: '2026-02',
      current,
      previous,
      categories: totalsByCategory([
        tx('2026-02-06', -400000, 'RESTAURANTES', { category: 'alimentacion.restaurantes' }),
      ]),
      previousCategories: totalsByCategory([
        tx('2026-01-06', -200000, 'RESTAURANTES', { category: 'alimentacion.restaurantes' }),
      ]),
      merchants: [],
      recurring: [],
    });

    const increase = insights.find((insight) => insight.id.startsWith('category-change'));
    expect(increase?.message).toContain('aumentó 100%');
    expect(increase?.detail).toContain('$200.000');
  });

  it('stays quiet about changes below the noise threshold', () => {
    const flat = summarizeMonth('2026-02', [
      tx('2026-02-03', 1000000, 'SUELDO'),
      tx('2026-02-06', -205000, 'RESTAURANTES', { category: 'alimentacion.restaurantes' }),
    ]);
    const insights = buildInsights({
      month: '2026-02',
      current: flat,
      previous,
      categories: [],
      merchants: [],
      recurring: [],
    });
    expect(insights.find((insight) => insight.id === 'expenses-change')).toBeUndefined();
  });

  it('never divides by a zero baseline', () => {
    const zeroBaseline = summarizeMonth('2026-01', []);
    const insights = buildInsights({
      month: '2026-02',
      current,
      previous: zeroBaseline,
      categories: [],
      merchants: [],
      recurring: [],
    });
    expect(insights.every((insight) => !insight.message.includes('Infinity'))).toBe(true);
    expect(insights.every((insight) => !insight.message.includes('NaN'))).toBe(true);
  });
});

describe('metrics over an imported statement', () => {
  it('produces a coherent monthly picture from the fixture', () => {
    const prepared = prepareImport({
      file: loadFixture('banco-chile-cuenta-corriente.csv'),
      accountId: 'acct',
      rules: defaultRules(),
      duplicateIndex: buildDuplicateIndex([]),
    });

    const summary = summarizeMonth(
      '2026-02',
      prepared.rows.map((row) => row.transaction),
    );

    expect(toDecimalString(summary.income)).toBe(toDecimalString(prepared.totals.income));
    expect(toDecimalString(summary.grossSpending)).toBe(toDecimalString(prepared.totals.expenses));
  });
});

/**
 * Observed on a real Wealthfolio v3.6.2 container on 2026-08-07: a fresh
 * instance reports `baseCurrency: 'USD'`, and the panel was handing that to the
 * metrics as the currency to total CLP movements in. The first import turned
 * the whole panel into `MoneyError: currency mismatch: USD vs CLP` — a blank
 * page, no message, for every Chilean user on a default host.
 *
 * The totals are sums of the imported movements, so their currency is a fact
 * about the data. The host's reporting preference is not a vote.
 */
describe('the currency the totals are expressed in', () => {
  it('comes from the movements, not from the caller', () => {
    const rows = [
      tx('2026-02-03', 1_000_000, 'SUELDO'),
      tx('2026-02-04', -100_000, 'SUPERMERCADO'),
    ];

    expect(currencyOf(rows, 'USD')).toBe('CLP');
  });

  it('falls back to the caller only when there is nothing to total', () => {
    expect(currencyOf([], 'USD')).toBe('USD');
  });

  it('reports mixed currencies instead of picking one', () => {
    const rows = [
      tx('2026-02-03', 1_000_000, 'SUELDO'),
      { ...tx('2026-02-04', -1_000, 'COMPRA EN DOLARES'), amount: money(-1_000, 0, 'USD') },
    ];

    expect(() => currencyOf(rows, 'CLP')).toThrow(/CLP.*USD|USD.*CLP/);
  });

  it('totals a CLP month without exploding when the host reports USD', () => {
    const rows = [
      tx('2026-02-03', 1_000_000, 'SUELDO'),
      tx('2026-02-04', -100_000, 'SUPERMERCADO'),
      tx('2026-02-05', -50_000, 'COMBUSTIBLE'),
    ];

    const summary = summarizeMonth('2026-02', rows, { currency: currencyOf(rows, 'USD') });

    expect(toDecimalString(summary.income)).toBe('1000000');
    expect(toDecimalString(summary.grossSpending)).toBe('150000');
    expect(toDecimalString(summary.netCashFlow)).toBe('850000');
  });
});
