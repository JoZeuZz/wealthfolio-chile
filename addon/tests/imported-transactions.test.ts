import { describe, expect, it } from 'vitest';
import { monthEnd, monthStart } from '../src/core/dates';
import { summarizeMonth } from '../src/core/metrics/monthly';
import { money } from '../src/core/money';
import { Direction, TransactionKind } from '../src/core/model/kinds';
import { loadImportedTransactions } from '../src/services/imported-transactions';
import { reconcileScoped, reconcileWindow } from '../src/services/reconciliation';
import { activityStub, fakeHost } from './host';

/**
 * Reading our own movements back out of Wealthfolio.
 *
 * This is what the dashboard runs on, so a sign error here shows up as wrong
 * income and wrong spending — the two numbers the whole product exists to get
 * right.
 */

function ourMetadata(fp: string, kind: TransactionKind, extra: Record<string, unknown> = {}) {
  return {
    fp,
    inst: 'banco-chile',
    parser: 'banco-chile.cartola-csv',
    parserVersion: '1.0.0',
    fileHash: 'file-hash',
    runId: 'run-1',
    kind,
    ...extra,
  };
}

describe('loadImportedTransactions', () => {
  it('rebuilds only the movements this addon wrote', async () => {
    const host = fakeHost({
      activities: [
        activityStub({
          activityType: 'DEPOSIT',
          amount: '1000000',
          date: '2026-03-05',
          comment: 'SUELDO',
          metadata: ourMetadata('fp-income', TransactionKind.income),
        }),
        // Created by hand in Wealthfolio, not by us.
        activityStub({ activityType: 'DEPOSIT', amount: '50000', date: '2026-03-05' }),
      ],
    });

    const loaded = await loadImportedTransactions(host.ctx);

    expect(loaded.scanned).toBe(2);
    expect(loaded.transactions).toHaveLength(1);
    expect(loaded.transactions[0]?.fingerprint).toBe('fp-income');
  });

  it('produces the income and expense totals the dashboard shows', async () => {
    const host = fakeHost({
      activities: [
        activityStub({
          activityType: 'DEPOSIT',
          amount: '1000000',
          date: '2026-03-05',
          comment: 'SUELDO',
          metadata: ourMetadata('fp-1', TransactionKind.income),
        }),
        activityStub({
          activityType: 'WITHDRAWAL',
          amount: '100000',
          date: '2026-03-06',
          comment: 'SUPERMERCADO',
          metadata: ourMetadata('fp-2', TransactionKind.expense),
        }),
        activityStub({
          activityType: 'WITHDRAWAL',
          amount: '50000',
          date: '2026-03-07',
          comment: 'COMBUSTIBLE',
          metadata: ourMetadata('fp-3', TransactionKind.expense),
        }),
      ],
    });

    const loaded = await loadImportedTransactions(host.ctx);
    const summary = summarizeMonth('2026-03', loaded.transactions, { currency: 'CLP' });

    expect(summary.income).toEqual(money(1_000_000, 0, 'CLP'));
    expect(summary.expenses).toEqual(money(150_000, 0, 'CLP'));
    expect(summary.net).toEqual(money(850_000, 0, 'CLP'));
  });

  it('leaves an internal transfer out of both totals', async () => {
    const host = fakeHost({
      activities: [
        activityStub({
          accountId: 'acc-1',
          activityType: 'TRANSFER_OUT',
          amount: '200000',
          date: '2026-03-08',
          comment: 'TRANSFERENCIA A MI CUENTA',
          metadata: ourMetadata('fp-out', TransactionKind.internal_transfer),
        }),
        activityStub({
          accountId: 'acc-2',
          activityType: 'TRANSFER_IN',
          amount: '200000',
          date: '2026-03-08',
          comment: 'TRANSFERENCIA DESDE MI CUENTA',
          metadata: ourMetadata('fp-in', TransactionKind.internal_transfer),
        }),
      ],
    });

    const loaded = await loadImportedTransactions(host.ctx);
    const summary = summarizeMonth('2026-03', loaded.transactions, { currency: 'CLP' });

    expect(summary.income.minor).toBe(0);
    expect(summary.expenses.minor).toBe(0);
    expect(summary.internalTransfers).toEqual(money(200_000, 0, 'CLP'));
  });

  it('restricts the read to the requested window', async () => {
    const host = fakeHost({
      activities: [
        activityStub({
          activityType: 'WITHDRAWAL',
          amount: '1000',
          date: '2025-11-15',
          metadata: ourMetadata('old', TransactionKind.expense),
        }),
        activityStub({
          activityType: 'WITHDRAWAL',
          amount: '2000',
          date: '2026-03-15',
          metadata: ourMetadata('recent', TransactionKind.expense),
        }),
      ],
    });

    const loaded = await loadImportedTransactions(host.ctx, {
      fromDate: monthStart('2026-02'),
      toDate: monthEnd('2026-03'),
    });

    expect(loaded.transactions.map((t) => t.fingerprint)).toEqual(['recent']);
    // A day wider than asked for, because the host slides the bounds by its own
    // timezone; the exact window is re-imposed on the rows that come back.
    expect(host.searchCalls[0]?.filters).toEqual({
      dateFrom: '2026-01-31',
      dateTo: '2026-04-01',
    });
  });

  it('keeps the window exact even though the host is asked for a wider one', async () => {
    const host = fakeHost({
      activities: [
        activityStub({
          activityType: 'WITHDRAWAL',
          amount: '1000',
          date: '2026-01-31',
          metadata: ourMetadata('vispera', TransactionKind.expense),
        }),
        activityStub({
          activityType: 'WITHDRAWAL',
          amount: '2000',
          date: '2026-02-01',
          metadata: ourMetadata('primer-dia', TransactionKind.expense),
        }),
        activityStub({
          activityType: 'WITHDRAWAL',
          amount: '3000',
          date: '2026-04-01',
          metadata: ourMetadata('siguiente', TransactionKind.expense),
        }),
      ],
    });

    const loaded = await loadImportedTransactions(host.ctx, {
      fromDate: monthStart('2026-02'),
      toDate: monthEnd('2026-03'),
    });

    expect(loaded.transactions.map((t) => t.fingerprint)).toEqual(['primer-dia']);
    expect(loaded.scanned).toBe(1);
  });

  /** The host slid the window; the first day of the month must still arrive. */
  it('still reads the first day of the window when the host slides it', async () => {
    const host = fakeHost({
      dateFilterShiftDays: 1,
      activities: [
        activityStub({
          activityType: 'WITHDRAWAL',
          amount: '2000',
          date: '2026-02-01',
          metadata: ourMetadata('primer-dia', TransactionKind.expense),
        }),
      ],
    });

    const loaded = await loadImportedTransactions(host.ctx, {
      fromDate: monthStart('2026-02'),
      toDate: monthEnd('2026-03'),
    });

    expect(loaded.transactions.map((t) => t.fingerprint)).toEqual(['primer-dia']);
  });

  it('pairs each movement with the account it lives in', async () => {
    const host = fakeHost({
      activities: [
        activityStub({
          accountId: 'acc-9',
          activityType: 'WITHDRAWAL',
          amount: '1000',
          date: '2026-03-15',
          metadata: ourMetadata('fp', TransactionKind.expense),
        }),
      ],
    });

    const loaded = await loadImportedTransactions(host.ctx);
    expect(loaded.scoped[0]?.accountId).toBe('acc-9');
  });
});

