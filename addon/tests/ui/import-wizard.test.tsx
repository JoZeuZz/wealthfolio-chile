/** @vitest-environment happy-dom */
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { buildDuplicateIndex } from '../../src/core/dedupe/classify';
import { readChileMetadata, toActivityCreate } from '../../src/core/mapping/activities';
import { prepareImport } from '../../src/core/pipeline';
import { ImportWizardPage } from '../../src/ui/pages/ImportWizardPage';
import { accountStub, activityStub } from '../host';
import { csvFile, renderPage } from './harness';

/**
 * El wizard de importación, desde el DOM.
 *
 * Los tests de servicios prueban que el gate decide bien. Estos prueban lo
 * otro: que la decisión llega a la pantalla. Un `canImport: false` que nadie
 * conecta al botón es exactamente el bug que existía en 0.1.1 con trescientos
 * tests en verde.
 */

const CUENTA = accountStub({
  id: 'acc-1',
  name: 'Cuenta corriente',
  accountNumber: '001234567890',
});

const CARTOLA_BUENA = [
  'Banco de Chile - Cartola Cuenta Corriente',
  'Cuenta Corriente N: 00-123-45678-90',
  '',
  'Fecha;Descripcion;Cargo;Abono;Saldo',
  '2026-02-03;COMPRA SUPERMERCADO;10.000;;90.000',
  '2026-02-04;PAGO SERVICIO LUZ;5.000;;85.000',
].join('\n');

const CARTOLA_ROTA = [
  'Banco de Chile - Cartola Cuenta Corriente',
  'Cuenta Corriente N: 00-123-45678-90',
  '',
  'Fecha;Descripcion;Cargo;Abono;Saldo',
  '2026-02-03;COMPRA SUPERMERCADO;10.000;;90.000',
  '2026-02-04;FILA IMPOSIBLE;5.000;5.000;85.000',
  '2026-02-05;PAGO SERVICIO;5.000;;80.000',
].join('\n');

async function openWizardWith(
  text: string,
  options: Parameters<typeof renderPage>[1] = {},
  name = 'cartola.csv',
) {
  const harness = renderPage(<ImportWizardPage />, {
    accounts: [CUENTA],
    ...options,
  });

  await screen.findByText('Cuenta corriente (CLP)');

  const input = harness.container.querySelector('input[type="file"]');
  await harness.user.upload(input as HTMLInputElement, csvFile(name, text));
  await screen.findByText(/Banco y cuenta detectados/);

  return harness;
}

async function goToPreview(harness: Awaited<ReturnType<typeof openWizardWith>>) {
  await harness.user.click(screen.getByRole('button', { name: /Ver movimientos/ }));
  await screen.findByText(/Resumen de lo que se va a importar/);
}

describe('una cartola que se leyó entera', () => {
  it('llega a la vista previa y deja confirmar', async () => {
    const harness = await openWizardWith(CARTOLA_BUENA);
    await goToPreview(harness);

    const confirmar = screen.getByRole('button', { name: /Confirmar e importar/ });
    expect(confirmar).toBeEnabled();
  });

  it('dice que la cartola corresponde a la cuenta elegida', async () => {
    await openWizardWith(CARTOLA_BUENA);
    expect(screen.getByText(/La cartola corresponde a esta cuenta/)).toBeInTheDocument();
  });

  it('escribe los movimientos y muestra el desglose', async () => {
    const harness = await openWizardWith(CARTOLA_BUENA);
    await goToPreview(harness);

    await harness.user.click(screen.getByRole('button', { name: /Confirmar e importar/ }));
    await screen.findByText(/Creados en Wealthfolio/);

    expect(harness.host.saveManyCalls).toHaveLength(1);
    // Un objeto `{ creates }`, nunca un array pelado: el puente del host
    // interpreta un array como `{ updates }` y crearía cero actividades sin
    // error visible.
    expect(Array.isArray(harness.host.saveManyCalls[0]?.request)).toBe(false);
    expect(harness.host.saveManyCalls[0]?.request.creates).toHaveLength(2);
  });
});

describe('una cartola que no se leyó entera', () => {
  it('no deja confirmar', async () => {
    const harness = await openWizardWith(CARTOLA_ROTA);
    await goToPreview(harness);

    expect(screen.getByRole('button', { name: /Confirmar e importar/ })).toBeDisabled();
  });

  it('explica por qué, con la fila concreta', async () => {
    await openWizardWith(CARTOLA_ROTA);

    const alerta = screen.getByText(/no se puede importar|no se puede importar tal como se leyó/i)
      .closest('div');
    expect(alerta?.textContent).toMatch(/1 de 3 filas no se pudieron leer/);
    expect(alerta?.textContent).toMatch(/Fila 6/);
  });

  it('sigue mostrando lo que sí se leyó', async () => {
    const harness = await openWizardWith(CARTOLA_ROTA);
    await goToPreview(harness);
    expect(screen.getByText('COMPRA SUPERMERCADO')).toBeInTheDocument();
  });

  it('no escribe nada aunque se fuerce el clic', async () => {
    const harness = await openWizardWith(CARTOLA_ROTA);
    await goToPreview(harness);

    await harness.user.click(screen.getByRole('button', { name: /Confirmar e importar/ }));
    expect(harness.host.saveManyCalls).toHaveLength(0);
  });
});

