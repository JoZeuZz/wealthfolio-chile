import { describe, expect, it } from 'vitest';
import { buildDuplicateIndex } from '../src/core/dedupe/classify';
import { METADATA_NAMESPACE, readChileMetadata } from '../src/core/mapping/activities';
import { prepareImport, setRowSelection, type PreparedImport } from '../src/core/pipeline';
import { defaultRules } from '../src/core/rules/builtin';
import { ImportHistory } from '../src/services/import-history';
import { buildBreakdown, runImport } from '../src/services/import-runner';
import { loadFixture } from './fixtures';
import { fakeHost } from './host';

/**
 * Writing an approved preview.
 *
 * The distinction under test is the one BUG 3 was about: `created`, `failed`
 * and the four reasons a row was never attempted are four different facts, and
 * collapsing them into "skipped" hides the only one that costs the user money.
 */

const ACCOUNT = 'acc-1';

function prepare(overrides: { file?: string } = {}): PreparedImport {
  return prepareImport({
    file: loadFixture(overrides.file ?? 'banco-chile-cuenta-corriente.csv'),
    accountId: ACCOUNT,
    accountName: 'Cuenta corriente',
    rules: defaultRules(),
    duplicateIndex: buildDuplicateIndex([]),
  });
}

describe('saveMany', () => {
  it('writes every approved row and reports a completed run', async () => {
    const host = fakeHost();
    const prepared = prepare();
    const selected = prepared.rows.filter((row) => row.willImport).length;
    expect(selected).toBeGreaterThan(0);

    const result = await runImport({
      ctx: host.ctx,
      prepared,
      accountId: ACCOUNT,
      accountName: 'Cuenta corriente',
    });

    expect(result.status).toBe('completed');
    expect(result.breakdown.created).toBe(selected);
    expect(result.breakdown.failed).toBe(0);
    expect(result.errors).toEqual([]);
    expect(result.historyRecorded).toBe(true);
  });

  it('sends creates, never updates or deletes', async () => {
    const host = fakeHost();
    await runImport({
      ctx: host.ctx,
      prepared: prepare(),
      accountId: ACCOUNT,
      accountName: 'Cuenta corriente',
    });

    for (const call of host.saveManyCalls) {
      expect(call.request.creates?.length).toBeGreaterThan(0);
      expect(call.request.updates).toBeUndefined();
      expect(call.request.deleteIds).toBeUndefined();
    }
  });

  it('invalidates the activity and portfolio queries once written', async () => {
    const host = fakeHost();
    await runImport({
      ctx: host.ctx,
      prepared: prepare(),
      accountId: ACCOUNT,
      accountName: 'Cuenta corriente',
    });

    expect(host.invalidatedKeys).toContainEqual(['activities']);
    expect(host.invalidatedKeys).toContainEqual(['portfolio']);
  });

  it('carries our metadata into the creation payload', async () => {
    const host = fakeHost();
    const prepared = prepare();

    await runImport({
      ctx: host.ctx,
      prepared,
      accountId: ACCOUNT,
      accountName: 'Cuenta corriente',
    });

    const firstCreate = host.saveManyCalls[0]?.request.creates?.[0];
    const metadata = readChileMetadata(firstCreate?.metadata);

    expect(metadata?.fp).toBeTruthy();
    expect(metadata?.wfp).toBeTruthy();
    expect(metadata?.inst).toBe(prepared.statement.institution);
    expect(metadata?.parserVersion).toBe(prepared.statement.parserVersion);
    expect(metadata?.runId).toMatch(/^run-/);
    expect(typeof firstCreate?.metadata).toBe('string');
    expect(JSON.parse(firstCreate?.metadata as string)[METADATA_NAMESPACE]).toBeDefined();
  });

  it('stamps every row of a run with the same run id', async () => {
    const host = fakeHost();
    await runImport({
      ctx: host.ctx,
      prepared: prepare(),
      accountId: ACCOUNT,
      accountName: 'Cuenta corriente',
    });

    const runIds = new Set(
      host.saveManyCalls
        .flatMap((call) => call.request.creates ?? [])
        .map((create) => readChileMetadata(create.metadata)?.runId),
    );

    expect(runIds.size).toBe(1);
  });
});

describe('batching', () => {
  it('splits more than 100 rows into several batches', async () => {
    const host = fakeHost();
    const prepared = prepare();

    // Grow the preview to 250 approved rows by cloning what the fixture gave us.
    const template = prepared.rows.find((row) => row.willImport);
    expect(template).toBeDefined();
    const rows = Array.from({ length: 250 }, (_, i) => ({
      ...(template as NonNullable<typeof template>),
      transaction: {
        ...(template as NonNullable<typeof template>).transaction,
        fingerprint: `synthetic-${i}`,
      },
      weakFingerprint: `synthetic-weak-${i}`,
      willImport: true,
    }));

    const result = await runImport({
      ctx: host.ctx,
      prepared: { ...prepared, rows },
      accountId: ACCOUNT,
      accountName: 'Cuenta corriente',
    });

    expect(host.saveManyCalls).toHaveLength(3);
    expect(host.saveManyCalls[0]?.request.creates).toHaveLength(100);
    expect(host.saveManyCalls[2]?.request.creates).toHaveLength(50);
    expect(result.breakdown.created).toBe(250);
    expect(result.status).toBe('completed');
  });
});

