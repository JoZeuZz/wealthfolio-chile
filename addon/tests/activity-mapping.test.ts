import { describe, expect, it } from 'vitest';
import { buildDuplicateIndex, classifyDuplicate } from '../src/core/dedupe/classify';
import { computeFingerprint, computeWeakFingerprint } from '../src/core/dedupe/fingerprint';
import {
  activityDetailsToSignedMoney,
  activityDirection,
  activityFlowSign,
  activityToTransaction,
  parseHostAmount,
  readChileMetadata,
  toActivityCreate,
  type ChileMetadata,
} from '../src/core/mapping/activities';
import { money } from '../src/core/money';
import { Direction, TransactionKind } from '../src/core/model/kinds';
import type { NormalizedTransaction } from '../src/core/model/transaction';
import { makeTransaction } from './fixtures';
import { activityStub } from './host';

/**
 * Round-tripping through Wealthfolio.
 *
 * Our model puts the sign in the amount; Wealthfolio puts it in the activity
 * type and stores a magnitude. Every one of these tests exists because losing
 * that sign on the way back turns a duplicate check into a false negative — and
 * a false negative there is a doubled expense in someone's ledger.
 */

const ACCOUNT = 'acc-1';
const RUN = 'run-1';

/** Save a transaction the way the addon does, then read it back as the host would. */
function roundTrip(transaction: NormalizedTransaction) {
  const weakFingerprint = computeWeakFingerprint(transaction, { accountId: ACCOUNT });
  const create = toActivityCreate(transaction, {
    accountId: ACCOUNT,
    runId: RUN,
    weakFingerprint,
  });

  const stored = activityStub({
    accountId: ACCOUNT,
    activityType: create.activityType,
    ...(create.subtype ? { subtype: create.subtype } : {}),
    amount: String(create.amount),
    currency: create.currency ?? 'CLP',
    date: String(create.activityDate),
    comment: create.comment ?? '',
    metadata: (create.metadata as Record<string, ChileMetadata>)['wealthfolioChile'] as ChileMetadata,
  });

  return { create, stored, reconstructed: activityDetailsToSignedMoney(stored) };
}

describe('activity flow sign', () => {
  it('reads the direction Wealthfolio v3.6.2 documents for every cash type', () => {
    expect(activityFlowSign('DEPOSIT')).toBe(1);
    expect(activityFlowSign('WITHDRAWAL')).toBe(-1);
    expect(activityFlowSign('TRANSFER_IN')).toBe(1);
    expect(activityFlowSign('TRANSFER_OUT')).toBe(-1);
    expect(activityFlowSign('FEE')).toBe(-1);
    expect(activityFlowSign('TAX')).toBe(-1);
    expect(activityFlowSign('INTEREST')).toBe(1);
    expect(activityFlowSign('CREDIT')).toBe(1);
    expect(activityFlowSign('DIVIDEND')).toBe(1);
  });

  it('refuses to invent a direction for types with no automatic cash impact', () => {
    expect(activityFlowSign('UNKNOWN')).toBe(0);
    expect(activityFlowSign('ADJUSTMENT')).toBe(0);
    expect(activityFlowSign('SPLIT')).toBe(0);
    expect(activityFlowSign('SOMETHING_NEW_UPSTREAM_ADDED')).toBe(0);
  });

  it('maps a flow sign onto a Direction, or none at all', () => {
    expect(activityDirection('WITHDRAWAL')).toBe(Direction.out);
    expect(activityDirection('DEPOSIT')).toBe(Direction.in);
    expect(activityDirection('UNKNOWN')).toBeUndefined();
  });

  it('keeps whatever sign the host stored when the type carries no direction', () => {
    const stored = activityStub({ activityType: 'UNKNOWN', amount: '-4500', date: '2026-03-01' });
    expect(activityDetailsToSignedMoney(stored)).toEqual(money(-4500, 0, 'CLP'));
  });
});

describe('host amount parsing', () => {
  it('takes the scale from the digits present', () => {
    expect(parseHostAmount('1234', 'CLP')).toEqual(money(1234, 0, 'CLP'));
    expect(parseHostAmount('1234.50', 'CLP')).toEqual(money(123450, 2, 'CLP'));
    expect(parseHostAmount('0.000001', 'CLP')).toEqual(money(1, 6, 'CLP'));
  });

  it('treats a missing amount as zero rather than NaN', () => {
    expect(parseHostAmount(null, 'CLP')).toEqual(money(0, 0, 'CLP'));
    expect(parseHostAmount(undefined, 'CLP')).toEqual(money(0, 0, 'CLP'));
  });

  it('falls back to CLP when the host reports no currency', () => {
    expect(parseHostAmount('100', '').currency).toBe('CLP');
  });

  it('gives up on a magnitude too large to hold exactly', () => {
    expect(parseHostAmount('99999999999999999999', 'CLP')).toEqual(money(0, 0, 'CLP'));
  });
});

