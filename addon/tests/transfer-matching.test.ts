import { describe, expect, it } from 'vitest';
import { Confidence, TransactionKind } from '../src/core/model/kinds';
import { matchTransfers, type ScopedTransaction } from '../src/core/reconcile/transfers';
import { makeTransaction } from './fixtures';

/**
 * Emparejar los dos tramos de una transferencia.
 *
 * El daño de equivocarse aquí es simétrico y grande: emparejar mal reclasifica
 * dos movimientos reales como dinero que sólo cambió de bolsillo, y los saca de
 * ingresos y de gastos a la vez. Por eso el matcher tiene que poder decir «hay
 * dos candidatos y no sé cuál» en lugar de elegir uno.
 */

function leg(
  accountId: string,
  amount: number,
  date: string,
  description: string,
  extra: Partial<Parameters<typeof makeTransaction>[0]> = {},
): ScopedTransaction {
  return {
    accountId,
    transaction: makeTransaction({ amount, date, description, ...extra }),
  };
}

describe('un par claro', () => {
  it('empareja el cargo con el abono del mismo monto en otra cuenta', () => {
    const result = matchTransfers([
      leg('a', -200000, '2026-02-10', 'TRASPASO A CUENTA PROPIA BANCOESTADO'),
      leg('b', 200000, '2026-02-10', 'TRASPASO DESDE CUENTA PROPIA', {
        sourceInstitution: 'banco-estado',
      }),
    ]);

    expect(result.matches).toHaveLength(1);
    expect(result.ambiguous).toHaveLength(0);
    expect(result.matches[0]?.confidence).toBe(Confidence.confirmed);
  });
});

describe('dos transferencias idénticas', () => {
  // El caso del enunciado: A → B $100.000 dos veces, en fechas próximas.
  const legs = [
    leg('a', -100000, '2026-02-10', 'TRASPASO A CUENTA PROPIA'),
    leg('a', -100000, '2026-02-11', 'TRASPASO A CUENTA PROPIA'),
    leg('b', 100000, '2026-02-10', 'TRASPASO DESDE CUENTA PROPIA'),
    leg('b', 100000, '2026-02-11', 'TRASPASO DESDE CUENTA PROPIA'),
  ];

  it('empareja por cercanía cuando cada tramo tiene un mejor candidato único', () => {
    // Aquí sí hay respuesta: el del 10 con el del 10, el del 11 con el del 11.
    // Un greedy que consuma el primer candidato puede dejar los otros dos
    // cruzados a 1 día cada uno.
    const result = matchTransfers(legs);

    expect(result.matches).toHaveLength(2);
    expect(result.ambiguous).toHaveLength(0);
    for (const match of result.matches) {
      expect(match.gapDays).toBe(0);
    }
  });

  it('no elige cuando los candidatos son indistinguibles', () => {
    // Dos cargos y dos abonos, todos el mismo día y por el mismo monto: no hay
    // nada que permita decir cuál va con cuál.
    const sameDay = [
      leg('a', -100000, '2026-02-10', 'TRASPASO A CUENTA PROPIA'),
      leg('a', -100000, '2026-02-10', 'TRASPASO A CUENTA PROPIA'),
      leg('b', 100000, '2026-02-10', 'TRASPASO DESDE CUENTA PROPIA'),
      leg('b', 100000, '2026-02-10', 'TRASPASO DESDE CUENTA PROPIA'),
    ];

    const result = matchTransfers(sameDay);

    expect(result.matches).toHaveLength(0);
    expect(result.ambiguous.length).toBeGreaterThan(0);
    expect(result.ambiguous[0]?.candidates.length).toBeGreaterThan(1);
    expect(result.ambiguous[0]?.reason).toMatch(/candidat/i);
  });

  it('no reclama esos movimientos como emparejados', () => {
    const sameDay = [
      leg('a', -100000, '2026-02-10', 'TRASPASO A CUENTA PROPIA'),
      leg('a', -100000, '2026-02-10', 'TRASPASO A CUENTA PROPIA'),
      leg('b', 100000, '2026-02-10', 'TRASPASO DESDE CUENTA PROPIA'),
      leg('b', 100000, '2026-02-10', 'TRASPASO DESDE CUENTA PROPIA'),
    ];

    expect(matchTransfers(sameDay).matchedFingerprints.size).toBe(0);
  });

  it('un abono disputado por dos cargos tampoco se adjudica', () => {
    const result = matchTransfers([
      leg('a', -100000, '2026-02-10', 'TRASPASO A CUENTA PROPIA'),
      leg('c', -100000, '2026-02-10', 'TRASPASO A CUENTA PROPIA'),
      leg('b', 100000, '2026-02-10', 'TRASPASO DESDE CUENTA PROPIA'),
    ]);

    expect(result.matches).toHaveLength(0);
    expect(result.ambiguous.length).toBeGreaterThan(0);
  });
});

