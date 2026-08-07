import { describe, expect, it } from 'vitest';
import { classifyDuplicate } from '../src/core/dedupe/classify';
import { computeFingerprint, computeWeakFingerprint } from '../src/core/dedupe/fingerprint';
import {
  readChileMetadata,
  toActivityCreate,
  type ChileMetadata,
} from '../src/core/mapping/activities';
import { money } from '../src/core/money';
import { Direction, TransactionKind } from '../src/core/model/kinds';
import type { NormalizedTransaction } from '../src/core/model/transaction';
import {
  activityDateFilters,
  loadDuplicateIndex,
  loadDuplicateIndexResult,
} from '../src/services/activity-index';
import { makeTransaction } from './fixtures';
import { activityStub, fakeHost } from './host';

/**
 * The duplicate index, read back from a live host.
 *
 * These tests cover the seam where a wrong answer is invisible: the index looks
 * fine, the import succeeds, and the user finds the same expense twice a month
 * later.
 */

const ACCOUNT = 'acc-1';
const SCOPE = { accountId: ACCOUNT };

function ourMetadata(overrides: { fp: string; wfp?: string; kind?: TransactionKind }) {
  return {
    fp: overrides.fp,
    ...(overrides.wfp ? { wfp: overrides.wfp } : {}),
    inst: 'banco-chile',
    parser: 'banco-chile.cartola-csv',
    parserVersion: '1.0.0',
    fileHash: 'file-hash',
    runId: 'run-1',
    kind: overrides.kind ?? TransactionKind.expense,
  };
}

/**
 * Store a transaction the way the addon really does: through the writer, not by
 * hand. A stub can agree with a reader that both get the sign wrong.
 */
function writeAsAddonWould(transaction: NormalizedTransaction) {
  const create = toActivityCreate(transaction, {
    accountId: ACCOUNT,
    runId: 'run-1',
    weakFingerprint: computeWeakFingerprint(transaction, SCOPE),
  });

  return activityStub({
    accountId: ACCOUNT,
    activityType: create.activityType,
    ...(create.subtype ? { subtype: create.subtype } : {}),
    amount: String(create.amount),
    currency: create.currency ?? 'CLP',
    date: String(create.activityDate),
    comment: create.comment ?? '',
    metadata: readChileMetadata(create.metadata) as ChileMetadata,
  });
}