describe('round trip: our model → Wealthfolio → our model', () => {
  const cases: Array<{ name: string; transaction: NormalizedTransaction; type: string }> = [
    {
      name: 'income',
      type: 'DEPOSIT',
      transaction: makeTransaction({
        date: '2026-03-05',
        amount: 1_000_000,
        description: 'SUELDO MARZO',
        kind: TransactionKind.income,
        direction: Direction.in,
      }),
    },
    {
      name: 'expense',
      type: 'WITHDRAWAL',
      transaction: makeTransaction({
        date: '2026-03-06',
        amount: -85_400,
        description: 'SUPERMERCADO LIDER',
        kind: TransactionKind.expense,
        direction: Direction.out,
      }),
    },
    {
      name: 'internal transfer in',
      type: 'TRANSFER_IN',
      transaction: makeTransaction({
        date: '2026-03-07',
        amount: 200_000,
        description: 'TRANSFERENCIA ENTRE CUENTAS',
        kind: TransactionKind.internal_transfer,
        direction: Direction.in,
      }),
    },
    {
      name: 'internal transfer out',
      type: 'TRANSFER_OUT',
      transaction: makeTransaction({
        date: '2026-03-07',
        amount: -200_000,
        description: 'TRANSFERENCIA ENTRE CUENTAS',
        kind: TransactionKind.internal_transfer,
        direction: Direction.out,
      }),
    },
    {
      name: 'card payment',
      type: 'TRANSFER_OUT',
      transaction: makeTransaction({
        date: '2026-03-10',
        amount: -320_000,
        description: 'PAGO TARJETA CMR',
        kind: TransactionKind.credit_card_payment,
        direction: Direction.out,
      }),
    },
    {
      name: 'fee',
      type: 'FEE',
      transaction: makeTransaction({
        date: '2026-03-11',
        amount: -3_900,
        description: 'COMISION MANTENCION',
        kind: TransactionKind.fee,
        direction: Direction.out,
      }),
    },
    {
      name: 'interest incoming',
      type: 'INTEREST',
      transaction: makeTransaction({
        date: '2026-03-12',
        amount: 1_250,
        description: 'ABONO INTERESES',
        kind: TransactionKind.interest,
        direction: Direction.in,
      }),
    },
    {
      name: 'interest charged',
      type: 'FEE',
      transaction: makeTransaction({
        date: '2026-03-12',
        amount: -7_800,
        description: 'INTERESES POR MORA',
        kind: TransactionKind.interest,
        direction: Direction.out,
      }),
    },
    {
      name: 'refund',
      type: 'CREDIT',
      transaction: makeTransaction({
        date: '2026-03-13',
        amount: 45_000,
        description: 'DEVOLUCION COMPRA',
        kind: TransactionKind.refund,
        direction: Direction.in,
      }),
    },
    {
      name: 'tax',
      type: 'TAX',
      transaction: makeTransaction({
        date: '2026-03-14',
        amount: -1_100,
        description: 'IMPUESTO TIMBRES',
        kind: TransactionKind.tax,
        direction: Direction.out,
      }),
    },
    {
      name: 'card purchase',
      type: 'WITHDRAWAL',
      transaction: makeTransaction({
        date: '2026-03-15',
        amount: -59_990,
        description: 'FARMACIA',
        kind: TransactionKind.credit_card_purchase,
        direction: Direction.out,
      }),
    },
  ];

  for (const testCase of cases) {
    it(`preserves the signed amount for ${testCase.name}`, () => {
      const { create, reconstructed } = roundTrip(testCase.transaction);

      expect(create.activityType).toBe(testCase.type);
      // Wealthfolio always receives a magnitude.
      expect(String(create.amount).startsWith('-')).toBe(false);
      expect(reconstructed).toEqual(testCase.transaction.amount);
    });
  }

  it('rebuilds the whole transaction, not only the amount', () => {
    const original = makeTransaction({
      date: '2026-03-06',
      amount: -85_400,
      description: 'SUPERMERCADO LIDER',
      kind: TransactionKind.expense,
      direction: Direction.out,
      merchant: 'LIDER',
      category: 'alimentacion.supermercado',
      tags: ['mensual'],
    });

    const { stored } = roundTrip(original);
    const rebuilt = activityToTransaction(stored);

    expect(rebuilt?.amount).toEqual(original.amount);
    expect(rebuilt?.direction).toBe(Direction.out);
    expect(rebuilt?.kind).toBe(TransactionKind.expense);
    expect(rebuilt?.merchant).toBe('LIDER');
    expect(rebuilt?.category).toBe('alimentacion.supermercado');
    expect(rebuilt?.tags).toEqual(['mensual']);
    expect(rebuilt?.fingerprint).toBe(original.fingerprint);
    expect(rebuilt?.date).toBe('2026-03-06');
  });

  it('ignores activities the addon did not write', () => {
    const foreign = activityStub({ activityType: 'DEPOSIT', amount: '1000', date: '2026-03-01' });
    expect(activityToTransaction(foreign)).toBeUndefined();
    expect(readChileMetadata(foreign.metadata)).toBeUndefined();
  });

  it('rejects metadata without a fingerprint', () => {
    expect(readChileMetadata({ wealthfolioChile: { v: 1, fp: '' } })).toBeUndefined();
    expect(readChileMetadata({ wealthfolioChile: 'not-an-object' })).toBeUndefined();
    expect(readChileMetadata(undefined)).toBeUndefined();
  });
});

