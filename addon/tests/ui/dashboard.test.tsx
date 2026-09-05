/** @vitest-environment happy-dom */
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { formatMonthKey } from '../../src/core/dates';
import { readChileMetadata, toActivityCreate } from '../../src/core/mapping/activities';
import { money } from '../../src/core/money';
import { TransactionKind } from '../../src/core/model/kinds';
import { DashboardPage } from '../../src/ui/pages/DashboardPage';
import { makeTransaction } from '../fixtures';
import { accountStub, activityStub } from '../host';
import { renderPage } from './harness';

/**
 * El panel.
 *
 * Dos cosas que sólo se ven aquí: que caja y gasto se presentan como preguntas
 * distintas, y que dos monedas en el mismo mes no se suman. La segunda antes
 * dejaba el panel entero en un mensaje de error, así que quien tenía una cuenta
 * en dólares tampoco veía sus totales en pesos.
 */

const TODAY = new Date();
const DAY = (offset: number) =>
  new Date(Date.UTC(TODAY.getUTCFullYear(), TODAY.getUTCMonth(), 5 + offset))
    .toISOString()
    .slice(0, 10);
/** The same day, `months` months back. */
const MONTHS_AGO = (months: number, offset = 0) =>
  new Date(Date.UTC(TODAY.getUTCFullYear(), TODAY.getUTCMonth() - months, 5 + offset))
    .toISOString()
    .slice(0, 10);
/** The same day of the month before, for the comparison tests. */
const PREVIOUS_DAY = (offset: number) => MONTHS_AGO(1, offset);
const PREVIOUS_LABEL = formatMonthKey(PREVIOUS_DAY(0).slice(0, 7));

function activity(input: {
  accountId: string;
  amount: number;
  date: string;
  description: string;
  kind: TransactionKind;
  type: string;
  currency?: string;
  scale?: number;
  merchant?: string;
}) {
  const base = makeTransaction({
    amount: input.amount,
    date: input.date,
    description: input.description,
    kind: input.kind,
    ...(input.merchant !== undefined ? { merchant: input.merchant } : {}),
  });
  const transaction = {
    ...base,
    amount: money(input.amount, input.scale ?? 0, input.currency ?? 'CLP'),
  };
  const create = toActivityCreate(transaction, { accountId: input.accountId, runId: 'run-1' });

  return activityStub({
    accountId: input.accountId,
    activityType: input.type,
    ...(input.kind === TransactionKind.refund ? { subtype: 'REFUND' } : {}),
    amount: String(Math.abs(input.amount)),
    currency: input.currency ?? 'CLP',
    date: input.date,
    comment: create.comment as string,
    metadata: readChileMetadata(create.metadata as string) as unknown as Record<string, unknown>,
  });
}

const CLP = accountStub({ id: 'acc-clp', name: 'Cuenta CLP' });
const USD = accountStub({ id: 'acc-usd', name: 'Cuenta USD', currency: 'USD' });

describe('caja y gasto son preguntas distintas', () => {
  it('una devolución reduce el gasto y no cuenta como ingreso', async () => {
    renderPage(<DashboardPage />, {
      accounts: [CLP],
      activities: [
        activity({
          accountId: 'acc-clp',
          amount: -100000,
          date: DAY(0),
          description: 'COMPRA TIENDA',
          kind: TransactionKind.expense,
          type: 'WITHDRAWAL',
        }),
        activity({
          accountId: 'acc-clp',
          amount: 20000,
          date: DAY(1),
          description: 'DEVOLUCION TIENDA',
          kind: TransactionKind.refund,
          type: 'CREDIT',
        }),
      ],
    });

    await screen.findByText('Gasto neto');
    // El bruto del que sale el neto, dicho en la misma tarjeta.
    expect(screen.getByText('$100.000 menos $20.000 devueltos')).toBeInTheDocument();
    expect(screen.getByText('Gasto neto').parentElement?.textContent).toContain('$80.000');
    // Una devolución no es dinero nuevo que entra.
    expect(screen.getByText('Ingresos del mes').parentElement?.textContent).toContain('$0');
  });
});

