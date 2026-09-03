import { describe, expect, it } from 'vitest';
import { makeTransaction } from './fixtures';
import { buildDuplicateIndex } from '../src/core/dedupe/classify';
import { money } from '../src/core/money';
import { Confidence, Direction, TransactionKind } from '../src/core/model/kinds';
import type { NormalizedTransaction } from '../src/core/model/transaction';
import { prepareImport } from '../src/core/pipeline';
import {
  applyCardPaymentMatch,
  matchCardPayments,
} from '../src/core/reconcile/credit-card';
import {
  applyTransferMatch,
  matchTransfers,
  type ScopedTransaction,
} from '../src/core/reconcile/transfers';
import { defaultRules } from '../src/core/rules/builtin';
import { summarizeMonth } from '../src/core/metrics/monthly';
import { normalizeDescription } from '../src/core/text';
import { loadFixture } from './fixtures';

let counter = 0;

type TxOverrides = Partial<Omit<NormalizedTransaction, 'amount'>> & {
  amount: number;
  date: string;
};

function tx(overrides: TxOverrides): NormalizedTransaction {
  counter += 1;
  const { amount: amountValue, ...rest } = overrides;
  const amount = money(amountValue, 0, 'CLP');
  const description = overrides.description ?? 'MOVIMIENTO';
  return {
    sourceInstitution: 'banco-chile',
    sourceParser: 'test',
    sourceParserVersion: '1.0.0',
    sourceFileHash: 'hash',
    fingerprint: `fp-${counter}`,
    description,
    normalizedDescription: normalizeDescription(description),
    amount,
    direction: amount.minor < 0 ? Direction.out : Direction.in,
    kind: amount.minor < 0 ? TransactionKind.expense : TransactionKind.income,
    kindConfidence: Confidence.suggested,
    tags: [],
    warnings: [],
    rawMetadata: {},
    ...rest,
  } as NormalizedTransaction;
}

function scoped(accountId: string, transaction: NormalizedTransaction): ScopedTransaction {
  return { accountId, transaction };
}

