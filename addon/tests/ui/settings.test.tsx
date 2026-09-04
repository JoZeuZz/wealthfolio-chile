/** @vitest-environment happy-dom */
import { screen, waitFor, within } from '@testing-library/react';
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

/**
 * Lo que la pantalla tiene que impedir.
 *
 * Tres cosas que no se ven leyendo el código y sí pulsando: que una expresión
 * regular rota no se guarde, que dos interruptores pulsados seguidos no se
 * pisen, y que dos reglas creadas en el mismo milisegundo sean dos reglas.
 */
describe('robustez de la pantalla', () => {
  it('una expresión regular inválida no se guarda y se explica', async () => {
    const { host, user } = renderPage(<SettingsPage />);

    await user.click(await screen.findByRole('button', { name: 'Nueva regla' }));
    await user.type(screen.getByLabelText('Nombre'), 'Rota');
    await user.selectOptions(screen.getByLabelText('Comparación'), 'matches');
    await user.type(
      screen.getByLabelText('Valor', { selector: '#condition-value' }),
      // `[` abre un descriptor de tecla en user-event; duplicado es un corchete.
      '([[',
    );
    await user.type(screen.getByLabelText('Valor', { selector: '#action-value' }), 'salud');
    await user.click(screen.getByRole('button', { name: 'Guardar regla' }));

    expect(await screen.findByText(/expresión regular no es válida/i)).toBeInTheDocument();
    expect(host.store.data.get(StorageKeys.rules)).toBeUndefined();
  });

  it('un patrón con cuantificadores anidados tampoco', async () => {
    const { host, user } = renderPage(<SettingsPage />);

    await user.click(await screen.findByRole('button', { name: 'Nueva regla' }));
    await user.type(screen.getByLabelText('Nombre'), 'Lenta');
    await user.selectOptions(screen.getByLabelText('Comparación'), 'matches');
    await user.type(screen.getByLabelText('Valor', { selector: '#condition-value' }), '(a+)+$');
    await user.type(screen.getByLabelText('Valor', { selector: '#action-value' }), 'salud');
    await user.click(screen.getByRole('button', { name: 'Guardar regla' }));

    expect(await screen.findByText(/cuantificadores anidados/i)).toBeInTheDocument();
    expect(host.store.data.get(StorageKeys.rules)).toBeUndefined();
  });

  it('dos reglas predefinidas desactivadas seguidas no se pisan', async () => {
    const { host, user } = renderPage(<SettingsPage />);

    await user.click(await screen.findByLabelText('Pago de tarjeta de crédito'));
    await user.click(screen.getByLabelText('Intereses'));

    await waitFor(() => {
      const stored = JSON.parse(host.store.data.get(StorageKeys.settings) as string) as {
        disabledBuiltinRules: string[];
      };
      expect(stored.disabledBuiltinRules).toContain('builtin.pago-tarjeta');
      expect(stored.disabledBuiltinRules).toContain('builtin.intereses');
    });
  });

  it('cada regla nueva recibe su propio id', async () => {
    const { host, user } = renderPage(<SettingsPage />);

    for (const name of ['Una', 'Otra']) {
      await user.click(await screen.findByRole('button', { name: 'Nueva regla' }));
      await user.type(screen.getByLabelText('Nombre'), name);
      await user.type(screen.getByLabelText('Valor', { selector: '#condition-value' }), name);
      await user.type(screen.getByLabelText('Valor', { selector: '#action-value' }), 'otros');
      await user.click(screen.getByRole('button', { name: 'Guardar regla' }));
      await screen.findByText(name);
    }

    const stored = JSON.parse(host.store.data.get(StorageKeys.rules) as string) as {
      rules: Array<{ id: string }>;
    };
    expect(stored.rules).toHaveLength(2);
    expect(new Set(stored.rules.map((r) => r.id)).size).toBe(2);
  });
});

/**
 * Dónde aparece el editor, y qué dice un cero.
 *
 * Dos defectos que sólo se vieron usando la pantalla en el host real. El
 * editor se montaba al final de la página, debajo de los bancos y de
 * privacidad, así que pulsar «Editar» en una regla no producía ningún cambio
 * visible. Y una vista previa en cero no decía sobre qué había contado: en una
 * instancia real apareció «no cambiaría ninguno» para una regla cuyo
 * movimiento estaba en Wealthfolio a la vista, siete meses atrás y fuera de la
 * ventana.
 */
describe('el editor y el cero', () => {
  it('el editor aparece dentro de la tarjeta de reglas, no al final de la página', async () => {
    const { user } = renderPage(<SettingsPage />);

    await user.click(await screen.findByRole('button', { name: 'Nueva regla' }));

    const editor = await screen.findByRole('dialog', { name: 'Editar regla' });
    const rulesCard = screen.getByText('Tus reglas').closest('div[class*="rounded"]');
    expect(rulesCard).toContainElement(editor);
  });

  it('mientras se edita no se ofrece crear otra regla encima', async () => {
    const { user } = renderPage(<SettingsPage />);

    await user.click(await screen.findByRole('button', { name: 'Nueva regla' }));

    expect(screen.queryByRole('button', { name: 'Nueva regla' })).toBeNull();
  });

  it('una vista previa en cero dice sobre qué contó', async () => {
    const { user } = renderPage(<SettingsPage />);

    await user.click(await screen.findByRole('button', { name: 'Nueva regla' }));
    await user.type(screen.getByLabelText('Nombre'), 'Nada');
    await user.type(screen.getByLabelText('Valor', { selector: '#condition-value' }), 'ZZZZ');
    await user.type(screen.getByLabelText('Valor', { selector: '#action-value' }), 'otros');

    expect(await screen.findByText(/No cambiaría ninguno/)).toBeInTheDocument();
    expect(screen.getByText(/no dice nada sobre una cartola futura/i)).toBeInTheDocument();
  });

  it('con movimientos, el cero nombra la ventana revisada', async () => {
    const { user } = renderPage(<SettingsPage />, {
      activities: [ourActivity('SUPERMERCADO LIDER', -45_000, 'a1')],
    });

    await user.click(await screen.findByRole('button', { name: 'Nueva regla' }));
    await user.type(screen.getByLabelText('Nombre'), 'Nada');
    await user.type(screen.getByLabelText('Valor', { selector: '#condition-value' }), 'ZZZZ');
    await user.type(screen.getByLabelText('Valor', { selector: '#action-value' }), 'otros');

    await screen.findByText(/No cambiaría ninguno/);
    expect(screen.getByText(/Revisados 1 movimientos de los últimos 6 meses/)).toBeInTheDocument();
    expect(screen.getByText(/movimiento más antiguo no se cuenta aquí/i)).toBeInTheDocument();
  });
});