describe('dos monedas en el mismo mes', () => {
  it('las muestra por separado en vez de no mostrar nada', async () => {
    renderPage(<DashboardPage />, {
      accounts: [CLP, USD],
      activities: [
        activity({
          accountId: 'acc-clp',
          amount: -50000,
          date: DAY(0),
          description: 'COMPRA CLP',
          kind: TransactionKind.expense,
          type: 'WITHDRAWAL',
        }),
        activity({
          accountId: 'acc-usd',
          amount: -1000,
          date: DAY(1),
          description: 'COMPRA USD',
          kind: TransactionKind.expense,
          type: 'WITHDRAWAL',
          currency: 'USD',
          scale: 2,
        }),
      ],
    });

    expect(await screen.findByText(/Este mes tiene movimientos en 2 monedas/)).toBeInTheDocument();
    expect(screen.getByText(/Movimientos en USD/)).toBeInTheDocument();
  });

  it('explica por qué no las suma', async () => {
    renderPage(<DashboardPage />, {
      accounts: [CLP, USD],
      activities: [
        activity({
          accountId: 'acc-clp',
          amount: -50000,
          date: DAY(0),
          description: 'COMPRA CLP',
          kind: TransactionKind.expense,
          type: 'WITHDRAWAL',
        }),
        activity({
          accountId: 'acc-usd',
          amount: -1000,
          date: DAY(1),
          description: 'COMPRA USD',
          kind: TransactionKind.expense,
          type: 'WITHDRAWAL',
          currency: 'USD',
          scale: 2,
        }),
      ],
    });

    await screen.findByText(/Este mes tiene movimientos en 2 monedas/);
    expect(screen.getByText(/tipo de cambio del día de cada movimiento/)).toBeInTheDocument();
  });
});


/**
 * La comparación con el mes anterior.
 *
 * Lo que se prueba aquí no es el porcentaje —eso vive en
 * `tests/comparison.test.ts`— sino que la pantalla no llegue a mostrar uno
 * cuando no existe: sin mes anterior, y con un flujo que cambia de signo.
 */
describe('comparación con el mes anterior', () => {
  it('dice cuánto subió el gasto neto y contra qué mes', async () => {
    renderPage(<DashboardPage />, {
      accounts: [CLP],
      activities: [
        activity({
          accountId: 'acc-clp',
          amount: -100000,
          date: PREVIOUS_DAY(0),
          description: 'COMPRA TIENDA',
          kind: TransactionKind.expense,
          type: 'WITHDRAWAL',
        }),
        activity({
          accountId: 'acc-clp',
          amount: -200000,
          date: DAY(0),
          description: 'COMPRA TIENDA',
          kind: TransactionKind.expense,
          type: 'WITHDRAWAL',
        }),
      ],
    });

    await screen.findByText('Gasto neto');
    expect(screen.getByText(`100 % más que en ${PREVIOUS_LABEL}`)).toBeInTheDocument();
  });

  it('sin mes anterior no inventa un porcentaje', async () => {
    renderPage(<DashboardPage />, {
      accounts: [CLP],
      activities: [
        activity({
          accountId: 'acc-clp',
          amount: -200000,
          date: DAY(0),
          description: 'COMPRA TIENDA',
          kind: TransactionKind.expense,
          type: 'WITHDRAWAL',
        }),
      ],
    });

    await screen.findByText('Gasto neto');
    expect(screen.getAllByText('Sin base comparable').length).toBeGreaterThan(0);
    expect(screen.queryByText(/% más que/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Infinity/)).not.toBeInTheDocument();
  });

  it('un flujo de caja que cambia de signo se dice con montos, no con un porcentaje', async () => {
    renderPage(<DashboardPage />, {
      accounts: [CLP],
      activities: [
        activity({
          accountId: 'acc-clp',
          amount: 60000,
          date: PREVIOUS_DAY(0),
          description: 'SUELDO',
          kind: TransactionKind.income,
          type: 'DEPOSIT',
        }),
        activity({
          accountId: 'acc-clp',
          amount: -100000,
          date: PREVIOUS_DAY(1),
          description: 'COMPRA TIENDA',
          kind: TransactionKind.expense,
          type: 'WITHDRAWAL',
        }),
        activity({
          accountId: 'acc-clp',
          amount: 300000,
          date: DAY(0),
          description: 'SUELDO',
          kind: TransactionKind.income,
          type: 'DEPOSIT',
        }),
        activity({
          accountId: 'acc-clp',
          amount: -120000,
          date: DAY(1),
          description: 'COMPRA TIENDA',
          kind: TransactionKind.expense,
          type: 'WITHDRAWAL',
        }),
      ],
    });

    await screen.findByText('Flujo de caja');
    expect(
      screen.getByText(`-$40.000 en ${PREVIOUS_LABEL}`),
    ).toBeInTheDocument();
  });
});


