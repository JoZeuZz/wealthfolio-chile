import { describe, expect, it } from 'vitest';
import { classifyDuplicate, buildDuplicateIndex } from '../src/core/dedupe/classify';
import {
  activityProjection,
  activityToTransaction,
  METADATA_VERSION,
  readChileMetadata,
  toActivityCreate,
} from '../src/core/mapping/activities';
import { Direction, TransactionKind } from '../src/core/model/kinds';
import { FinancialCostKind } from '../src/core/model/financial-cost';
import { loadDuplicateIndexResult } from '../src/services/activity-index';
import { makeTransaction } from './fixtures';
import { activityStub, fakeHost } from './host';

/**
 * Wealthfolio manda.
 *
 * El addon escribe metadata al crear una actividad y después el usuario puede
 * editar esa actividad en Wealthfolio. Desde ese momento la metadata describe
 * lo que el addon escribió, no lo que hay en la contabilidad: `fp` es la huella
 * de un movimiento que ya no existe con esa forma, y `kind` es una
 * clasificación que el usuario pudo haber cambiado a mano.
 *
 * La regla: la metadata es procedencia y caché, nunca autoridad. Donde el host
 * contradice, gana el host; donde el host no dice nada, la metadata rellena.
 */

const ACCOUNT = 'acc-1';

function ourActivity(overrides: Parameters<typeof activityStub>[0]) {
  return activityStub({ accountId: ACCOUNT, ...overrides });
}

describe('proyección de la actividad', () => {
  it('la metadata que escribimos incluye la proyección de lo escrito', () => {
    const create = toActivityCreate(
      makeTransaction({ amount: -85400, date: '2026-02-03', description: 'COMPRA' }),
      { accountId: ACCOUNT, runId: 'run-1' },
    );

    const metadata = readChileMetadata(create.metadata as string);
    expect(metadata?.v).toBe(METADATA_VERSION);
    expect(metadata?.proj).toBeTruthy();
  });

  it('la proyección se recalcula igual leyendo la actividad de vuelta', () => {
    const transaction = makeTransaction({ amount: -85400, date: '2026-02-03', description: 'COMPRA' });
    const create = toActivityCreate(transaction, { accountId: ACCOUNT, runId: 'run-1' });
    const metadata = readChileMetadata(create.metadata as string);

    const stored = ourActivity({
      activityType: 'WITHDRAWAL',
      amount: '85400',
      date: '2026-02-03',
      comment: create.comment as string,
    });

    expect(activityProjection(stored)).toBe(metadata?.proj);
  });

  it('cambia cuando cambia el monto', () => {
    const base = ourActivity({
      activityType: 'WITHDRAWAL',
      amount: '85400',
      date: '2026-02-03',
      comment: 'COMPRA',
    });
    const edited = { ...base, amount: '99999' };
    expect(activityProjection(edited)).not.toBe(activityProjection(base));
  });

  it('cambia cuando cambia la fecha, la glosa o el tipo', () => {
    const base = ourActivity({
      activityType: 'WITHDRAWAL',
      amount: '85400',
      date: '2026-02-03',
      comment: 'COMPRA',
    });
    expect(activityProjection({ ...base, date: new Date('2026-02-04T00:00:00Z') })).not.toBe(
      activityProjection(base),
    );
    expect(activityProjection({ ...base, comment: 'OTRA COSA' })).not.toBe(
      activityProjection(base),
    );
    expect(activityProjection({ ...base, activityType: 'DEPOSIT' })).not.toBe(
      activityProjection(base),
    );
  });
});