describe('loadDuplicateIndex', () => {
  it('indexes exact and weak fingerprints from activity metadata', async () => {
    const host = fakeHost({
      activities: [
        activityStub({
          activityType: 'WITHDRAWAL',
          amount: '85400',
          date: '2026-03-06',
          comment: 'SUPERMERCADO',
          metadata: ourMetadata({ fp: 'fp-exact', wfp: 'wfp-weak' }),
        }),
      ],
    });

    const result = await loadDuplicateIndexResult(host.ctx, { accountId: ACCOUNT });

    expect(result.scanned).toBe(1);
    expect(result.truncated).toBe(false);
    expect(result.index.byFingerprint.get('fp-exact')?.activityId).toBeDefined();
    expect(result.index.byWeakFingerprint.get('wfp-weak')).toHaveLength(1);
  });

  it('reconstructs a signed amount from the activity type', async () => {
    const host = fakeHost({
      activities: [
        activityStub({
          activityType: 'WITHDRAWAL',
          amount: '85400',
          date: '2026-03-06',
          metadata: ourMetadata({ fp: 'out' }),
        }),
        activityStub({
          activityType: 'DEPOSIT',
          amount: '1000000',
          date: '2026-03-05',
          metadata: ourMetadata({ fp: 'in', kind: TransactionKind.income }),
        }),
        activityStub({
          activityType: 'TRANSFER_OUT',
          amount: '200000',
          date: '2026-03-07',
          metadata: ourMetadata({ fp: 'xfer-out', kind: TransactionKind.internal_transfer }),
        }),
        activityStub({
          activityType: 'TRANSFER_IN',
          amount: '200000',
          date: '2026-03-07',
          metadata: ourMetadata({ fp: 'xfer-in', kind: TransactionKind.internal_transfer }),
        }),
      ],
    });

    const { index } = await loadDuplicateIndexResult(host.ctx, { accountId: ACCOUNT });

    expect(index.byFingerprint.get('out')?.amount).toEqual(money(-85400, 0, 'CLP'));
    expect(index.byFingerprint.get('in')?.amount).toEqual(money(1000000, 0, 'CLP'));
    expect(index.byFingerprint.get('xfer-out')?.amount).toEqual(money(-200000, 0, 'CLP'));
    expect(index.byFingerprint.get('xfer-in')?.amount).toEqual(money(200000, 0, 'CLP'));
  });

  it('reads a null amount as zero instead of failing the whole scan', async () => {
    const host = fakeHost({
      activities: [
        activityStub({
          activityType: 'UNKNOWN',
          amount: null as unknown as string,
          date: '2026-03-06',
          metadata: ourMetadata({ fp: 'empty' }),
        }),
      ],
    });

    const { index } = await loadDuplicateIndexResult(host.ctx, { accountId: ACCOUNT });
    expect(index.byFingerprint.get('empty')?.amount).toEqual(money(0, 0, 'CLP'));
  });

  it('keeps activities that are not ours, so weak matching still sees them', async () => {
    const host = fakeHost({
      activities: [
        activityStub({ activityType: 'WITHDRAWAL', amount: '5000', date: '2026-03-06' }),
      ],
    });

    const result = await loadDuplicateIndexResult(host.ctx, { accountId: ACCOUNT });

    expect(result.scanned).toBe(1);
    expect(result.index.byFingerprint.size).toBe(0);
    expect(result.index.byWeakFingerprint.size).toBe(0);
  });
});

describe('pagination', () => {
  it('walks every page until the host reports no more rows', async () => {
    const activities = Array.from({ length: 1250 }, (_, i) =>
      activityStub({
        activityType: 'WITHDRAWAL',
        amount: '1000',
        date: '2026-03-06',
        metadata: ourMetadata({ fp: `fp-${i}` }),
      }),
    );
    const host = fakeHost({ activities });

    const result = await loadDuplicateIndexResult(host.ctx, { accountId: ACCOUNT });

    expect(result.scanned).toBe(1250);
    expect(result.totalRowCount).toBe(1250);
    expect(result.truncated).toBe(false);
    expect(host.searchCalls.map((call) => call.page)).toEqual([0, 1, 2]);
  });

  it('stops on the first short page without asking for another', async () => {
    const host = fakeHost({
      activities: [
        activityStub({
          activityType: 'WITHDRAWAL',
          amount: '1000',
          date: '2026-03-06',
          metadata: ourMetadata({ fp: 'only' }),
        }),
      ],
    });

    await loadDuplicateIndexResult(host.ctx, { accountId: ACCOUNT });
    expect(host.searchCalls).toHaveLength(1);
  });

  it('reports truncation instead of silently returning a partial index', async () => {
    // 40 pages of 500 is the cap; the host holds one row more than that.
    const activities = Array.from({ length: 20_001 }, (_, i) =>
      activityStub({
        activityType: 'WITHDRAWAL',
        amount: '1000',
        date: '2026-03-06',
        metadata: ourMetadata({ fp: `fp-${i}` }),
      }),
    );
    const host = fakeHost({ activities });

    const result = await loadDuplicateIndexResult(host.ctx, { accountId: ACCOUNT });

    expect(result.truncated).toBe(true);
    expect(result.scanned).toBe(20_000);
    expect(result.totalRowCount).toBe(20_001);
  });
});