describe('internal transfer matching', () => {
  it('pairs an outflow and an inflow of the same amount in different accounts', () => {
    const out = tx({
      date: '2026-02-06',
      amount: -200000,
      description: 'TRANSFERENCIA A CUENTA PROPIA BANCOESTADO',
    });
    const income = tx({
      date: '2026-02-06',
      amount: 200000,
      description: 'ABONO TRANSFERENCIA BANCO DE CHILE CUENTA PROPIA',
      sourceInstitution: 'banco-estado',
    });

    const { matches } = matchTransfers([scoped('a', out), scoped('b', income)]);

    expect(matches).toHaveLength(1);
    expect(matches[0]!.confidence).toBe(Confidence.confirmed);
    expect(matches[0]!.gapDays).toBe(0);
  });

  it('removes the pair from income and expenses once applied', () => {
    const out = tx({
      date: '2026-02-06',
      amount: -200000,
      description: 'TRASPASO A CUENTA PROPIA',
    });
    const income = tx({
      date: '2026-02-06',
      amount: 200000,
      description: 'TRASPASO DESDE CUENTA PROPIA',
      sourceInstitution: 'banco-estado',
    });

    const { matches } = matchTransfers([scoped('a', out), scoped('b', income)]);
    const [legA, legB] = applyTransferMatch(matches[0]!);

    const summary = summarizeMonth('2026-02', [legA, legB]);

    expect(summary.income.minor).toBe(0);
    expect(summary.expenses.minor).toBe(0);
    expect(summary.internalTransfers.minor).toBe(200000);
  });

  it('never pairs two movements inside the same account', () => {
    const out = tx({ date: '2026-02-06', amount: -50000, description: 'TRANSFERENCIA' });
    const income = tx({ date: '2026-02-06', amount: 50000, description: 'TRANSFERENCIA' });
    expect(matchTransfers([scoped('a', out), scoped('a', income)]).matches).toHaveLength(0);
  });

  it('does not pair movements outside the time window', () => {
    const out = tx({ date: '2026-02-01', amount: -50000, description: 'TRANSFERENCIA' });
    const income = tx({
      date: '2026-02-20',
      amount: 50000,
      description: 'TRANSFERENCIA',
      sourceInstitution: 'banco-estado',
    });
    expect(matchTransfers([scoped('a', out), scoped('b', income)]).matches).toHaveLength(0);
  });

  it('only suggests when the wording gives no evidence of a transfer', () => {
    // A salary and a rent payment that happen to coincide in amount and date
    // must not be silently merged into a transfer.
    const out = tx({ date: '2026-02-05', amount: -450000, description: 'PAGO ARRIENDO' });
    const income = tx({
      date: '2026-02-05',
      amount: 450000,
      description: 'ABONO HONORARIOS CLIENTE',
      sourceInstitution: 'banco-estado',
    });

    const { matches } = matchTransfers([scoped('a', out), scoped('b', income)]);
    expect(matches[0]!.confidence).toBe(Confidence.suggested);
  });

  it('downgrades to a suggestion when two candidates are equally plausible', () => {
    const out = tx({
      date: '2026-02-05',
      amount: -100000,
      description: 'TRANSFERENCIA A CUENTA PROPIA',
    });
    const first = tx({
      date: '2026-02-05',
      amount: 100000,
      description: 'ABONO TRANSFERENCIA',
      sourceInstitution: 'banco-estado',
    });
    const second = tx({
      date: '2026-02-05',
      amount: 100000,
      description: 'ABONO TRANSFERENCIA',
      sourceInstitution: 'banco-estado',
    });

    const { matches } = matchTransfers([scoped('a', out), scoped('b', first), scoped('c', second)]);
    expect(matches[0]!.confidence).toBe(Confidence.suggested);
  });

  it('is deterministic regardless of input order', () => {
    const out = tx({ date: '2026-02-06', amount: -200000, description: 'TRASPASO CUENTA PROPIA' });
    const income = tx({
      date: '2026-02-06',
      amount: 200000,
      description: 'TRASPASO CUENTA PROPIA',
      sourceInstitution: 'banco-estado',
    });

    const forward = matchTransfers([scoped('a', out), scoped('b', income)]);
    const backward = matchTransfers([scoped('b', income), scoped('a', out)]);

    expect(forward.matches[0]!.outflow.transaction.fingerprint).toBe(
      backward.matches[0]!.outflow.transaction.fingerprint,
    );
  });
});

describe('credit-card payment matching', () => {
  it('pairs the cash-side debit with the card-side credit', () => {
    const payment = tx({
      date: '2026-02-05',
      amount: -120000,
      description: 'PAGO TARJETA DE CREDITO CMR',
      kind: TransactionKind.expense,
    });
    const cardCredit = tx({
      date: '2026-02-05',
      amount: 120000,
      description: 'PAGO RECIBIDO GRACIAS',
      sourceInstitution: 'banco-falabella',
      kind: TransactionKind.credit_card_payment,
    });

    const matches = matchCardPayments([scoped('cash', payment), scoped('card', cardCredit)]);

    expect(matches).toHaveLength(1);
    expect(matches[0]!.confidence).toBe(Confidence.confirmed);
    expect(matches[0]!.cardCredit).toBeDefined();
  });

  it('suggests when only the cash side was imported', () => {
    const payment = tx({
      date: '2026-02-05',
      amount: -120000,
      description: 'PAGO TARJETA DE CREDITO CMR',
      kind: TransactionKind.expense,
    });

    const matches = matchCardPayments([scoped('cash', payment)]);
    expect(matches[0]!.confidence).toBe(Confidence.suggested);
  });

  it('does not double-count a purchase and its later payment', () => {
    // The economics that matter: an $80.000 card purchase settled by an
    // $80.000 payment is $80.000 of spending, not $160.000.
    const purchase = tx({
      date: '2026-02-02',
      amount: -80000,
      description: 'FALABELLA RETAIL',
      kind: TransactionKind.credit_card_purchase,
    });
    const payment = tx({
      date: '2026-02-20',
      amount: -80000,
      description: 'PAGO TARJETA DE CREDITO CMR',
      kind: TransactionKind.expense,
    });
    const cardCredit = tx({
      date: '2026-02-20',
      amount: 80000,
      description: 'PAGO RECIBIDO',
      kind: TransactionKind.credit_card_payment,
    });

    const matches = matchCardPayments([
      scoped('card', purchase),
      scoped('cash', payment),
      scoped('card', cardCredit),
    ]);
    const applied = applyCardPaymentMatch(matches[0]!);

    const summary = summarizeMonth('2026-02', [purchase, ...applied]);

    expect(summary.expenses.minor).toBe(80000);
    expect(summary.cardPayments.minor).toBe(80000);
  });
});

