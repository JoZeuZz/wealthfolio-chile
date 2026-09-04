/** @vitest-environment happy-dom */
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { readChileMetadata, toActivityCreate } from '../../src/core/mapping/activities';
import { TransactionKind } from '../../src/core/model/kinds';
import { ReconciliationPage } from '../../src/ui/pages/ReconciliationPage';
import { makeTransaction } from '../fixtures';
import { accountStub, activityStub } from '../host';
import { renderPage } from './harness';

/**
 * La pantalla de conciliación.
 *
 * Lo que tiene que quedar claro al mirarla: qué se dio por seguro, qué es sólo
 * una sugerencia, y qué el motor se negó a decidir. Presentar las tres cosas
 * igual sería peor que no mostrarlas.
 */

/**
 * Dates inside the window the page opens on.
 *
 * The review covers the three months ending in the current one, so fixtures
 * pinned to a fixed month fall outside it the moment the calendar moves.
 */
const TODAY = new Date();
const DAY = (offset: number) => {
  const date = new Date(Date.UTC(TODAY.getUTCFullYear(), TODAY.getUTCMonth(), 10 + offset));
  return date.toISOString().slice(0, 10);
};

const CUENTA = accountStub({ id: 'acc-a', name: 'Banco de Chile' });
const OTRA = accountStub({ id: 'acc-b', name: 'BancoEstado' });

/** An activity as this addon would have written it, so metadata round-trips. */
function leg(input: {
  accountId: string;
  amount: number;
  date: string;
  description: string;
  type: 'TRANSFER_OUT' | 'TRANSFER_IN';
}) {
  const create = toActivityCreate(
    makeTransaction({
      amount: input.amount,
      date: input.date,
      description: input.description,
      kind: TransactionKind.expense,
    }),
    { accountId: input.accountId, runId: 'run-1' },
  );

  return activityStub({
    accountId: input.accountId,
    activityType: input.type,
    amount: String(Math.abs(input.amount)),
    date: input.date,
    comment: create.comment as string,
    metadata: readChileMetadata(create.metadata as string) as unknown as Record<string, unknown>,
  });
}

const CLARO = [
  leg({
    accountId: 'acc-a',
    amount: -200000,
    date: DAY(0),
    description: 'TRASPASO A CUENTA PROPIA BANCOESTADO',
    type: 'TRANSFER_OUT',
  }),
  leg({
    accountId: 'acc-b',
    amount: 200000,
    date: DAY(0),
    description: 'TRASPASO DESDE CUENTA PROPIA',
    type: 'TRANSFER_IN',
  }),
];

const AMBIGUO = [
  leg({
    accountId: 'acc-a',
    amount: -100000,
    date: DAY(2),
    description: 'TRASPASO A CUENTA PROPIA',
    type: 'TRANSFER_OUT',
  }),
  leg({
    accountId: 'acc-a',
    amount: -100000,
    date: DAY(2),
    description: 'TRASPASO A CUENTA PROPIA',
    type: 'TRANSFER_OUT',
  }),
  leg({
    accountId: 'acc-b',
    amount: 100000,
    date: DAY(2),
    description: 'TRASPASO DESDE CUENTA PROPIA',
    type: 'TRANSFER_IN',
  }),
  leg({
    accountId: 'acc-b',
    amount: 100000,
    date: DAY(2),
    description: 'TRASPASO DESDE CUENTA PROPIA',
    type: 'TRANSFER_IN',
  }),
];

function open(activities: ReturnType<typeof leg>[]) {
  return renderPage(<ReconciliationPage />, {
    accounts: [CUENTA, OTRA],
    activities,
  });
}

describe('un par claro', () => {
  it('aparece como confirmado, con las dos cuentas por su nombre', async () => {
    const harness = open(CLARO);
    await screen.findByText(/Pares confirmados \(1\)/);

    expect(within(harness.container).getByText('Banco de Chile')).toBeInTheDocument();
    expect(within(harness.container).getByText('BancoEstado')).toBeInTheDocument();
  });

  it('dice por qué se dio por seguro', async () => {
    open(CLARO);
    await screen.findByText(/Pares confirmados \(1\)/);
    expect(screen.getByText(/mismo monto en cuentas distintas/)).toBeInTheDocument();
  });
});

describe('un grupo indistinguible', () => {
  it('no se presenta como un par', async () => {
    open(AMBIGUO);
    await screen.findByText(/Sin decidir \(1\)/);
    expect(screen.getByText(/Pares confirmados \(0\)/)).toBeInTheDocument();
    expect(screen.getByText(/Pares sugeridos \(0\)/)).toBeInTheDocument();
  });

  it('muestra los cuatro movimientos del nudo', async () => {
    open(AMBIGUO);
    await screen.findByText(/Sin decidir \(1\)/);
    // El nudo es lo único que renderiza una lista, así que los elementos de
    // lista de la página son exactamente sus tramos.
    expect(screen.getAllByRole('listitem')).toHaveLength(4);
  });

  it('explica que no hay con qué decidir', async () => {
    open(AMBIGUO);
    await screen.findByText(/Sin decidir \(1\)/);
    expect(screen.getByText(/nada en los datos permite decidir/)).toBeInTheDocument();
  });
});

describe('la pantalla es de sólo lectura', () => {
  it('lo dice antes de mostrar nada', async () => {
    open(CLARO);
    expect(screen.getByText(/Esta pantalla no cambia nada/)).toBeInTheDocument();
    await screen.findByText(/Pares confirmados/);
  });

  it('no escribe en el host', async () => {
    const harness = open(CLARO);
    await screen.findByText(/Pares confirmados/);
    expect(harness.host.saveManyCalls).toHaveLength(0);
  });
});

describe('sin nada que conciliar', () => {
  it('lo dice en cada sección en vez de dejarlas en blanco', async () => {
    open([]);
    await screen.findByText(/Pares confirmados \(0\)/);
    expect(screen.getByText(/Ningún par tiene evidencia suficiente/)).toBeInTheDocument();
    expect(screen.getByText(/No quedó ningún grupo ambiguo/)).toBeInTheDocument();
  });
});

/**
 * No se puede conciliar el mes que viene.
 *
 * La ventana avanzaba sin tope, así que un par de clics dejaban al usuario
 * mirando meses vacíos. En esta pantalla eso es peor que inútil: una ventana
 * sin candidatos y una ventana sin datos se ven exactamente igual, así que
 * navegar al futuro parecía decir «no hay transferencias que conciliar».
 */
describe('tope de navegación', () => {
  it('el botón de meses siguientes está deshabilitado en el mes actual', async () => {
    renderPage(<ReconciliationPage />);

    const next = await screen.findByRole('button', { name: 'Ver los meses siguientes' });
    expect(next).toBeDisabled();
  });

  it('y se habilita al retroceder', async () => {
    const { user } = renderPage(<ReconciliationPage />);

    await user.click(await screen.findByRole('button', { name: 'Ver los meses anteriores' }));

    expect(screen.getByRole('button', { name: 'Ver los meses siguientes' })).toBeEnabled();
  });
});