describe('filters sent to the host', () => {
  it('uses the dateFrom/dateTo names v3.6.2 actually reads, padded by a day', () => {
    expect(
      activityDateFilters({ accountId: ACCOUNT, fromDate: '2026-03-01', toDate: '2026-03-31' }),
    ).toEqual({ accountIds: ACCOUNT, dateFrom: '2026-02-28', dateTo: '2026-04-01' });
  });

  it('omits bounds that were not asked for', () => {
    expect(activityDateFilters({ accountId: ACCOUNT })).toEqual({ accountIds: ACCOUNT });
    expect(activityDateFilters({})).toEqual({});
  });

  it('narrows the scan to the requested window', async () => {
    const host = fakeHost({
      activities: [
        activityStub({
          activityType: 'WITHDRAWAL',
          amount: '1000',
          date: '2026-01-15',
          metadata: ourMetadata({ fp: 'january' }),
        }),
        activityStub({
          activityType: 'WITHDRAWAL',
          amount: '2000',
          date: '2026-03-15',
          metadata: ourMetadata({ fp: 'march' }),
        }),
      ],
    });

    const { index } = await loadDuplicateIndexResult(host.ctx, {
      accountId: ACCOUNT,
      fromDate: '2026-03-01',
      toDate: '2026-03-31',
    });

    expect(index.byFingerprint.has('march')).toBe(true);
    expect(index.byFingerprint.has('january')).toBe(false);
    expect(host.searchCalls[0]?.filters).toEqual({
      accountIds: ACCOUNT,
      dateFrom: '2026-02-28',
      dateTo: '2026-04-01',
    });
  });

  /**
   * Observed on a real Wealthfolio v3.6.2 container on 2026-08-07: the backend
   * reads `dateFrom`/`dateTo` in the instance timezone while storing our bare
   * `YYYY-MM-DD` activity dates at UTC midnight, so under `America/Santiago`
   * the whole window comes back slid a day forward. A movement on the first day
   * of the window then never reaches the index, the import calls it new, and the
   * user gets it twice.
   */
  it('still sees the edges of the window when the host slides it a day', async () => {
    const host = fakeHost({
      dateFilterShiftDays: 1,
      activities: [
        activityStub({
          activityType: 'WITHDRAWAL',
          amount: '1000',
          date: '2026-03-01',
          metadata: ourMetadata({ fp: 'primer-dia' }),
        }),
        activityStub({
          activityType: 'WITHDRAWAL',
          amount: '2000',
          date: '2026-03-31',
          metadata: ourMetadata({ fp: 'ultimo-dia' }),
        }),
      ],
    });

    const { index } = await loadDuplicateIndexResult(host.ctx, {
      accountId: ACCOUNT,
      fromDate: '2026-03-01',
      toDate: '2026-03-31',
    });

    expect(index.byFingerprint.has('primer-dia')).toBe(true);
    expect(index.byFingerprint.has('ultimo-dia')).toBe(true);
  });

  it('drops what the padding dragged in beyond the window', async () => {
    const host = fakeHost({
      activities: [
        activityStub({
          activityType: 'WITHDRAWAL',
          amount: '1000',
          date: '2026-02-28',
          metadata: ourMetadata({ fp: 'vispera' }),
        }),
        activityStub({
          activityType: 'WITHDRAWAL',
          amount: '2000',
          date: '2026-03-01',
          metadata: ourMetadata({ fp: 'dentro' }),
        }),
        activityStub({
          activityType: 'WITHDRAWAL',
          amount: '3000',
          date: '2026-04-01',
          metadata: ourMetadata({ fp: 'siguiente' }),
        }),
      ],
    });

    const result = await loadDuplicateIndexResult(host.ctx, {
      accountId: ACCOUNT,
      fromDate: '2026-03-01',
      toDate: '2026-03-31',
    });

    expect(result.index.byFingerprint.has('dentro')).toBe(true);
    expect(result.index.byFingerprint.has('vispera')).toBe(false);
    expect(result.index.byFingerprint.has('siguiente')).toBe(false);
    expect(result.scanned).toBe(1);
  });

  it('only reads the requested account', async () => {
    const host = fakeHost({
      activities: [
        activityStub({
          accountId: 'acc-2',
          activityType: 'WITHDRAWAL',
          amount: '1000',
          date: '2026-03-15',
          metadata: ourMetadata({ fp: 'other-account' }),
        }),
      ],
    });

    const { index } = await loadDuplicateIndexResult(host.ctx, { accountId: ACCOUNT });
    expect(index.byFingerprint.size).toBe(0);
  });
});