describe('la cuenta de destino', () => {
  it('bloquea una cartola de otra cuenta', async () => {
    const harness = await openWizardWith(CARTOLA_BUENA, {
      accounts: [accountStub({ id: 'acc-1', name: 'Cuenta corriente', accountNumber: '009999999999' })],
    });
    await goToPreview(harness);

    expect(screen.getByRole('button', { name: /Confirmar e importar/ })).toBeDisabled();
    expect(screen.getByText(/La cartola no es de esta cuenta/)).toBeInTheDocument();
  });

  it('avisa cuando no hay con qué comprobarlo, sin bloquear', async () => {
    const harness = await openWizardWith(CARTOLA_BUENA, {
      accounts: [accountStub({ id: 'acc-1', name: 'Cuenta corriente' })],
    });

    expect(
      screen.getByText(/No se pudo confirmar que la cartola sea de esta cuenta/),
    ).toBeInTheDocument();

    await goToPreview(harness);
    expect(screen.getByRole('button', { name: /Confirmar e importar/ })).toBeEnabled();
  });
});

describe('duplicados', () => {
  /**
   * La actividad "ya importada" se construye corriendo el mismo pipeline sobre
   * la misma cartola y mapeando la fila con el mismo `toActivityCreate`.
   *
   * Escribir la huella a mano habría probado que el test y el código coinciden
   * en lo que el test cree; esto prueba que la importación se reconoce a sí
   * misma, que es la promesa real ("reimportar el mismo archivo no duplica").
   */
  function alreadyImported() {
    const prepared = prepareImport({
      file: { name: 'cartola.csv', bytes: new TextEncoder().encode(CARTOLA_BUENA) },
      accountId: 'acc-1',
      rules: [],
      duplicateIndex: buildDuplicateIndex([]),
    });
    const row = prepared.rows[0]!;
    const create = toActivityCreate(row.transaction, {
      accountId: 'acc-1',
      runId: 'run-0',
      weakFingerprint: row.weakFingerprint,
    });
    return {
      activity: activityStub({
        accountId: 'acc-1',
        activityType: 'WITHDRAWAL',
        amount: '10000',
        date: '2026-02-03',
        comment: create.comment as string,
        metadata: readChileMetadata(create.metadata as string) as unknown as Record<string, unknown>,
      }),
    };
  }

  it('marca como duplicado el movimiento que ya está y lo desmarca solo', async () => {
    const harness = await openWizardWith(CARTOLA_BUENA, {
      accounts: [CUENTA],
      activities: [alreadyImported().activity],
    });
    await goToPreview(harness);

    const fila = screen.getByText('COMPRA SUPERMERCADO').closest('tr');
    expect(within(fila as HTMLElement).getByText('Duplicado')).toBeInTheDocument();
    expect(within(fila as HTMLElement).getByRole('checkbox')).not.toBeChecked();
  });

  it('sólo escribe el movimiento nuevo', async () => {
    const harness = await openWizardWith(CARTOLA_BUENA, {
      accounts: [CUENTA],
      activities: [alreadyImported().activity],
    });
    await goToPreview(harness);
    await harness.user.click(screen.getByRole('button', { name: /Confirmar e importar/ }));
    await screen.findByText(/Creados en Wealthfolio/);

    expect(harness.host.saveManyCalls[0]?.request.creates).toHaveLength(1);
  });

  it('explica en texto visible por qué es sólo un posible duplicado', async () => {
    // La razón vivía únicamente en un atributo `title`: invisible en táctil,
    // invisible con teclado, y es la única frase que le dice a alguien que un
    // movimiento puede estar faltando de su contabilidad.
    const { activity } = alreadyImported();
    const harness = await openWizardWith(CARTOLA_BUENA, {
      accounts: [CUENTA],
      activities: [{ ...activity, amount: '99999' }],
    });
    await goToPreview(harness);

    const fila = screen.getByText('COMPRA SUPERMERCADO').closest('tr');
    expect(within(fila as HTMLElement).getByText(/fue editada después en Wealthfolio/)).toBeVisible();
  });

  it('resume el motivo también arriba, donde se decide continuar', async () => {
    const { activity } = alreadyImported();
    const harness = await openWizardWith(CARTOLA_BUENA, {
      accounts: [CUENTA],
      activities: [{ ...activity, amount: '99999' }],
    });
    await goToPreview(harness);

    expect(
      screen.getByText(/1 movimiento\(s\) fueron editados en Wealthfolio/),
    ).toBeInTheDocument();
  });

  it('degrada a posible duplicado cuando la actividad fue editada en Wealthfolio', async () => {
    // La huella describe lo que se importó; si el usuario cambió el monto, ya
    // no describe lo que hay. Saltarlo en silencio perdería el movimiento
    // original sin dejar rastro.
    const { activity } = alreadyImported();
    const harness = await openWizardWith(CARTOLA_BUENA, {
      accounts: [CUENTA],
      activities: [{ ...activity, amount: '99999' }],
    });
    await goToPreview(harness);

    const fila = screen.getByText('COMPRA SUPERMERCADO').closest('tr');
    expect(within(fila as HTMLElement).getByText('Posible duplicado')).toBeInTheDocument();
    expect(within(fila as HTMLElement).getByRole('checkbox')).not.toBeChecked();
  });
});