describe('partial and total failure', () => {
  it('reports a partial run when the host rejects some rows', async () => {
    const host = fakeHost();
    const prepared = prepare();
    const selected = prepared.rows.filter((row) => row.willImport).length;
    // The single batch creates only two of the approved rows.
    host.saveManyPlan = [2];

    const result = await runImport({
      ctx: host.ctx,
      prepared,
      accountId: ACCOUNT,
      accountName: 'Cuenta corriente',
    });

    expect(result.status).toBe('partial');
    expect(result.breakdown.created).toBe(2);
    expect(result.breakdown.failed).toBe(selected - 2);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.run.status).toBe('partial');
    expect(result.run.failedRows).toBe(selected - 2);
  });

  it('reports a failed run when no row survives', async () => {
    const host = fakeHost();
    host.saveManyPlan = ['throw'];

    const result = await runImport({
      ctx: host.ctx,
      prepared: prepare(),
      accountId: ACCOUNT,
      accountName: 'Cuenta corriente',
    });

    expect(result.status).toBe('failed');
    expect(result.breakdown.created).toBe(0);
    expect(result.errors).toContain('host rejected the batch');
    expect(host.logs.some((entry) => entry.level === 'error')).toBe(true);
  });

  it('does not retry a batch that threw', async () => {
    const host = fakeHost();
    host.saveManyPlan = ['throw'];

    await runImport({
      ctx: host.ctx,
      prepared: prepare(),
      accountId: ACCOUNT,
      accountName: 'Cuenta corriente',
    });

    expect(host.saveManyCalls).toHaveLength(1);
  });

  it('keeps a successful write when the history cannot be recorded', async () => {
    const host = fakeHost();
    const prepared = prepare();
    const selected = prepared.rows.filter((row) => row.willImport).length;

    // Everything is written, then storage refuses the history entry.
    const original = host.store.set.bind(host.store);
    host.store.set = async () => {
      throw new Error('storage full');
    };

    const result = await runImport({
      ctx: host.ctx,
      prepared,
      accountId: ACCOUNT,
      accountName: 'Cuenta corriente',
    });
    host.store.set = original;

    expect(result.breakdown.created).toBe(selected);
    expect(result.status).toBe('completed');
    expect(result.historyRecorded).toBe(false);
    expect(result.errors.join(' ')).toContain('historial');
  });
});

describe('history recording', () => {
  it('writes one run with the full breakdown', async () => {
    const host = fakeHost();
    const prepared = prepare();

    const result = await runImport({
      ctx: host.ctx,
      prepared,
      accountId: ACCOUNT,
      accountName: 'Cuenta corriente',
    });

    const runs = await new ImportHistory(host.store).all();
    expect(runs).toHaveLength(1);

    const stored = runs[0];
    expect(stored?.id).toBe(result.run.id);
    expect(stored?.accountId).toBe(ACCOUNT);
    expect(stored?.fileHash).toBe(prepared.fileHash);
    expect(stored?.detectedRows).toBe(prepared.rows.length);
    expect(stored?.selectedRows).toBe(result.breakdown.selected);
    expect(stored?.importedRows).toBe(result.breakdown.created);
    expect(stored?.parserVersion).toBe(prepared.statement.parserVersion);
  });

  it('never logs a description or an amount', async () => {
    const host = fakeHost();
    await runImport({
      ctx: host.ctx,
      prepared: prepare(),
      accountId: ACCOUNT,
      accountName: 'Cuenta corriente',
    });

    const logged = host.logs.map((entry) => entry.message).join('\n');
    expect(logged).not.toMatch(/\d{1,3}(\.\d{3})+/);
    expect(logged).not.toContain('Cuenta corriente');
  });
});

describe('buildBreakdown', () => {
  const row = (overrides: {
    willImport: boolean;
    verdict?: 'exact' | 'probable' | 'none';
    ignoredByRule?: boolean;
  }) =>
    ({
      transaction: {},
      weakFingerprint: 'w',
      duplicate: { verdict: overrides.verdict ?? 'none', reason: '' },
      ignoredByRule: overrides.ignoredByRule ?? false,
      willImport: overrides.willImport,
    }) as never;

  it('attributes every row to exactly one outcome', () => {
    const breakdown = buildBreakdown(
      [
        row({ willImport: true }),
        row({ willImport: true }),
        row({ willImport: false, verdict: 'exact' }),
        row({ willImport: false, verdict: 'probable' }),
        row({ willImport: false, ignoredByRule: true }),
        row({ willImport: false }),
      ],
      2,
    );

    expect(breakdown).toEqual({
      detected: 6,
      selected: 2,
      created: 2,
      failed: 0,
      skippedExactDuplicate: 1,
      skippedProbableDuplicate: 1,
      skippedByRule: 1,
      skippedByUser: 1,
    });
  });

  it('counts approved-but-unwritten rows as failed, not skipped', () => {
    const breakdown = buildBreakdown([row({ willImport: true }), row({ willImport: true })], 1);
    expect(breakdown.failed).toBe(1);
    expect(breakdown.skippedByUser).toBe(0);
  });

  it('attributes a duplicate the user unticked to the duplicate, not to the user', () => {
    const breakdown = buildBreakdown(
      [row({ willImport: false, verdict: 'exact', ignoredByRule: true })],
      0,
    );
    expect(breakdown.skippedExactDuplicate).toBe(1);
    expect(breakdown.skippedByRule).toBe(0);
  });

  it('never reports more created than were approved', () => {
    const breakdown = buildBreakdown([row({ willImport: true })], 99);
    expect(breakdown.created).toBe(1);
    expect(breakdown.failed).toBe(0);
  });

  it('tracks a row the user unticked in the preview', () => {
    const prepared = prepare();
    const first = prepared.rows.find((r) => r.willImport);
    const toggled = setRowSelection(prepared, first?.transaction.fingerprint as string, false);

    const breakdown = buildBreakdown(toggled.rows, 0);
    expect(breakdown.skippedByUser).toBeGreaterThanOrEqual(1);
  });
});
