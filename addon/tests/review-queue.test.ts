import { describe, expect, it } from 'vitest';
import { reviewReason, toActivityCreate } from '../src/core/mapping/activities';
import { Confidence, Direction, TransactionKind } from '../src/core/model/kinds';
import type { NormalizedTransaction } from '../src/core/model/transaction';
import { makeTransaction } from './fixtures';

/**
 * Qué queda esperando a una persona.
 *
 * El addon marca dos clases de fila para revisión, y son las dos formas de
 * decir «la actividad que Wealthfolio guarda no dice qué fue el movimiento»:
 * la que no se pudo leer, y la que se escribió bajo un tipo que la cuenta
 * aceptaba en vez del que le correspondía.
 *
 * Sólo la primera lleva además `status: DRAFT`, y esa diferencia es la que
 * hace falta una superficie propia: el filtro «necesita revisión» del host
 * busca por estado, así que encuentra las primeras y **no** las segundas. Un
 * movimiento que el addon se negó a clasificar y que entró al portafolio bajo
 * un tipo prestado es justo el que nadie va a encontrar.
 */
function stored(
  transaction: NormalizedTransaction,
  options: { accountType?: 'CREDIT_CARD'; needsReview?: boolean } = {},
) {
  const create = toActivityCreate(transaction, {
    accountId: 'acc',
    runId: 'run',
    ...(options.accountType ? { accountType: options.accountType } : {}),
  });
  return {
    id: 'a1',
    accountId: 'acc',
    activityType: create.activityType,
    ...(create.subtype ? { subtype: create.subtype } : {}),
    amount: create.amount,
    currency: create.currency ?? 'CLP',
    date: create.activityDate as string,
    comment: create.comment ?? '',
    metadata: create.metadata,
    // What the host reports back. The addon asked for it; the host is the one
    // that says whether it is still true.
    needsReview: options.needsReview ?? create.needsReview ?? false,
  };
}

const unresolved = () =>
  makeTransaction({
    amount: -45_000,
    date: '2026-09-10',
    description: 'MOVIMIENTO SIN CLASIFICAR',
    kind: TransactionKind.unknown,
    kindConfidence: Confidence.unknown,
  });

const substituted = () =>
  makeTransaction({
    amount: -1_200,
    date: '2026-09-10',
    description: 'IMPUESTO AL CREDITO',
    kind: TransactionKind.tax,
    kindConfidence: Confidence.confirmed,
  });

describe('por qué una fila espera revisión', () => {
  it('una fila que no se pudo leer', () => {
    expect(reviewReason(stored(unresolved()))).toBe('unresolved');
  });

  /**
   * Un impuesto en una cuenta de tarjeta: el host rechaza `TAX` ahí, así que se
   * escribe como `FEE`. El addon leyó bien el movimiento y el ledger guarda
   * otra cosa, y eso es lo que hay que poder encontrar.
   */
  it('una fila escrita bajo un tipo prestado', () => {
    const activity = stored(substituted(), { accountType: 'CREDIT_CARD' });
    expect(activity.activityType).toBe('FEE');
    expect(reviewReason(activity)).toBe('substituted-type');
  });

  it('una fila corriente no espera nada', () => {
    const activity = stored(
      makeTransaction({ amount: -45_000, date: '2026-09-10', description: 'SUPERMERCADO' }),
    );
    expect(reviewReason(activity)).toBeUndefined();
  });

  /**
   * El host manda. Si la persona ya revisó la fila y le quitó la marca, deja de
   * estar en la cola aunque la metadata del addon siga diciendo que la escribió
   * sin saber qué era.
   */
  it('deja de esperar cuando el host dice que ya no', () => {
    expect(reviewReason(stored(unresolved(), { needsReview: false }))).toBeUndefined();
  });

  /**
   * Y al revés: una actividad marcada que el addon no escribió no es asunto
   * suyo. Wealthfolio la muestra en su propia página; inventarle una razón
   * chilena sería hablar por el host.
   */
  it('una actividad ajena marcada por el host no recibe una razón nuestra', () => {
    expect(
      reviewReason({
        id: 'x',
        activityType: 'WITHDRAWAL',
        amount: '1000',
        currency: 'CLP',
        date: '2026-09-10',
        comment: 'algo',
        needsReview: true,
      }),
    ).toBeUndefined();
  });
});

/**
 * La diferencia que justifica una superficie propia, dicha como test: sólo una
 * de las dos razones queda en estado `DRAFT`, y el filtro del host busca por
 * estado.
 */
describe('cuál de las dos encuentra el filtro del host', () => {
  it('la que no se pudo leer queda en DRAFT', () => {
    const create = toActivityCreate(unresolved(), { accountId: 'acc', runId: 'run' });
    expect(create.status).toBe('DRAFT');
    expect(create.needsReview).toBe(true);
  });

  /**
   * La sustituida no: un `tax` escrito como `FEE` es plata que el addon leyó
   * bien, y una fila en borrador es plata que el host deja de contar.
   */
  it('la del tipo prestado no, y por eso el filtro no la ve', () => {
    const create = toActivityCreate(substituted(), {
      accountId: 'acc',
      runId: 'run',
      accountType: 'CREDIT_CARD',
    });
    expect(create.status).toBeUndefined();
    expect(create.needsReview).toBe(true);
  });
});

describe('lo que la cola cuenta', () => {
  it('la dirección del movimiento sobrevive para poder mostrarlo', () => {
    const activity = stored(unresolved());
    expect(reviewReason(activity)).toBe('unresolved');
    // `UNKNOWN` no lleva dirección propia en el host: la del addon es la única
    // que dice que esta plata salió.
    expect(activity.activityType).toBe('UNKNOWN');
    expect(unresolved().direction).toBe(Direction.out);
  });
});