describe('gastos que se repiten', () => {
  it('muestra la evidencia y marca el mandato que declaró el banco', async () => {
    renderPage(<DashboardPage />, {
      accounts: [CLP],
      activities: [2, 1, 0].map((months) =>
        activity({
          accountId: 'acc-clp',
          amount: -32000,
          date: MONTHS_AGO(months),
          description: 'PAC AGUAS ANDINAS',
          merchant: 'Aguas Andinas',
          kind: TransactionKind.expense,
          type: 'WITHDRAWAL',
        }),
      ),
    });

    await screen.findByText('Gastos que se repiten');
    expect(screen.getByText('PAC')).toBeInTheDocument();
    expect(screen.getByText(/3 cargos · cada/)).toBeInTheDocument();
  });

  it('una compra en cuotas no aparece como gasto recurrente', async () => {
    renderPage(<DashboardPage />, {
      accounts: [CLP],
      activities: [2, 1, 0].map((months, index) =>
        activity({
          accountId: 'acc-clp',
          amount: -39990,
          date: MONTHS_AGO(months),
          description: `FALABELLA CUOTA ${index + 1} DE 6`,
          merchant: 'Falabella',
          kind: TransactionKind.expense,
          type: 'WITHDRAWAL',
        }),
      ),
    });

    await screen.findByText('Gastos por categoría');
    expect(screen.queryByText('Gastos que se repiten')).not.toBeInTheDocument();
  });

  it('no presenta como vigente un patrón que terminó hace meses', async () => {
    renderPage(<DashboardPage />, {
      accounts: [CLP],
      activities: [
        ...[10, 9, 8].map((months) =>
          activity({
            accountId: 'acc-clp',
            amount: -9900,
            date: MONTHS_AGO(months),
            description: 'PAC SERVICIO ANTIGUO',
            merchant: 'Servicio antiguo',
            kind: TransactionKind.expense,
            type: 'WITHDRAWAL',
          }),
        ),
        activity({
          accountId: 'acc-clp',
          amount: -15000,
          date: DAY(0),
          description: 'COMPRA ACTUAL',
          merchant: 'Comercio actual',
          kind: TransactionKind.expense,
          type: 'WITHDRAWAL',
        }),
      ],
    });

    await screen.findByText('Gastos por categoría');
    expect(screen.queryByText('Gastos que se repiten')).not.toBeInTheDocument();
  });
});

/**
 * Lo que el panel afirma sobre sí mismo.
 *
 * Tres afirmaciones que el panel hacía y que sus propios datos contradecían en
 * la misma pantalla.
 */
