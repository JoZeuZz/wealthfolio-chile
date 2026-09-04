/** @vitest-environment happy-dom */
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { readChileMetadata, toActivityCreate } from '../../src/core/mapping/activities';
import { TransactionKind } from '../../src/core/model/kinds';
import { SettingsPage } from '../../src/ui/pages/SettingsPage';
import { StorageKeys } from '../../src/services/storage';
import { makeTransaction } from '../fixtures';
import { activityStub } from '../host';
import { renderPage } from './harness';

/**
 * La pantalla de configuración.
 *
 * Lo que se prueba aquí no son los internos de React: es lo que el usuario ve
 * y hace. En particular, dos cosas que son la razón de que esta pantalla exista
 * y no sea un panel de administración genérico:
 *
 * 1. una regla se ve antes de guardarse, con el número de movimientos que
 *    cambiaría;
 * 2. lo que cambia la interpretación financiera de un movimiento no se puede
 *    pedir desde aquí, por mucho que el motor sepa hacerlo.
 */

/**
 * Una actividad que el addon escribió, para que la vista previa tenga con qué.
 *
 * Fechada respecto de hoy: la vista previa mira los últimos seis meses, así que
 * una fecha fija saldría de la ventana en cuanto pasara el tiempo y el test
 * empezaría a fallar por el calendario.
 */
const RECENT = new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10);

function ourActivity(description: string, amount: number, id: string) {
  const create = toActivityCreate(
    makeTransaction({
      description,
      amount,
      date: RECENT,
      kind: amount < 0 ? TransactionKind.expense : TransactionKind.income,
    }),
    { accountId: 'acc-1', runId: 'run-1' },
  );
  return activityStub({
    id,
    accountId: 'acc-1',
    activityType: create.activityType,
    amount: String(Math.abs(amount)),
    currency: 'CLP',
    date: RECENT,
    comment: create.comment as string,
    metadata: readChileMetadata(create.metadata as string) as unknown as Record<string, unknown>,
  });
}

describe('configuración', () => {
  it('carga los valores por defecto', async () => {
    renderPage(<SettingsPage />);

    const field = await screen.findByLabelText(/días de margen/i);
    expect(field).toHaveValue(5);
  });

  it('lee lo que ya estaba guardado', async () => {
    renderPage(<SettingsPage />, {
      storage: {
        [StorageKeys.settings]: JSON.stringify({
          verboseLogging: true,
          transferWindowDays: 9,
          disabledBuiltinRules: [],
        }),
      },
    });

    expect(await screen.findByLabelText(/días de margen/i)).toHaveValue(9);
    expect(screen.getByLabelText(/diagnóstico detallado/i)).toBeChecked();
  });

  it('cambiar el margen se guarda', async () => {
    const { host, user } = renderPage(<SettingsPage />);

    const field = await screen.findByLabelText(/días de margen/i);
    await user.clear(field);
    await user.type(field, '12');
    await user.tab();

    const stored = JSON.parse(host.store.data.get(StorageKeys.settings) as string) as {
      transferWindowDays: number;
    };
    expect(stored.transferWindowDays).toBe(12);
  });

  it('un margen imposible se acota en vez de guardarse', async () => {
    const { host, user } = renderPage(<SettingsPage />);

    const field = await screen.findByLabelText(/días de margen/i);
    await user.clear(field);
    await user.type(field, '900');
    await user.tab();

    const stored = JSON.parse(host.store.data.get(StorageKeys.settings) as string) as {
      transferWindowDays: number;
    };
    expect(stored.transferWindowDays).toBe(30);
  });

  it('desactivar una regla predefinida se recuerda por su id', async () => {
    const { host, user } = renderPage(<SettingsPage />);

    const toggle = await screen.findByLabelText('Pago de tarjeta de crédito');
    expect(toggle).toBeChecked();
    await user.click(toggle);

    const stored = JSON.parse(host.store.data.get(StorageKeys.settings) as string) as {
      disabledBuiltinRules: string[];
    };
    expect(stored.disabledBuiltinRules).toContain('builtin.pago-tarjeta');
  });

  it('las reglas que mueven totales se señalan, y las demás no', async () => {
    renderPage(<SettingsPage />);
    await screen.findByText('Reglas predefinidas');

    const flagged = screen.getAllByText('Afecta a los totales');
    expect(flagged.length).toBeGreaterThan(0);
    // Y no todas: si todas llevaran la marca, la marca no diría nada.
    expect(flagged.length).toBeLessThan(screen.getAllByRole('switch').length);
  });

  it('los bancos se muestran con su calibración real, sin adornarla', async () => {
    renderPage(<SettingsPage />);
    await screen.findByText('Bancos reconocidos');

    expect(screen.getAllByText('Sin cartola real').length).toBeGreaterThan(0);
  });
});

