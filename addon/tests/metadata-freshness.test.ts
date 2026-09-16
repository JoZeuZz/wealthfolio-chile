import { describe, expect, it } from 'vitest';
import {
  activityProjection,
  isActivityMetadataCurrent,
  type ProjectableActivity,
} from '../src/core/mapping/activities';

/**
 * P1 (review independiente de OpenCode) — una sola definición de frescura de
 * metadata.
 *
 * `core/mapping/activities.ts` (`metadataCacheIsCurrent`, usado por
 * `activityToTransaction`) y `services/activity-index.ts`
 * (`wasModifiedAfterImport`) tenían dos copias de la misma regla que
 * coincidían para toda proyección real, pero divergían para una malformada:
 * `proj: ''` pasaba por "ausente" en un lado (cae a `isUserModified`) y por
 * "presente, comparar" en el otro. `readChileMetadata` no valida `proj` con
 * el mismo rigor que `fp`/`fc`/`kc`, así que ese valor puede llegar desde
 * metadata editada a mano o de un esquema ajeno.
 *
 * Estos tests fijan la definición canónica directamente, antes de tocar
 * ningún consumidor: `isActivityMetadataCurrent(activity, recordedProjection)`.
 */

const ACCOUNT = 'acc-1';

function activity(overrides: Partial<ProjectableActivity & { isUserModified?: boolean }> = {}) {
  return {
    accountId: ACCOUNT,
    date: '2026-02-03',
    amount: '85400',
    currency: 'CLP',
    activityType: 'WITHDRAWAL',
    comment: 'COMPRA',
    ...overrides,
  };
}

describe('isActivityMetadataCurrent — definición canónica', () => {
  it('proj válida + Activity intacta -> current', () => {
    const base = activity();
    const proj = activityProjection(base);
    expect(isActivityMetadataCurrent(base, proj)).toBe(true);
  });

  it('proj válida + host edit -> stale', () => {
    const base = activity();
    const proj = activityProjection(base);
    const edited = activity({ amount: '99999' });
    expect(isActivityMetadataCurrent(edited, proj)).toBe(false);
  });

  it('proj undefined + isUserModified false -> current (legacy pre-schema-3)', () => {
    expect(isActivityMetadataCurrent(activity({ isUserModified: false }), undefined)).toBe(true);
  });

  it('proj undefined + isUserModified true -> stale', () => {
    expect(isActivityMetadataCurrent(activity({ isUserModified: true }), undefined)).toBe(false);
  });

  it('proj "" -> stale aunque isUserModified sea false (malformed, no legacy)', () => {
    expect(isActivityMetadataCurrent(activity({ isUserModified: false }), '')).toBe(false);
  });

  it('proj runtime no-string -> stale (number)', () => {
    expect(isActivityMetadataCurrent(activity({ isUserModified: false }), 42)).toBe(false);
  });

  it('proj runtime no-string -> stale (object)', () => {
    expect(isActivityMetadataCurrent(activity({ isUserModified: false }), { not: 'a hash' })).toBe(false);
  });
});
