import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, loadSettings } from '../src/services/settings';
import { StorageKeys } from '../src/services/storage';
import { memoryStore } from './host';

/**
 * Configuración sin funciones muertas.
 *
 * Una opción guardada que nada lee es peor que no tenerla: promete un
 * comportamiento que no existe, y quien la cambia cree haber cambiado algo.
 * Este archivo fija que todo lo que `ChileSettings` declara lo lee alguien.
 */

describe('ChileSettings', () => {
  it('sólo declara opciones que el código consume', () => {
    // Si agregas un campo, agrégalo aquí *y* al lugar que lo lee. Si no hay tal
    // lugar todavía, no es una opción: es una nota para después.
    expect(Object.keys(DEFAULT_SETTINGS).sort()).toEqual([
      'disabledBuiltinRules',
      'transferWindowDays',
      'verboseLogging',
    ]);
  });

  it('rellena con los valores por defecto lo que no esté guardado', async () => {
    const store = memoryStore();
    await store.set(StorageKeys.settings, JSON.stringify({ verboseLogging: true }));

    const settings = await loadSettings(store);
    expect(settings.verboseLogging).toBe(true);
    expect(settings.transferWindowDays).toBe(DEFAULT_SETTINGS.transferWindowDays);
  });

  it('ignora una clave que ya no existe en vez de fallar', async () => {
    // `autoApplyConfirmedTransfers` se eliminó; un valor guardado por una
    // versión anterior no puede romper la lectura.
    const store = memoryStore();
    await store.set(
      StorageKeys.settings,
      JSON.stringify({ autoApplyConfirmedTransfers: true, defaultCurrency: 'USD' }),
    );

    const settings = await loadSettings(store);
    expect(settings).toEqual(DEFAULT_SETTINGS);
  });
});

describe('claves de storage', () => {
  it('no reserva claves para funciones que no existen', () => {
    expect(Object.keys(StorageKeys).sort()).toEqual(['importHistory', 'rules', 'settings']);
  });
});

describe('transferWindowDays llega al matcher', () => {
  it('la ventana guardada acota la búsqueda de contrapartes', async () => {
    const { reconcileWindow } = await import('../src/services/reconciliation');
    const { fakeHost, activityStub } = await import('./host');
    const { toActivityCreate, readChileMetadata } = await import(
      '../src/core/mapping/activities'
    );
    const { makeTransaction } = await import('./fixtures');

    const legs = [
      { accountId: 'a', amount: -100000, date: '2026-02-01', type: 'TRANSFER_OUT' },
      { accountId: 'b', amount: 100000, date: '2026-02-05', type: 'TRANSFER_IN' },
    ];

    const activities = legs.map((legDef) => {
      const create = toActivityCreate(
        makeTransaction({
          amount: legDef.amount,
          date: legDef.date,
          description: 'TRASPASO A CUENTA PROPIA',
        }),
        { accountId: legDef.accountId, runId: 'run-1' },
      );
      return activityStub({
        accountId: legDef.accountId,
        activityType: legDef.type,
        amount: String(Math.abs(legDef.amount)),
        date: legDef.date,
        comment: create.comment as string,
        metadata: readChileMetadata(create.metadata as string) as unknown as Record<
          string,
          unknown
        >,
      });
    });

    const wide = fakeHost({ activities });
    await wide.store.set(StorageKeys.settings, JSON.stringify({ transferWindowDays: 10 }));
    expect((await reconcileWindow(wide.ctx)).transfers).toHaveLength(1);

    const narrow = fakeHost({ activities });
    await narrow.store.set(StorageKeys.settings, JSON.stringify({ transferWindowDays: 2 }));
    expect((await reconcileWindow(narrow.ctx)).transfers).toHaveLength(0);
  });
});