describe('reconciliation facade', () => {
  it('pairs the two legs of a transfer read back from the host', async () => {
    const host = fakeHost({
      activities: [
        activityStub({
          accountId: 'acc-chile',
          activityType: 'TRANSFER_OUT',
          amount: '200000',
          date: '2026-03-08',
          comment: 'TRANSFERENCIA A BANCOESTADO CUENTA PROPIA',
          metadata: ourMetadata('fp-out', TransactionKind.internal_transfer),
        }),
        activityStub({
          accountId: 'acc-estado',
          activityType: 'TRANSFER_IN',
          amount: '200000',
          date: '2026-03-08',
          comment: 'TRANSFERENCIA ENTRE CUENTAS',
          metadata: ourMetadata('fp-in', TransactionKind.internal_transfer),
        }),
      ],
    });

    const result = await reconcileWindow(host.ctx, {
      fromDate: '2026-03-01',
      toDate: '2026-03-31',
    });

    expect(result.transfers).toHaveLength(1);
    expect(result.transfers[0]?.outflow.accountId).toBe('acc-chile');
    expect(result.transfers[0]?.inflow.accountId).toBe('acc-estado');
    expect(result.matchedFingerprints.has('fp-out')).toBe(true);
    expect(result.truncated).toBe(false);
  });

  it('never scopes the read to one account, because a pair spans two', async () => {
    const host = fakeHost();

    await reconcileWindow(host.ctx, { accountId: 'acc-chile', fromDate: '2026-03-01' });

    expect(host.searchCalls[0]?.filters).not.toHaveProperty('accountIds');
  });

  it('runs the pure matchers over scoped rows without touching the host', () => {
    const result = reconcileScoped([]);
    expect(result.transfers).toEqual([]);
    expect(result.cardPayments).toEqual([]);
    expect(result.considered).toBe(0);
  });

  it('keeps the reconstructed direction the activity type implies', async () => {
    const host = fakeHost({
      activities: [
        activityStub({
          activityType: 'TRANSFER_OUT',
          amount: '200000',
          date: '2026-03-08',
          metadata: ourMetadata('fp-out', TransactionKind.internal_transfer),
        }),
      ],
    });

    const loaded = await loadImportedTransactions(host.ctx);
    expect(loaded.transactions[0]?.direction).toBe(Direction.out);
    expect(loaded.transactions[0]?.amount).toEqual(money(-200_000, 0, 'CLP'));
  });
});
