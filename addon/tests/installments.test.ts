import { describe, expect, it } from 'vitest';
import { buildDuplicateIndex } from '../src/core/dedupe/classify';
import {
  detectInstallment,
  detectRemainingInstallments,
  mentionsInstallments,
} from '../src/core/installments/detect';
import { buildInstallmentPlans, buildOutlook } from '../src/core/installments/plans';
import { money, toDecimalString } from '../src/core/money';
import { Confidence, Direction, TransactionKind } from '../src/core/model/kinds';
import type { NormalizedTransaction } from '../src/core/model/transaction';
import { prepareImport } from '../src/core/pipeline';
import { defaultRules } from '../src/core/rules/builtin';
import { StatementProduct } from '../src/core/model/statement';
import { normalizeDescription } from '../src/core/text';
import { loadFixture, makeTransaction } from './fixtures';

describe('detectInstallment', () => {
  it('reads an explicit CUOTA n DE m', () => {
    expect(detectInstallment('FALABELLA CUOTA 2 DE 6')).toMatchObject({
      current: 2,
      total: 6,
      confidence: Confidence.confirmed,
    });
  });

  it('reads CUOTA n/m', () => {
    expect(detectInstallment('SODIMAC CUOTA 3/12')).toMatchObject({ current: 3, total: 12 });
  });

  it('reads the trailing word order', () => {
    expect(detectInstallment('PARIS 2 DE 6 CUOTAS')).toMatchObject({ current: 2, total: 6 });
  });

  it('reads a dedicated column as authoritative', () => {
    expect(detectInstallment('COMPRA CUALQUIERA', '3 de 12')).toMatchObject({
      current: 3,
      total: 12,
      confidence: Confidence.confirmed,
    });
  });

  it('treats a bare n/m as a suggestion, never a fact', () => {
    // `1/3` es también el 1 de marzo, así que sólo cuenta como cuota donde
    // existen las cuotas. Ver «una fecha suelta no es un plan de cuotas».
    expect(
      detectInstallment('RIPLEY MALL 1/3', '', { product: StatementProduct.credit_card }),
    ).toMatchObject({
      current: 1,
      total: 3,
      confidence: Confidence.suggested,
    });
  });

  it('does not promote a date-shaped 03/06 to a confirmed plan', () => {
    const result = detectInstallment('COMPRA ALGO 03/06', '', {
      product: StatementProduct.credit_card,
    });
    expect(result?.confidence).toBe(Confidence.suggested);
  });

  it('returns nothing when there is no counter at all', () => {
    expect(detectInstallment('COMPRA SUPERMERCADO LIDER')).toBeUndefined();
  });

  it('rejects an impossible plan', () => {
    // Current beyond total, and a plan longer than any Chilean retailer offers.
    expect(detectInstallment('CUOTA 7 DE 6')).toBeUndefined();
    expect(detectInstallment('CUOTA 1 DE 99')).toBeUndefined();
  });

  it('rejects a single-installment plan', () => {
    expect(detectInstallment('CUOTA 1 DE 1')).toBeUndefined();
  });

  it('notices a mention without a counter', () => {
    expect(mentionsInstallments('EN 6 CUOTAS SIN INTERES')).toBe(true);
    expect(mentionsInstallments('COMPRA LIDER')).toBe(false);
  });
});

describe('detectRemainingInstallments', () => {
  it('reads a bare remaining-count column', () => {
    expect(detectRemainingInstallments('3')).toBe(3);
  });

  it('reads zero — no plan open, not "no evidence"', () => {
    expect(detectRemainingInstallments('0')).toBe(0);
  });

  it('trims surrounding whitespace', () => {
    expect(detectRemainingInstallments('  5  ')).toBe(5);
  });

  it('rejects an n/m pair — that belongs to detectInstallment, not this', () => {
    expect(detectRemainingInstallments('2/6')).toBeUndefined();
    expect(detectRemainingInstallments('2 DE 6')).toBeUndefined();
  });

  it('rejects an empty cell', () => {
    expect(detectRemainingInstallments('')).toBeUndefined();
  });

  it('rejects text', () => {
    expect(detectRemainingInstallments('CUOTA UNICA')).toBeUndefined();
  });

  it('rejects a count past what any real plan reaches', () => {
    expect(detectRemainingInstallments('61')).toBeUndefined();
  });
});