describe('un duplicado exacto contra una actividad editada', () => {
  const transaction = makeTransaction({
    amount: -85400,
    date: '2026-02-03',
    description: 'COMPRA SUPERMERCADO',
    fingerprint: 'fp-abc',
  });

  function indexWith(overrides: { hostModified?: boolean }) {
    return buildDuplicateIndex([
      {
        fingerprint: 'fp-abc',
        activityId: 'act-1',
        date: '2026-02-03',
        amount: transaction.amount,
        description: 'COMPRA SUPERMERCADO',
        ...(overrides.hostModified !== undefined ? { hostModified: overrides.hostModified } : {}),
      },
    ]);
  }

  it('sigue siendo exacto cuando la actividad no se tocó', () => {
    const finding = classifyDuplicate(
      transaction,
      indexWith({}),
      { accountId: ACCOUNT },
      new Map(),
    );
    expect(finding.verdict).toBe('exact');
  });

  it('baja a probable cuando el host dice que la actividad cambió', () => {
    // La huella describe lo que se importó. Si la actividad ya no es eso,
    // saltarse la fila en silencio deja el movimiento original fuera de la
    // contabilidad para siempre, y nadie se entera.
    const finding = classifyDuplicate(
      transaction,
      indexWith({ hostModified: true }),
      { accountId: ACCOUNT },
      new Map(),
    );
    expect(finding.verdict).toBe('probable');
    expect(finding.existingActivityId).toBe('act-1');
    expect(finding.reason).toMatch(/edit/i);
  });
});

describe('el índice marca lo que el host reporta como editado', () => {
  it('usa la proyección cuando la metadata la trae', async () => {
    const transaction = makeTransaction({ amount: -85400, date: '2026-02-03', description: 'COMPRA' });
    const create = toActivityCreate(transaction, { accountId: ACCOUNT, runId: 'run-1' });
    const metadata = readChileMetadata(create.metadata as string);

    const host = fakeHost({
      activities: [
        ourActivity({
          activityType: 'WITHDRAWAL',
          // El usuario cambió el monto en Wealthfolio.
          amount: '99999',
          date: '2026-02-03',
          comment: create.comment as string,
          metadata: metadata as unknown as Record<string, unknown>,
        }),
      ],
    });

    const result = await loadDuplicateIndexResult(host.ctx, { accountId: ACCOUNT });
    expect(result.index.byFingerprint.get(metadata?.fp as string)?.hostModified).toBe(true);
  });

  it('no marca nada cuando la actividad sigue igual', async () => {
    const transaction = makeTransaction({ amount: -85400, date: '2026-02-03', description: 'COMPRA' });
    const create = toActivityCreate(transaction, { accountId: ACCOUNT, runId: 'run-1' });
    const metadata = readChileMetadata(create.metadata as string);

    const host = fakeHost({
      activities: [
        ourActivity({
          activityType: 'WITHDRAWAL',
          amount: '85400',
          date: '2026-02-03',
          comment: create.comment as string,
          metadata: metadata as unknown as Record<string, unknown>,
        }),
      ],
    });

    const result = await loadDuplicateIndexResult(host.ctx, { accountId: ACCOUNT });
    expect(result.index.byFingerprint.get(metadata?.fp as string)?.hostModified).toBeFalsy();
  });

  it('cae en isUserModified para filas escritas antes de que existiera la proyección', async () => {
    // Metadata v2: no trae `proj`, así que no hay con qué comparar. El host sí
    // sabe si la fila se editó después de crearse — es su propio campo, no una
    // inferencia nuestra.
    const host = fakeHost({
      activities: [
        {
          ...ourActivity({
            activityType: 'WITHDRAWAL',
            amount: '85400',
            date: '2026-02-03',
            comment: 'COMPRA',
            metadata: { v: 2, fp: 'fp-viejo', inst: 'banco-chile', parser: 'p', parserVersion: '1', fileHash: 'h', runId: 'r', kind: TransactionKind.expense },
          }),
          isUserModified: true,
        },
      ],
    });

    const result = await loadDuplicateIndexResult(host.ctx, { accountId: ACCOUNT });
    expect(result.index.byFingerprint.get('fp-viejo')?.hostModified).toBe(true);
  });
});