describe('failure', () => {
  it('propagates a host error rather than returning an empty index', async () => {
    const host = fakeHost();
    host.searchError = new Error('backend unavailable');

    await expect(loadDuplicateIndex(host.ctx, { accountId: ACCOUNT })).rejects.toThrow(
      'backend unavailable',
    );
  });
});

describe('end to end: index feeds classification', () => {
  it('flags an exact re-import and a probable near-match from real host rows', async () => {
    const original = makeTransaction({
      date: '2026-03-06',
      amount: -85_400,
      description: 'SUPERMERCADO LIDER',
      kind: TransactionKind.expense,
      direction: Direction.out,
    });
    const fingerprint = computeFingerprint(original, SCOPE);
    const weak = computeWeakFingerprint(original, SCOPE);

    const host = fakeHost({
      activities: [
        activityStub({
          activityType: 'WITHDRAWAL',
          amount: '85400',
          date: '2026-03-06',
          comment: 'SUPERMERCADO LIDER',
          metadata: ourMetadata({ fp: fingerprint, wfp: weak }),
        }),
      ],
    });

    const index = await loadDuplicateIndex(host.ctx, { accountId: ACCOUNT });

    const exact = classifyDuplicate({ ...original, fingerprint }, index, SCOPE, new Map());
    expect(exact.verdict).toBe('exact');

    const drifted = makeTransaction({
      date: '2026-03-06',
      amount: -85_400,
      description: 'SUPERMERCADO LIDER LOCAL 22',
      kind: TransactionKind.expense,
      direction: Direction.out,
    });
    const probable = classifyDuplicate(
      { ...drifted, fingerprint: computeFingerprint(drifted, SCOPE) },
      index,
      SCOPE,
      new Map(),
    );
    expect(probable.verdict).toBe('probable');
  });

  /**
   * The same path for a row nothing classified.
   *
   * Written through the real `toActivityCreate()` rather than a hand-made stub,
   * because the bug lived precisely in what the writer produces: an outgoing
   * 4.500 becomes `UNKNOWN` with `amount = 4500`, and before `metadata.dir`
   * existed the index rebuilt it as `+4500` and matched nothing.
   */
  it('flags a drifted re-import of an UNKNOWN outflow as probable', async () => {
    const source = makeTransaction({
      date: '2026-03-01',
      amount: -4_500,
      description: 'CARGO NO RECONOCIDO 4471',
      kind: TransactionKind.unknown,
      direction: Direction.out,
    });
    const original = { ...source, fingerprint: computeFingerprint(source, SCOPE) };

    const stored = writeAsAddonWould(original);
    expect(stored.activityType).toBe('UNKNOWN');
    expect(stored.amount).toBe('4500');

    const host = fakeHost({ activities: [stored] });
    const index = await loadDuplicateIndex(host.ctx, { accountId: ACCOUNT });

    expect(index.byFingerprint.get(original.fingerprint)?.amount).toEqual(money(-4_500, 0, 'CLP'));

    // The bank re-exports the same charge with a longer glosa: the exact
    // fingerprint no longer matches, so only the signed amount can catch it.
    const reExported = makeTransaction({
      date: '2026-03-01',
      amount: -4_500,
      description: 'CARGO NO RECONOCIDO 4471 REF',
      kind: TransactionKind.unknown,
      direction: Direction.out,
    });
    const candidate = { ...reExported, fingerprint: computeFingerprint(reExported, SCOPE) };
    expect(candidate.fingerprint).not.toBe(original.fingerprint);

    const finding = classifyDuplicate(candidate, index, SCOPE, new Map());

    expect(finding.verdict).toBe('probable');
    expect(finding.existingActivityId).toBe(stored.id);
  });
});