describe('el panel y lo que dice de sí mismo', () => {
  const RUN = {
    id: 'run-vieja',
    timestamp: '2026-03-01T12:00:00.000Z',
    fileName: 'cartola.csv',
    fileHash: 'hash',
    institution: 'banco-chile',
    parser: 'banco-chile.cuenta-corriente',
    parserVersion: '1.0.0',
    profileStatus: 'pending-real-sample',
    accountId: 'acc-clp',
    accountName: 'Cuenta CLP',
    currency: 'CLP',
    importedRows: 12,
  };
  const HISTORY = {
    'wfcl.imports.index': JSON.stringify({ v: 1, shards: 1, perShard: 50, lastShardLength: 1 }),
    'wfcl.imports.s0': JSON.stringify([RUN]),
  };

  it('un mes sin movimientos no es «todavía no has importado nada»', async () => {
    renderPage(<DashboardPage />, {
      accounts: [CLP],
      activities: [],
      storage: HISTORY,
    });

    // La tarjeta de estrena aparecía junto a un historial con importaciones
    // dentro de la misma pantalla: el panel se contradecía a sí mismo.
    expect(await screen.findByText('Últimas importaciones')).toBeInTheDocument();
    expect(screen.queryByText('Todavía no hay movimientos importados')).not.toBeInTheDocument();
    expect(screen.queryByText('Importar mi primera cartola')).not.toBeInTheDocument();
  });

  it('sin ninguna importación sí ofrece la primera', async () => {
    renderPage(<DashboardPage />, { accounts: [CLP], activities: [] });

    expect(await screen.findByText('Todavía no hay movimientos importados')).toBeInTheDocument();
  });

  it('los gastos fijos y variables no viven bajo «movimientos que no son gasto»', async () => {
    renderPage(<DashboardPage />, {
      accounts: [CLP],
      activities: [
        activity({
          accountId: 'acc-clp',
          amount: -50000,
          date: DAY(0),
          description: 'COMPRA TIENDA',
          merchant: 'Tienda',
          kind: TransactionKind.expense,
          type: 'WITHDRAWAL',
        }),
      ],
    });

    const title = await screen.findByText('Movimientos que no son gasto');
    const card = title.parentElement?.parentElement;
    expect(card?.className).toContain('bg-card');
    expect(card?.textContent).not.toContain('Gastos fijos');
    expect(card?.textContent).not.toContain('Gastos variables');
    // Siguen estando en el panel, con un título que no los desmiente.
    expect(screen.getByText('Gastos fijos')).toBeInTheDocument();
  });

  it('el gasto sin comercio se informa aparte, no como un comercio', async () => {
    renderPage(<DashboardPage />, {
      accounts: [CLP],
      activities: [
        activity({
          accountId: 'acc-clp',
          amount: -500000,
          date: DAY(0),
          description: 'GIRO CAJERO AUTOMATICO',
          kind: TransactionKind.expense,
          type: 'WITHDRAWAL',
        }),
        activity({
          accountId: 'acc-clp',
          amount: -30000,
          date: DAY(1),
          description: 'SUPERMERCADO LIDER',
          merchant: 'Lider',
          kind: TransactionKind.expense,
          type: 'WITHDRAWAL',
        }),
      ],
    });

    await screen.findByText('Comercios principales');
    expect(screen.queryByText('Sin comercio')).not.toBeInTheDocument();
    expect(screen.getByText(/sin comercio identificado/i)).toBeInTheDocument();
  });

  it('la evidencia de una recurrencia se lee antes que el resumen que la cita', async () => {
    renderPage(<DashboardPage />, {
      accounts: [CLP],
      activities: [0, 1, 2, 3].map((months) =>
        activity({
          accountId: 'acc-clp',
          amount: -9900,
          date: MONTHS_AGO(months),
          description: 'PAC SERVICIO SINTETICO',
          merchant: 'Servicio sintetico',
          kind: TransactionKind.expense,
          type: 'WITHDRAWAL',
        }),
      ),
    });

    const recurring = await screen.findByText('Gastos que se repiten');
    const observations = screen.getByText('Observaciones');
    expect(
      recurring.compareDocumentPosition(observations) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});