describe('una transferencia a un tercero no es una transferencia propia', () => {
  it('no la confirma aunque coincidan monto y fecha', () => {
    // «A TERCEROS» dice explícitamente que la contraparte no es del usuario.
    // Confirmarla borraría un gasto real y un ingreso real de una vez.
    const result = matchTransfers([
      leg('a', -150000, '2026-02-10', 'TRANSFERENCIA A TERCEROS BANCOESTADO'),
      leg('b', 150000, '2026-02-10', 'ABONO TRANSFERENCIA DE UN TERCERO', {
        sourceInstitution: 'banco-estado',
      }),
    ]);

    for (const match of result.matches) {
      expect(match.confidence).not.toBe(Confidence.confirmed);
    }
  });
});

describe('evidencia por referencia', () => {
  it('una referencia compartida y larga confirma', () => {
    const result = matchTransfers([
      leg('a', -75000, '2026-02-10', 'TRANSFERENCIA', { reference: '900123456' }),
      leg('b', 75000, '2026-02-11', 'ABONO', { reference: '900123456' }),
    ]);

    expect(result.matches[0]?.confidence).toBe(Confidence.confirmed);
  });

  it('una referencia trivial compartida no es evidencia', () => {
    // Un correlativo de una cifra coincide por casualidad todo el tiempo.
    const result = matchTransfers([
      leg('a', -75000, '2026-02-10', 'PAGO', { reference: '1' }),
      leg('b', 75000, '2026-02-12', 'ABONO', { reference: '1' }),
    ]);

    expect(result.matches[0]?.confidence).toBe(Confidence.suggested);
  });
});

describe('applyTransferMatch', () => {
  it('marca los dos tramos y guarda la contraparte', async () => {
    const { applyTransferMatch } = await import('../src/core/reconcile/transfers');
    const result = matchTransfers([
      leg('a', -200000, '2026-02-10', 'TRASPASO A CUENTA PROPIA'),
      leg('b', 200000, '2026-02-10', 'TRASPASO DESDE CUENTA PROPIA'),
    ]);

    const [out, inn] = applyTransferMatch(result.matches[0]!);
    expect(out.kind).toBe(TransactionKind.internal_transfer);
    expect(inn.kind).toBe(TransactionKind.internal_transfer);
    expect(out.transferCandidate?.counterpartFingerprint).toBe(inn.fingerprint);
  });
});

/**
 * El pago de tarjeta tiene el mismo problema que la transferencia.
 *
 * Dos pagos del mismo monto en fechas cercanas y dos abonos en la tarjeta: el
 * emparejamiento voraz elegía uno por orden de aparición. Aquí el daño es menor
 * que en una transferencia —las dos filas se clasifican igual de todos modos—
 * pero la evidencia que se le muestra al usuario deja de ser cierta, y
 * `applyCardPaymentMatch` la reclasifica con confianza `confirmed`.
 */
describe('pagos de tarjeta con candidatos indistinguibles', () => {
  function cash(amount: number, date: string) {
    return leg('cuenta', amount, date, 'PAGO TARJETA DE CREDITO CMR', {
      kind: TransactionKind.credit_card_payment,
      sourceParser: 'generico.cuenta',
    });
  }

  function card(amount: number, date: string) {
    return leg('tarjeta', amount, date, 'PAGO RECIBIDO GRACIAS', {
      kind: TransactionKind.credit_card_payment,
      sourceParser: 'generico.tarjeta',
    });
  }

  it('empareja cuando cada pago tiene un abono claramente más cercano', async () => {
    const { matchCardPayments } = await import('../src/core/reconcile/credit-card');
    const matches = matchCardPayments([
      cash(-100000, '2026-02-10'),
      cash(-100000, '2026-02-20'),
      card(100000, '2026-02-10'),
      card(100000, '2026-02-20'),
    ]);

    const twoSided = matches.filter((m) => m.cardCredit);
    expect(twoSided).toHaveLength(2);
    for (const match of twoSided) {
      expect(match.payment.transaction.date).toBe(match.cardCredit?.transaction.date);
    }
  });

  it('no elige un abono cuando hay dos idénticos', async () => {
    const { matchCardPayments } = await import('../src/core/reconcile/credit-card');
    const matches = matchCardPayments([
      cash(-100000, '2026-02-10'),
      card(100000, '2026-02-10'),
      card(100000, '2026-02-10'),
    ]);

    // Sigue reconociendo que hubo un pago —la glosa lo dice— pero sin afirmar
    // cuál de los dos abonos es su contraparte.
    const forCash = matches.find((m) => m.payment.accountId === 'cuenta');
    expect(forCash?.cardCredit).toBeUndefined();
    expect(forCash?.confidence).toBe(Confidence.suggested);
    expect(forCash?.reason).toMatch(/no se puede decir cuál/i);
  });
});