let counter = 0;

function charge(
  merchant: string,
  date: string,
  amount: number,
  current: number,
  total: number,
): NormalizedTransaction {
  counter += 1;
  const description = `${merchant} CUOTA ${current} DE ${total}`;
  return {
    sourceInstitution: 'banco-falabella',
    sourceParser: 'test',
    sourceParserVersion: '1.0.0',
    sourceFileHash: 'hash',
    fingerprint: `fp-${counter}`,
    date,
    description,
    normalizedDescription: normalizeDescription(description),
    merchant,
    amount: money(-amount, 0, 'CLP'),
    direction: Direction.out,
    kind: TransactionKind.credit_card_purchase,
    kindConfidence: Confidence.suggested,
    tags: [],
    installment: {
      current,
      total,
      confidence: Confidence.confirmed,
      matchedText: `CUOTA ${current} DE ${total}`,
    },
    warnings: [],
    rawMetadata: {},
  };
}

describe('buildInstallmentPlans', () => {
  it('groups charges of one plan and projects what remains', () => {
    const plans = buildInstallmentPlans([
      charge('Falabella', '2026-01-04', 49990, 1, 6),
      charge('Falabella', '2026-02-04', 49990, 2, 6),
    ]);

    expect(plans).toHaveLength(1);
    const plan = plans[0]!;
    expect(plan.totalInstallments).toBe(6);
    expect(plan.currentInstallment).toBe(2);
    expect(plan.remainingInstallments).toBe(4);
    expect(toDecimalString(plan.remainingAmount)).toBe('199960');
    expect(toDecimalString(plan.originalAmount!)).toBe('299940');
    expect(plan.startDate).toBe('2026-01-04');
    expect(plan.estimatedEndDate).toBe('2026-06-04');
    expect(plan.hasGaps).toBe(false);
  });

  it('back-dates the start when the first cuota was never imported', () => {
    const plans = buildInstallmentPlans([charge('Sodimac', '2026-02-07', 35000, 3, 12)]);
    // Cuota 3 charged in February means the plan began in December.
    expect(plans[0]!.startDate).toBe('2025-12-07');
    expect(plans[0]!.estimatedEndDate).toBe('2026-11-07');
  });

  it('flags gaps so a partial projection is not mistaken for a complete one', () => {
    const plans = buildInstallmentPlans([
      charge('Paris', '2026-01-10', 20000, 1, 6),
      charge('Paris', '2026-03-10', 20000, 3, 6),
    ]);
    expect(plans[0]!.hasGaps).toBe(true);
  });

  it('keeps two different plans from the same merchant apart', () => {
    const plans = buildInstallmentPlans([
      charge('Falabella', '2026-02-04', 49990, 2, 6),
      charge('Falabella', '2026-02-04', 12000, 1, 3),
    ]);
    expect(plans).toHaveLength(2);
  });

  it('ignores movements with no installment marker', () => {
    const noCuota: NormalizedTransaction = {
      ...charge('Jumbo', '2026-02-04', 30000, 1, 6),
    };
    delete (noCuota as { installment?: unknown }).installment;
    expect(buildInstallmentPlans([noCuota])).toHaveLength(0);
  });

  it('un avance en cuotas no se convierte en plan de compra', () => {
    const advance = {
      ...charge('Avance', '2026-02-04', 50_000, 2, 12),
      kind: TransactionKind.cash_advance,
    };
    expect(buildInstallmentPlans([advance])).toHaveLength(0);
  });

  it('un pago de crédito en una cuenta no se convierte en plan de compra', () => {
    const loanPayment = {
      ...charge('Pago credito', '2026-02-04', 50_000, 2, 12),
      kind: TransactionKind.expense,
    };
    expect(buildInstallmentPlans([loanPayment])).toHaveLength(0);
  });

  it('produces the same plans regardless of charge order', () => {
    const charges = [
      charge('Falabella', '2026-01-04', 49990, 1, 6),
      charge('Falabella', '2026-02-04', 49990, 2, 6),
    ];
    const forward = buildInstallmentPlans(charges);
    const backward = buildInstallmentPlans([...charges].reverse());
    expect(backward[0]!.id).toBe(forward[0]!.id);
    expect(backward[0]!.remainingInstallments).toBe(forward[0]!.remainingInstallments);
  });
});