describe('regression: an expense reconstructed from a WITHDRAWAL is a probable duplicate', () => {
  it('matches an existing -85.400 expense whose description drifted slightly', () => {
    const scope = { accountId: ACCOUNT };

    // Already in Wealthfolio: imported from February's file.
    const previouslyImported = makeTransaction({
      date: '2026-03-06',
      amount: -85_400,
      description: 'SUPERMERCADO LIDER GRAN AVENIDA',
      kind: TransactionKind.expense,
      direction: Direction.out,
    });
    const { stored } = roundTrip(previouslyImported);

    // What the host hands back is a magnitude under a WITHDRAWAL.
    expect(stored.amount).toBe('85400');
    expect(stored.activityType).toBe('WITHDRAWAL');

    const index = buildDuplicateIndex([
      {
        fingerprint: readChileMetadata(stored.metadata)?.fp as string,
        weakFingerprint: readChileMetadata(stored.metadata)?.wfp as string,
        activityId: stored.id,
        date: '2026-03-06',
        amount: activityDetailsToSignedMoney(stored),
        description: stored.comment ?? '',
      },
    ]);

    // The same movement, re-exported by the bank with a slightly different
    // glosa: the exact fingerprint no longer matches, so only the signed-amount
    // comparison can catch it.
    const reExported = makeTransaction({
      date: '2026-03-06',
      amount: -85_400,
      description: 'SUPERMERCADO LIDER GRAN AVENIDA 1234',
      kind: TransactionKind.expense,
      direction: Direction.out,
    });
    const candidate = {
      ...reExported,
      fingerprint: computeFingerprint(reExported, scope),
    };

    expect(candidate.fingerprint).not.toBe(readChileMetadata(stored.metadata)?.fp);

    const finding = classifyDuplicate(candidate, index, scope, new Map());

    expect(finding.verdict).toBe('probable');
    expect(finding.existingActivityId).toBe(stored.id);
  });

  it('would miss that duplicate if the sign were dropped — the bug this guards', () => {
    const scope = { accountId: ACCOUNT };
    const previouslyImported = makeTransaction({
      date: '2026-03-06',
      amount: -85_400,
      description: 'SUPERMERCADO LIDER GRAN AVENIDA',
      kind: TransactionKind.expense,
      direction: Direction.out,
    });
    const { stored } = roundTrip(previouslyImported);

    // The old reconstruction: parse the host string and keep it unsigned.
    const unsignedIndex = buildDuplicateIndex([
      {
        weakFingerprint: readChileMetadata(stored.metadata)?.wfp as string,
        activityId: stored.id,
        date: '2026-03-06',
        amount: parseHostAmount(stored.amount, stored.currency),
        description: stored.comment ?? '',
      },
    ]);

    const reExported = makeTransaction({
      date: '2026-03-06',
      amount: -85_400,
      description: 'SUPERMERCADO LIDER GRAN AVENIDA 1234',
      kind: TransactionKind.expense,
      direction: Direction.out,
    });
    const finding = classifyDuplicate(
      { ...reExported, fingerprint: computeFingerprint(reExported, scope) },
      unsignedIndex,
      scope,
      new Map(),
    );

    expect(finding.verdict).toBe('none');
  });
});