describe('editor de reglas', () => {
  it('sólo ofrece acciones que no cambian la interpretación financiera', async () => {
    const { user } = renderPage(<SettingsPage />);

    await user.click(await screen.findByRole('button', { name: 'Nueva regla' }));

    const actions = within(await screen.findByLabelText('Acción')).getAllByRole('option');
    const labels = actions.map((option) => option.textContent);
    expect(labels).toContain('poner la categoría');
    expect(labels.join(' ')).not.toMatch(/transferencia|reclasific/i);
  });

  it('no guarda una regla incompleta y dice por qué', async () => {
    const { host, user } = renderPage(<SettingsPage />);

    await user.click(await screen.findByRole('button', { name: 'Nueva regla' }));
    await user.click(screen.getByRole('button', { name: 'Guardar regla' }));

    expect(await screen.findByText(/todavía no se puede guardar/i)).toBeInTheDocument();
    expect(host.store.data.get(StorageKeys.rules)).toBeUndefined();
  });

  it('dice cuántos movimientos cambiaría antes de guardar', async () => {
    const { user } = renderPage(<SettingsPage />, {
      activities: [
        ourActivity('FARMACIA CRUZ VERDE', -12_000, 'a1'),
        ourActivity('FARMACIA AHUMADA', -8_000, 'a2'),
        ourActivity('SUPERMERCADO LIDER', -45_000, 'a3'),
      ],
    });

    await user.click(await screen.findByRole('button', { name: 'Nueva regla' }));
    await user.type(screen.getByLabelText('Nombre'), 'Farmacias');
    await user.type(screen.getByLabelText('Valor', { selector: '#condition-value' }), 'FARMACIA');
    await user.type(screen.getByLabelText('Valor', { selector: '#action-value' }), 'salud');

    expect(await screen.findByText(/Cambiaría 2 de 3 movimientos/i)).toBeInTheDocument();
  });

  it('guardar la regla la persiste con versión de esquema', async () => {
    const { host, user } = renderPage(<SettingsPage />);

    await user.click(await screen.findByRole('button', { name: 'Nueva regla' }));
    await user.type(screen.getByLabelText('Nombre'), 'Mis farmacias');
    await user.type(screen.getByLabelText('Valor', { selector: '#condition-value' }), 'FARMACIA');
    await user.type(screen.getByLabelText('Valor', { selector: '#action-value' }), 'salud');
    await user.click(screen.getByRole('button', { name: 'Guardar regla' }));

    // Un nombre que ninguna regla predefinida usa: «Farmacias» ya existe.
    expect(await screen.findByText('Mis farmacias')).toBeInTheDocument();
    const stored = JSON.parse(host.store.data.get(StorageKeys.rules) as string) as {
      v: number;
      rules: Array<{ name: string }>;
    };
    expect(stored.v).toBe(1);
    expect(stored.rules[0]?.name).toBe('Mis farmacias');
  });

  it('cancelar no guarda nada', async () => {
    const { host, user } = renderPage(<SettingsPage />);

    await user.click(await screen.findByRole('button', { name: 'Nueva regla' }));
    await user.type(screen.getByLabelText('Nombre'), 'Farmacias');
    await user.click(screen.getByRole('button', { name: 'Cancelar' }));

    expect(host.store.data.get(StorageKeys.rules)).toBeUndefined();
    expect(screen.queryByLabelText('Editar regla')).toBeNull();
  });

  it('la acción que omite movimientos lo advierte antes de guardarse', async () => {
    const { user } = renderPage(<SettingsPage />);

    await user.click(await screen.findByRole('button', { name: 'Nueva regla' }));
    await user.selectOptions(screen.getByLabelText('Acción'), 'ignore');

    expect(await screen.findByText(/omite movimientos/i)).toBeInTheDocument();
  });

  it('una regla guardada antes se puede editar y eliminar', async () => {
    const { user } = renderPage(<SettingsPage />, {
      storage: {
        [StorageKeys.rules]: JSON.stringify({
          v: 1,
          rules: [
            {
              id: 'user.farmacia',
              name: 'Mis farmacias',
              enabled: true,
              priority: 500,
              match: 'any',
              conditions: [{ field: 'description', operator: 'contains', value: 'FARMACIA' }],
              actions: [{ type: 'set_category', value: 'salud' }],
              origin: 'user',
            },
          ],
        }),
      },
    });

    await screen.findByText('Mis farmacias');
    await user.click(screen.getByRole('button', { name: 'Editar' }));
    expect(await screen.findByText(/Editar «Mis farmacias»/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Cancelar' }));
    await user.click(screen.getByRole('button', { name: 'Eliminar' }));

    expect(screen.queryByText('Mis farmacias')).toBeNull();
  });
});