describe('buildOutlook', () => {
  it('projects the committed amount month by month', () => {
    const plans = buildInstallmentPlans([
      charge('Falabella', '2026-02-04', 50000, 2, 6), // 4 left: mar..jun
      charge('Sodimac', '2026-02-07', 30000, 11, 12), // 1 left: mar
    ]);

    const outlook = buildOutlook(plans, '2026-03', 12);

    expect(toDecimalString(outlook.committedTotal)).toBe('230000');
    expect(outlook.schedule[0]!.month).toBe('2026-03');
    expect(toDecimalString(outlook.schedule[0]!.amount)).toBe('80000');
    expect(toDecimalString(outlook.schedule[1]!.amount)).toBe('50000');
    expect(outlook.schedule).toHaveLength(4);
  });

  it('separates closed plans from open ones', () => {
    const plans = buildInstallmentPlans([
      charge('Paris', '2026-02-10', 20000, 6, 6),
      charge('Ripley', '2026-02-10', 15000, 1, 3),
    ]);
    const outlook = buildOutlook(plans, '2026-03', 12);

    expect(outlook.closedPlans.map((p) => p.merchant)).toEqual(['Paris']);
    expect(outlook.openPlans.map((p) => p.merchant)).toEqual(['Ripley']);
  });

  it('respects the horizon', () => {
    const plans = buildInstallmentPlans([charge('Falabella', '2026-02-04', 50000, 1, 24)]);
    expect(buildOutlook(plans, '2026-03', 3).schedule).toHaveLength(3);
  });
});

describe('installments from a real CMR-shaped statement', () => {
  it('finds the plans the fixture encodes', () => {
    const prepared = prepareImport({
      file: loadFixture('falabella-cmr.csv'),
      accountId: 'acct-cmr',
      rules: defaultRules(),
      duplicateIndex: buildDuplicateIndex([]),
    });

    const merchants = prepared.installmentPlans.map((plan) => plan.merchant).sort();
    expect(merchants).toContain('Falabella');
    expect(merchants).toContain('Sodimac');
    expect(merchants).toContain('Ripley');
  });
});

/**
 * Dos guardas de cuotas que no guardaban nada.
 *
 * `looksLikeDate` se calculaba y se descartaba: las dos ramas devolvían el
 * mismo valor, así que `PARIS 03/06` producía un plan de 3 de 6. Y
 * `detectInstallment` corre sobre **cada** fila de cada producto, no sólo sobre
 * tarjetas, así que una fecha dentro de una glosa de cuenta corriente fabricaba
 * un compromiso que no existe e inflaba `committedTotal`.
 *
 * Y la clave de agrupación hasheaba el monto exacto, así que un plan con la
 * última cuota desigual —16.667 / 16.667 / 16.665, lo normal en Chile, porque
 * las cuotas rara vez dividen exacto— se partía en dos planes. Ninguno tenía
 * huecos, así que nada lo señalaba, y el primero seguía diciendo que quedaba
 * una cuota por pagar de un plan ya terminado.
 */
describe('una fecha suelta no es un plan de cuotas', () => {
  it('un 03/06 en una cuenta corriente no produce plan', () => {
    expect(
      detectInstallment('PARIS 03/06', '', { product: StatementProduct.checking }),
    ).toBeUndefined();
  });

  it('sin decir el producto tampoco, porque el default es no adivinar', () => {
    expect(detectInstallment('PARIS 03/06')).toBeUndefined();
  });

  it('pero en una tarjeta 03/06 sí es una cuota', () => {
    expect(
      detectInstallment('PARIS 03/06', '', { product: StatementProduct.credit_card }),
    ).toMatchObject({ current: 3, total: 6, confidence: Confidence.suggested });
  });

  it('y 3/24 vale en cualquier producto, porque 24 no es un mes', () => {
    expect(
      detectInstallment('FALABELLA 3/24', '', { product: StatementProduct.checking }),
    ).toMatchObject({ current: 3, total: 24 });
  });

  it('y la palabra cuota lo vuelve explícito de todos modos', () => {
    expect(detectInstallment('PARIS CUOTA 3 DE 6')).toMatchObject({
      current: 3,
      total: 6,
      confidence: Confidence.confirmed,
    });
  });
});