describe('end-to-end reconciliation across two imported statements', () => {
  it('nets the Banco de Chile → BancoEstado transfer to zero', () => {
    const rules = defaultRules();
    const emptyIndex = buildDuplicateIndex([]);

    const chile = prepareImport({
      file: loadFixture('banco-chile-cuenta-corriente.csv'),
      accountId: 'acct-chile',
      rules,
      duplicateIndex: emptyIndex,
    });
    const estado = prepareImport({
      file: loadFixture('banco-estado-cuentarut.csv'),
      accountId: 'acct-estado',
      rules,
      duplicateIndex: emptyIndex,
    });

    const all: ScopedTransaction[] = [
      ...chile.rows.map((row) => scoped('acct-chile', row.transaction)),
      ...estado.rows.map((row) => scoped('acct-estado', row.transaction)),
    ];

    const { matches } = matchTransfers(all);
    const transfer = matches.find((match) => match.outflow.transaction.amount.minor === -200000);

    expect(transfer).toBeDefined();
    expect(transfer!.confidence).toBe(Confidence.confirmed);
    expect(transfer!.inflow.accountId).toBe('acct-estado');
  });
});

/**
 * El emparejamiento de dos lados sigue viendo el abono de la tarjeta.
 *
 * Cuando un abono ambiguo pasó a clasificarse `unknown`, el filtro que elige
 * candidatos —que adivinaba el producto a partir del tipo— dejó de verlo. El
 * matcher existe justamente para resolver esas filas, así que quedarse sin
 * ellas invierte el efecto: el lado de la tarjeta se queda `unknown` para
 * siempre y el de la cuenta baja de confirmado a sugerido.
 */
describe('abonos de tarjeta sin clasificar', () => {
  const cardParser = 'generico.tarjeta';

  it('empareja un abono `unknown` de la tarjeta con el cargo de la cuenta', () => {
    const matches = matchCardPayments([
      {
        accountId: 'cuenta',
        transaction: makeTransaction({
          amount: -120000,
          date: '2026-02-05',
          description: 'PAGO TARJETA CMR',
          kind: TransactionKind.credit_card_payment,
          sourceParser: 'generico.cuenta',
        }),
      },
      {
        accountId: 'tarjeta',
        transaction: makeTransaction({
          amount: 120000,
          date: '2026-02-06',
          description: 'ABONO',
          kind: TransactionKind.unknown,
          sourceParser: cardParser,
        }),
      },
    ]);

    expect(matches).toHaveLength(1);
    expect(matches[0]?.confidence).toBe(Confidence.confirmed);
    expect(matches[0]?.cardCredit).toBeDefined();
  });

  it('no confunde un ingreso `unknown` de una cuenta corriente con un abono de tarjeta', () => {
    const matches = matchCardPayments([
      {
        accountId: 'cuenta',
        transaction: makeTransaction({
          amount: -120000,
          date: '2026-02-05',
          description: 'PAGO TARJETA CMR',
          kind: TransactionKind.credit_card_payment,
          sourceParser: 'generico.cuenta',
        }),
      },
      {
        accountId: 'otra-cuenta',
        transaction: makeTransaction({
          amount: 120000,
          date: '2026-02-06',
          description: 'ABONO',
          kind: TransactionKind.unknown,
          sourceParser: 'generico.cuenta',
        }),
      },
    ]);

    expect(matches[0]?.cardCredit).toBeUndefined();
    expect(matches[0]?.confidence).toBe(Confidence.suggested);
  });
});
