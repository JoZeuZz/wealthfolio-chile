/** @vitest-environment happy-dom */
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
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

function activity(input: {
  accountId: string;
  amount: number;
  date: string;
  description: string;
  kind: TransactionKind;
  type: string;
  currency?: string;
  scale?: number;
}) {
  const base = makeTransaction({
    amount: input.amount,
    date: input.date,
    description: input.description,
    kind: input.kind,
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
