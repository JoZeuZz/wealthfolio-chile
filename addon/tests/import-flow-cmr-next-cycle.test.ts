import { describe, expect, it } from 'vitest';
import { buildDuplicateIndex } from '../src/core/dedupe/classify';
import { readChileMetadata, type ChileMetadata } from '../src/core/mapping/activities';
import { prepareImport } from '../src/core/pipeline';
import { defaultRules } from '../src/core/rules/builtin';
import { loadDuplicateIndexResult } from '../src/services/activity-index';
import { runImport } from '../src/services/import-runner';
import { fromText } from './fixtures';
import { activityStub, fakeHost, type FakeHost } from './host';

/**
 * Gap de cobertura señalado por la review independiente de OpenCode: los
 * tests existentes de 9164e91/4deb439 fabrican `ExistingMovement` a mano y
 * nunca demuestran que una cuota fresca 5→4 realmente cruza
 * `prepareImport` → `runImport` → `activities.saveMany` con `created=1`, ni
 * que el caso stale sigue bloqueada por defecto. Este archivo cierra ese
 * gap con el pipeline real: `NormalizedTransaction` → `toActivityCreate` →
 * Activity en `fakeHost` → `ActivityIndex` real → candidate del ciclo
 * siguiente → veredicto → `runImport`.
 *
 * Ningún test aquí marca una fila a mano: `willImport` es siempre el valor
 * por defecto de `prepareImport`/`setRowSelection`.
 */

const ACCOUNT = 'acc-cmr-pipeline';

function cmrStatement(fileName: string, remaining: number) {
  return fromText(
    fileName,
    [
      'Banco Falabella - Estado de Cuenta CMR',
      'Tarjeta N: XXXX-XXXX-XXXX-7788',
      '',
      'Fecha;Descripcion;Monto;Cuotas Pendientes',
      `04/02/2026;FALABELLA RETAIL PLAZA VESPUCIO;49.990;${remaining}`,
    ].join('\n'),
  );
}

function prepareCmrCycle(fileName: string, remaining: number, duplicateIndex: ReturnType<typeof buildDuplicateIndex>) {
  return prepareImport({
    file: cmrStatement(fileName, remaining),
    accountId: ACCOUNT,
    accountName: 'CMR',
    parserId: 'banco-falabella.cmr',
    rules: defaultRules(),
    duplicateIndex,
  });
}

/** Append to `host.activities` whatever the last `saveMany` call actually created, the way the host would persist it. */
function persistLastSaveMany(host: FakeHost): void {
  const call = host.saveManyCalls.at(-1);
  if (!call) throw new Error('saveMany fue nunca llamado');
  for (const create of call.request.creates ?? []) {
    host.activities.push(
      activityStub({
        accountId: create.accountId,
        activityType: create.activityType,
        ...(create.subtype ? { subtype: create.subtype } : {}),
        amount: String(create.amount),
        currency: create.currency ?? 'CLP',
        date: String(create.activityDate),
        comment: create.comment ?? '',
        metadata: readChileMetadata(create.metadata as string) as ChileMetadata,
      }),
    );
  }
}

describe('CMR ciclo siguiente: fresh 5->4 llega a saveMany con created=1 (P1 gap cerrado)', () => {
  it('el candidate del ciclo 2 nace willImport=true por default y runImport lo escribe', async () => {
    const host = fakeHost();

    const cycle1 = prepareCmrCycle('cmr-fresh-ciclo-1.csv', 5, buildDuplicateIndex([]));
    expect(cycle1.rows).toHaveLength(1);
    expect(cycle1.rows[0]?.transaction.installmentRemaining).toBe(5);
    expect(cycle1.rows[0]?.willImport).toBe(true);

    const result1 = await runImport({
      ctx: host.ctx,
      prepared: cycle1,
      accountId: ACCOUNT,
      accountName: 'CMR',
    });
    expect(result1.breakdown.created).toBe(1);
    expect(host.saveManyCalls).toHaveLength(1);
    persistLastSaveMany(host);

    // ActivityIndex real, reconstruido desde la Activity que el host acaba de
    // guardar — no un ExistingMovement fabricado a mano.
    const { index } = await loadDuplicateIndexResult(host.ctx, { accountId: ACCOUNT });
    expect(index.byFingerprint.size).toBe(1);

    const cycle2 = prepareCmrCycle('cmr-fresh-ciclo-2.csv', 4, index);
    const row = cycle2.rows[0];
    if (!row) throw new Error('fixture sin filas');

    expect(row.transaction.installmentRemaining).toBe(4);
    expect(row.duplicate.verdict).toBe('none');
    expect(row.duplicate.reason_code).toBe('new');
    // Sin marcar nada a mano: éste es el default que produce `prepareImport`.
    expect(row.willImport).toBe(true);

    const result2 = await runImport({
      ctx: host.ctx,
      prepared: cycle2,
      accountId: ACCOUNT,
      accountName: 'CMR',
    });

    expect(host.saveManyCalls).toHaveLength(2);
    expect(host.saveManyCalls[1]?.request.creates).toHaveLength(1);
    expect(result2.breakdown.created).toBe(1);
    expect(result2.breakdown.skippedProbableDuplicate).toBe(0);
  });
});

describe('CMR ciclo siguiente: stale 5->4 (host-edited) sigue fail-closed por default', () => {
  it('la Activity del ciclo 1 editada en Wealthfolio deja el candidate del ciclo 2 en probable/similar, sin segundo saveMany', async () => {
    const host = fakeHost();

    const cycle1 = prepareCmrCycle('cmr-stale-ciclo-1.csv', 5, buildDuplicateIndex([]));
    const result1 = await runImport({
      ctx: host.ctx,
      prepared: cycle1,
      accountId: ACCOUNT,
      accountName: 'CMR',
    });
    expect(result1.breakdown.created).toBe(1);
    persistLastSaveMany(host);

    // Edición económica en Wealthfolio: sólo la glosa cambia, pero eso ya
    // basta para que `activityProjection` deje de coincidir con `proj` — la
    // misma regla que 4deb439 fija. `cuotaRem=5` cacheado queda stale.
    const stored = host.activities[0];
    if (!stored) throw new Error('fixture sin actividad persistida');
    host.activities[0] = { ...stored, comment: `${stored.comment} (CORREGIDO)` };

    const { index } = await loadDuplicateIndexResult(host.ctx, { accountId: ACCOUNT });

    const cycle2 = prepareCmrCycle('cmr-stale-ciclo-2.csv', 4, index);
    const row = cycle2.rows[0];
    if (!row) throw new Error('fixture sin filas');

    expect(row.duplicate.verdict).toBe('probable');
    expect(row.duplicate.reason_code).toBe('similar');
    // Default de un `probable`: no se importa sin que el usuario intervenga.
    expect(row.willImport).toBe(false);

    const result2 = await runImport({
      ctx: host.ctx,
      prepared: cycle2,
      accountId: ACCOUNT,
      accountName: 'CMR',
    });

    // Ningún segundo `saveMany`: la única llamada sigue siendo la del ciclo 1.
    expect(host.saveManyCalls).toHaveLength(1);
    expect(result2.breakdown.created).toBe(0);
    expect(result2.breakdown.skippedProbableDuplicate).toBe(1);
  });
});