describe('una última cuota desigual sigue siendo el mismo plan', () => {
  function charge(current: number, minor: number, date: string) {
    return makeTransaction({
      amount: -minor,
      date,
      description: `PARIS CUOTA ${current} DE 3`,
      merchant: 'PARIS',
      kind: TransactionKind.credit_card_purchase,
      installment: {
        current,
        total: 3,
        confidence: Confidence.confirmed,
        matchedText: `CUOTA ${current} DE 3`,
      },
    });
  }

  it('no se parte en dos planes por unos pesos de diferencia', () => {
    const plans = buildInstallmentPlans([
      charge(1, 16667, '2026-01-05'),
      charge(2, 16667, '2026-02-05'),
      charge(3, 16665, '2026-03-05'),
    ]);

    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({
      totalInstallments: 3,
      currentInstallment: 3,
      remainingInstallments: 0,
    });
  });

  it('dos planes de verdad en el mismo comercio siguen separados', () => {
    const plans = buildInstallmentPlans([
      charge(1, 16667, '2026-01-05'),
      charge(2, 16667, '2026-02-05'),
      charge(1, 40000, '2026-02-20'),
    ]);

    expect(plans).toHaveLength(2);
  });
});

/**
 * Quitar el monto de la clave de agrupación fue demasiado lejos.
 *
 * Se quitó para que una última cuota desigual no partiera un plan en dos. Pero
 * dos planes reales del mismo comercio con la misma cantidad de cuotas y montos
 * distintos, solapados en el tiempo, quedan en el mismo grupo, y
 * `splitOnRepeatedCounter` los corta por donde se repite el contador — que no
 * es donde empieza el segundo plan. Salían tres planes de dos, con el monto de
 * cuota equivocado y `committedTotal` inflado.
 *
 * El monto vuelve a la clave, pero por bandas: dos cuotas del mismo plan se
 * diferencian a lo sumo en el resto del redondeo, muy por debajo del 1 %.
 */
describe('dos planes del mismo comercio solapados en el tiempo', () => {
  function charge(minor: number, current: number, total: number, date: string) {
    return makeTransaction({
      amount: -minor,
      date,
      description: `FALABELLA RETAIL CUOTA ${current} DE ${total}`,
      merchant: 'FALABELLA',
      kind: TransactionKind.credit_card_purchase,
      installment: {
        current,
        total,
        confidence: Confidence.confirmed,
        matchedText: `CUOTA ${current} DE ${total}`,
      },
    });
  }

  it('se mantienen separados', () => {
    // Plan A: 6 cuotas de 49.990 desde enero. Plan B: 6 cuotas de 20.000 desde
    // abril. Se solapan tres meses.
    const month = (n: number) => `2026-${String(n).padStart(2, '0')}-05`;
    const plans = buildInstallmentPlans([
      ...Array.from({ length: 6 }, (_, i) => charge(49990, i + 1, 6, month(i + 1))),
      ...Array.from({ length: 6 }, (_, i) => charge(20000, i + 1, 6, month(i + 4))),
    ]);

    expect(plans).toHaveLength(2);
    const amounts = plans.map((p) => Math.abs(p.installmentAmount.minor)).sort((a, b) => a - b);
    expect(amounts).toEqual([20000, 49990]);
    // Los dos completos: ninguno debe quedar reclamando cuotas por pagar.
    expect(plans.every((p) => p.remainingInstallments === 0)).toBe(true);
  });

  it('y una última cuota desigual sigue sin partir el plan', () => {
    const plans = buildInstallmentPlans([
      charge(16667, 1, 3, '2026-01-05'),
      charge(16667, 2, 3, '2026-02-05'),
      charge(16665, 3, 3, '2026-03-05'),
    ]);

    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ currentInstallment: 3, remainingInstallments: 0 });
  });
});