describe('cuando no se puede comprobar si hay duplicados', () => {
  it('muestra la vista previa pero no deja importar', async () => {
    const harness = renderPage(<ImportWizardPage />, { accounts: [CUENTA] });
    harness.host.searchError = new Error('backend unavailable');

    await screen.findByText('Cuenta corriente (CLP)');
    const input = harness.container.querySelector('input[type="file"]');
    await harness.user.upload(input as HTMLInputElement, csvFile('cartola.csv', CARTOLA_BUENA));
    await screen.findByText(/Banco y cuenta detectados/);
    await goToPreview(harness);

    expect(screen.getByText('COMPRA SUPERMERCADO')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Confirmar e importar/ })).toBeDisabled();
  });
});

describe('selección manual', () => {
  it('desmarcar una fila baja el contador del botón', async () => {
    const harness = await openWizardWith(CARTOLA_BUENA);
    await goToPreview(harness);

    expect(screen.getByRole('button', { name: /Confirmar e importar 2 movimientos/ }));

    const fila = screen.getByText('COMPRA SUPERMERCADO').closest('tr');
    await harness.user.click(within(fila as HTMLElement).getByRole('checkbox'));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Confirmar e importar 1 movimientos/ })),
    );
  });

  it('sin nada marcado no se puede confirmar', async () => {
    const harness = await openWizardWith(CARTOLA_BUENA);
    await goToPreview(harness);

    for (const fila of screen.getAllByRole('checkbox')) {
      await harness.user.click(fila);
    }

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Confirmar e importar/ })).toBeDisabled(),
    );
  });
});

describe('una importación parcial', () => {
  it('no la presenta como completa', async () => {
    // El host acepta un lote y rechaza el siguiente. El dinero que sí entró
    // está en la contabilidad, y el que no, no: decir «listo» sobre eso es cómo
    // alguien deja de revisar.
    const harness = await openWizardWith(CARTOLA_BUENA);
    harness.host.saveManyPlan = [1];
    await goToPreview(harness);

    await harness.user.click(screen.getByRole('button', { name: /Confirmar e importar/ }));
    await screen.findByText(/Creados en Wealthfolio/);

    expect(harness.host.toasts.some((toast) => toast.level === 'success')).toBe(false);
    expect(screen.getByText(/Fallaron al escribir/)).toBeInTheDocument();
  });

  it('dice cuántos entraron y cuántos no', async () => {
    const harness = await openWizardWith(CARTOLA_BUENA);
    harness.host.saveManyPlan = [1];
    await goToPreview(harness);

    await harness.user.click(screen.getByRole('button', { name: /Confirmar e importar/ }));
    const created = await screen.findByText(/Creados en Wealthfolio/);
    const failed = screen.getByText(/Fallaron al escribir/);

    expect(created.parentElement?.textContent).toContain('1');
    expect(failed.parentElement?.textContent).toContain('1');
  });
});

describe('una cartola con fechas ambiguas', () => {
  it('no marca cada fila como pendiente de revisión', async () => {
    // `03/09/2026` admite dos lecturas y antes cada fila así llevaba una
    // advertencia: en una cartola real, la mitad.
    const harness = await openWizardWith(
      [
        'Banco de Chile - Cartola Cuenta Corriente',
        'Cuenta Corriente N: 00-123-45678-90',
        '',
        'Fecha;Descripcion;Cargo;Abono;Saldo',
        '03/09/2026;COMPRA UNO;10.000;;90.000',
        '04/09/2026;COMPRA DOS;5.000;;85.000',
        '25/09/2026;COMPRA TRES;5.000;;80.000',
      ].join('\n'),
    );
    await goToPreview(harness);

    expect(screen.queryByText('Revisar')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Confirmar e importar 3 movimientos/ })).toBeEnabled();
  });
});

describe('una importación que falla', () => {
  it('no dice que salió bien', async () => {
    const harness = await openWizardWith(CARTOLA_BUENA);
    harness.host.saveManyPlan = [new Error('el host rechazó el lote')];
    await goToPreview(harness);

    await harness.user.click(screen.getByRole('button', { name: /Confirmar e importar/ }));
    await screen.findByText(/Creados en Wealthfolio/);

    expect(harness.host.toasts.some((toast) => toast.level === 'success')).toBe(false);
  });
});
