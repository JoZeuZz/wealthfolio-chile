import { describe, expect, it } from 'vitest';
import { loadImportedTransactions } from '../src/services/imported-transactions';
import { TransactionKind } from '../src/core/model/kinds';
import { activityStub, fakeHost } from './host';

/**
 * La cola, leída del host.
 *
 * El panel reconstruye los movimientos desde las actividades que Wealthfolio
 * guarda, así que la cola se arma en el mismo viaje: no hay una segunda
 * consulta ni un índice propio que pueda quedar desfasado del ledger.
 */
const ctx = (activities: ReturnType<typeof activityStub>[]) => fakeHost({ activities }).ctx;

const base = {
  v: 4,
  fp: 'fp-1',
  inst: 'banco-chile',
  parser: 'p',
  parserVersion: '1',
  fileHash: 'h',
  runId: 'r',
};

describe('lo que el panel puede decir que falta revisar', () => {
  it('junta las filas que el host sigue marcando', async () => {
    const loaded = await loadImportedTransactions(
      ctx([
        activityStub({
          activityType: 'UNKNOWN',
          amount: '45000',
          date: '2026-09-10',
          comment: 'MOVIMIENTO SIN CLASIFICAR',
          needsReview: true,
          status: 'DRAFT',
          metadata: { ...base, kind: TransactionKind.unknown, dir: 'out' },
        }),
        activityStub({
          activityType: 'FEE',
          amount: '1200',
          date: '2026-09-11',
          comment: 'IMPUESTO AL CREDITO',
          needsReview: true,
          metadata: { ...base, fp: 'fp-2', kind: TransactionKind.tax, dir: 'out', subst: true },
        }),
        activityStub({
          activityType: 'WITHDRAWAL',
          amount: '45000',
          date: '2026-09-12',
          comment: 'SUPERMERCADO',
          metadata: { ...base, fp: 'fp-3', kind: TransactionKind.expense, dir: 'out' },
        }),
      ]),
    );

    expect(loaded.review.map((item) => item.reason)).toEqual([
      'unresolved',
      'substituted-type',
    ]);
  });

  /**
   * La distinción que hace falta mostrar: una fila en borrador no cuenta en
   * ningún total del host mientras siga así, y la otra sí cuenta — bajo un tipo
   * que no le corresponde.
   */
  it('dice cuál de las dos el host dejó fuera de sus totales', async () => {
    const loaded = await loadImportedTransactions(
      ctx([
        activityStub({
          activityType: 'UNKNOWN',
          amount: '45000',
          date: '2026-09-10',
          comment: 'SIN CLASIFICAR',
          needsReview: true,
          status: 'DRAFT',
          metadata: { ...base, kind: TransactionKind.unknown, dir: 'out' },
        }),
        activityStub({
          activityType: 'FEE',
          amount: '1200',
          date: '2026-09-11',
          comment: 'IMPUESTO',
          needsReview: true,
          metadata: { ...base, fp: 'fp-2', kind: TransactionKind.tax, dir: 'out', subst: true },
        }),
      ]),
    );

    expect(loaded.review.map((item) => item.draft)).toEqual([true, false]);
  });

  it('lleva lo necesario para mostrar la fila sin volver a consultar', async () => {
    const loaded = await loadImportedTransactions(
      ctx([
        activityStub({
          id: 'act-x',
          accountId: 'acc-7',
          activityType: 'UNKNOWN',
          amount: '45000',
          date: '2026-09-10',
          comment: 'MOVIMIENTO SIN CLASIFICAR',
          needsReview: true,
          status: 'DRAFT',
          metadata: { ...base, kind: TransactionKind.unknown, dir: 'out' },
        }),
      ]),
    );

    const item = loaded.review[0];
    expect(item?.activityId).toBe('act-x');
    expect(item?.accountId).toBe('acc-7');
    expect(item?.date).toBe('2026-09-10');
    expect(item?.description).toBe('MOVIMIENTO SIN CLASIFICAR');
    expect(item?.amount.minor).toBe(-45_000);
  });

  it('un ledger sin nada pendiente devuelve una cola vacía', async () => {
    const loaded = await loadImportedTransactions(
      ctx([
        activityStub({
          activityType: 'WITHDRAWAL',
          amount: '45000',
          date: '2026-09-12',
          comment: 'SUPERMERCADO',
          metadata: { ...base, kind: TransactionKind.expense, dir: 'out' },
        }),
      ]),
    );
    expect(loaded.review).toEqual([]);
  });
});