describe('el tipo de la actividad gana a la clasificación cacheada', () => {
  it('reclasifica cuando el usuario cambió el tipo en Wealthfolio', () => {
    // Escribimos `expense`/`WITHDRAWAL`; el usuario lo cambió a `DEPOSIT`.
    // Seguir contándolo como gasto sería reportar un número que la
    // contabilidad del host contradice.
    const transaction = activityToTransaction(
      ourActivity({
        activityType: 'DEPOSIT',
        amount: '85400',
        date: '2026-02-03',
        comment: 'COMPRA',
        metadata: { v: 3, fp: 'fp-1', inst: 'x', parser: 'p', parserVersion: '1', fileHash: 'h', runId: 'r', kind: TransactionKind.expense, dir: Direction.out },
      }),
    );

    expect(transaction?.kind).toBe(TransactionKind.income);
    expect(transaction?.direction).toBe(Direction.in);
    expect(transaction?.amount.minor).toBe(85400);
  });

  it('conserva la clasificación fina cuando es compatible con el tipo del host', () => {
    // `credit_card_purchase` y `expense` son los dos `WITHDRAWAL`. El host no
    // contradice nada, así que la metadata aporta el detalle que el host no
    // tiene.
    const transaction = activityToTransaction(
      ourActivity({
        activityType: 'WITHDRAWAL',
        amount: '49990',
        date: '2026-02-03',
        comment: 'FALABELLA',
        metadata: { v: 3, fp: 'fp-2', inst: 'x', parser: 'p', parserVersion: '1', fileHash: 'h', runId: 'r', kind: TransactionKind.credit_card_purchase, dir: Direction.out },
      }),
    );

    expect(transaction?.kind).toBe(TransactionKind.credit_card_purchase);
  });

  it('conserva un pago de tarjeta guardado como TRANSFER_OUT', () => {
    const transaction = activityToTransaction(
      ourActivity({
        activityType: 'TRANSFER_OUT',
        amount: '120000',
        date: '2026-02-05',
        comment: 'PAGO TARJETA',
        metadata: { v: 3, fp: 'fp-3', inst: 'x', parser: 'p', parserVersion: '1', fileHash: 'h', runId: 'r', kind: TransactionKind.credit_card_payment, dir: Direction.out },
      }),
    );

    expect(transaction?.kind).toBe(TransactionKind.credit_card_payment);
  });

  it('un tipo sin equivalente en nuestro modelo queda sin clasificar', () => {
    const transaction = activityToTransaction(
      ourActivity({
        activityType: 'BUY',
        amount: '1000',
        date: '2026-02-05',
        comment: 'ALGO',
        metadata: { v: 3, fp: 'fp-4', inst: 'x', parser: 'p', parserVersion: '1', fileHash: 'h', runId: 'r', kind: TransactionKind.expense, dir: Direction.out },
      }),
    );

    expect(transaction?.kind).toBe(TransactionKind.unknown);
  });
});

describe('una edición invalida refinamientos cacheados aunque conserve el tipo', () => {
  it('deja de atribuir un costo financiero cuyo monto cambió en el host', () => {
    const original = makeTransaction({
      amount: -5_900,
      date: '2026-09-30',
      description: 'COMISION DE MANTENCION',
      kind: TransactionKind.fee,
      financialCost: {
        kind: FinancialCostKind.maintenance,
        confidence: 'confirmed',
        matchedText: 'COMISION DE MANTENCION',
      },
    });
    const create = toActivityCreate(original, { accountId: ACCOUNT, runId: 'run-fc' });

    const edited = activityToTransaction(
      ourActivity({
        activityType: 'FEE',
        amount: '9900',
        date: '2026-09-30',
        comment: create.comment as string,
        metadata: readChileMetadata(create.metadata as string),
      }),
    );

    expect(edited?.kind).toBe(TransactionKind.fee);
    expect(edited?.financialCost).toBeUndefined();
  });

  it('no conserva semántica de avance ni otros caches tras editar la glosa', () => {
    const original = makeTransaction({
      amount: -200_000,
      date: '2026-09-03',
      description: 'AVANCE EN EFECTIVO CUOTA 2 DE 12',
      kind: TransactionKind.cash_advance,
      merchant: 'Cajero',
      category: 'efectivo',
      tags: ['avance'],
      installment: {
        current: 2,
        total: 12,
        confidence: 'confirmed',
        matchedText: 'CUOTA 2 DE 12',
      },
    });
    const create = toActivityCreate(original, { accountId: ACCOUNT, runId: 'run-advance' });

    const edited = activityToTransaction(
      ourActivity({
        activityType: 'WITHDRAWAL',
        amount: '200000',
        date: '2026-09-03',
        comment: 'SUPERMERCADO GENERICO',
        metadata: readChileMetadata(create.metadata as string),
      }),
    );

    expect(edited?.kind).toBe(TransactionKind.expense);
    expect(edited?.merchant).toBe('Supermercado Generico');
    expect(edited?.category).toBeUndefined();
    expect(edited?.installment).toBeUndefined();
    expect(edited?.tags).toEqual([]);
  });
});