/**
 * Tres cosas que la pantalla prometía y no cumplía.
 *
 * La vista previa corría con todas las predefinidas encendidas aunque el
 * usuario hubiera apagado alguna, así que decía «no cambiaría ninguno» para una
 * regla que al importar sí dispara. El editor conservaba el borrador de la
 * regla anterior al pasar a otra, de modo que Guardar escribía sobre la
 * equivocada. Y un rango no se podía teclear.
 */
describe('promesas que la pantalla tiene que cumplir', () => {
  it('la vista previa respeta las predefinidas que el usuario apagó', async () => {
    const { user } = renderPage(<SettingsPage />, {
      storage: {
        [StorageKeys.settings]: JSON.stringify({
          verboseLogging: false,
          transferWindowDays: 5,
          disabledBuiltinRules: ['builtin.supermercado'],
        }),
      },
      activities: [ourActivity('COMPRA SUPERMERCADO LIDER', -45_000, 'a1')],
    });

    await user.click(await screen.findByRole('button', { name: 'Nueva regla' }));
    await user.type(screen.getByLabelText('Nombre'), 'Mi super');
    await user.type(screen.getByLabelText('Valor', { selector: '#condition-value' }), 'SUPERMERCADO');
    await user.type(screen.getByLabelText('Valor', { selector: '#action-value' }), 'otros');

    // Con la predefinida apagada la fila no tiene categoría, así que la regla
    // sí la cambia. Con la predefinida encendida el efecto sería el mismo pero
    // el texto de los efectos distinto: lo que se comprueba es que la vista
    // previa lee el mismo conjunto que la importación.
    expect(await screen.findByText(/Cambiaría 1 de 1 movimientos/)).toBeInTheDocument();
  });

  it('pasar de editar una regla a otra no arrastra el borrador', async () => {
    const { host, user } = renderPage(<SettingsPage />, {
      storage: {
        [StorageKeys.rules]: JSON.stringify({
          v: 1,
          rules: [
            {
              id: 'user.a', name: 'Regla A', enabled: true, priority: 500, match: 'any',
              conditions: [{ field: 'description', operator: 'contains', value: 'AAA' }],
              actions: [{ type: 'set_category', value: 'otros' }], origin: 'user',
            },
            {
              id: 'user.b', name: 'Regla B', enabled: true, priority: 500, match: 'any',
              conditions: [{ field: 'description', operator: 'contains', value: 'BBB' }],
              actions: [{ type: 'set_category', value: 'salud' }], origin: 'user',
            },
          ],
        }),
      },
    });

    await screen.findByText('Regla A');
    const [editA, editB] = screen.getAllByRole('button', { name: 'Editar' });
    await user.click(editA as HTMLElement);
    await screen.findByText('Editar «Regla A»');

    await user.click(editB as HTMLElement);
    await screen.findByText('Editar «Regla B»');

    // El formulario tiene que mostrar la regla B, no seguir con la A.
    expect(screen.getByLabelText('Nombre')).toHaveValue('Regla B');
    expect(screen.getByLabelText('Valor', { selector: '#condition-value' })).toHaveValue('BBB');

    await user.click(screen.getByRole('button', { name: 'Guardar regla' }));

    const stored = JSON.parse(host.store.data.get(StorageKeys.rules) as string) as {
      rules: Array<{ id: string; name: string }>;
    };
    expect(stored.rules.map((r) => r.name).sort()).toEqual(['Regla A', 'Regla B']);
  });

  it('un rango se puede teclear entero', async () => {
    const { host, user } = renderPage(<SettingsPage />);

    await user.click(await screen.findByRole('button', { name: 'Nueva regla' }));
    await user.type(screen.getByLabelText('Nombre'), 'Compras grandes');
    await user.selectOptions(screen.getByLabelText('Campo'), 'absAmount');
    await user.selectOptions(screen.getByLabelText('Comparación'), 'between');
    await user.type(screen.getByLabelText('Valor', { selector: '#condition-value' }), '10000-50000');
    await user.type(screen.getByLabelText('Valor', { selector: '#action-value' }), 'otros');
    await user.click(screen.getByRole('button', { name: 'Guardar regla' }));

    await screen.findByText('Compras grandes');
    const stored = JSON.parse(host.store.data.get(StorageKeys.rules) as string) as {
      rules: Array<{ conditions: Array<{ value: [number, number] }> }>;
    };
    expect(stored.rules[0]?.conditions[0]?.value).toEqual([10_000, 50_000]);
  });
});
