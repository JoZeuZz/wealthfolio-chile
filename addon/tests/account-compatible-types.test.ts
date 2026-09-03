import { describe, expect, it } from 'vitest';
import {
  activityToTransaction,
  readChileMetadata,
  resolveActivityType,
  toActivityCreate,
} from '../src/core/mapping/activities';
import { Direction, TRANSACTION_KINDS, TransactionKind } from '../src/core/model/kinds';
import { makeTransaction } from './fixtures';
import { activityStub } from './host';

/**
 * Lo que Wealthfolio acepta en una cuenta de tarjeta de crédito.
 *
 * Encontrado contra un host 3.7.0 real, no razonado: importar un estado de
 * cuenta CMR con un abono sin glosa reconocible devolvió
 *
 *   Activity error: Invalid data: UNKNOWN activities are not supported for
 *   credit card accounts
 *
 * y como `saveMany` valida el lote entero antes de escribir, esa única fila
 * costó los cinco movimientos: no se guardó ninguno. La lista de tipos
 * permitidos vive en `crates/core/src/activities/activities_service.rs`
 * (`account_activity_validation_message`): en una cuenta `CREDIT_CARD` sólo
 * `WITHDRAWAL`, `TRANSFER_IN`, `CREDIT`, `FEE` e `INTEREST`.
 *
 * Sustituir no es mentir. `CREDIT` sin subtipo es el vocabulario del propio
 * host para «entró dinero, sin especificar», que es exactamente lo que sabemos
 * de un abono que no supimos leer. Lo que no puede pasar es que la sustitución
 * borre lo que sí sabíamos: la metadata sigue diciendo `unknown`.
 */

/** Mirrors `account_activity_validation_message` in upstream v3.7.0. */
const ALLOWED_ON_CREDIT_CARD = ['WITHDRAWAL', 'TRANSFER_IN', 'CREDIT', 'FEE', 'INTEREST'];

describe('tipos permitidos en una cuenta de tarjeta', () => {
  it('ningún tipo de movimiento nuestro produce algo que el host rechace', () => {
    for (const kind of TRANSACTION_KINDS) {
      for (const direction of [Direction.in, Direction.out]) {
        const { activityType } = resolveActivityType(
          { kind, direction },
          { accountType: 'CREDIT_CARD' },
        );
        expect(
          ALLOWED_ON_CREDIT_CARD,
          `${kind}/${direction} produjo ${activityType}`,
        ).toContain(activityType);
      }
    }
  });

  it('un abono sin clasificar pasa a ser un crédito genérico', () => {
    expect(
      resolveActivityType(
        { kind: TransactionKind.unknown, direction: Direction.in },
        { accountType: 'CREDIT_CARD' },
      ),
    ).toEqual({ activityType: 'CREDIT', substituted: true });
  });

  it('en una cuenta de efectivo sigue siendo UNKNOWN', () => {
    // `UNKNOWN` es mejor donde el host lo acepta: lo marca `needs_review` y lo
    // deja fuera de todo cálculo.
    expect(
      resolveActivityType(
        { kind: TransactionKind.unknown, direction: Direction.in },
        { accountType: 'CASH' },
      ),
    ).toEqual({ activityType: 'UNKNOWN' });
  });

  it('sin saber el tipo de cuenta no sustituye nada', () => {
    expect(
      resolveActivityType({ kind: TransactionKind.unknown, direction: Direction.in }),
    ).toEqual({ activityType: 'UNKNOWN' });
  });

  it('un impuesto en la tarjeta se guarda como cargo', () => {
    expect(
      resolveActivityType(
        { kind: TransactionKind.tax, direction: Direction.out },
        { accountType: 'CREDIT_CARD' },
      ),
    ).toMatchObject({ activityType: 'FEE', substituted: true });
  });

  it('una salida de la tarjeta que no es compra se guarda como cargo', () => {
    expect(
      resolveActivityType(
        { kind: TransactionKind.internal_transfer, direction: Direction.out },
        { accountType: 'CREDIT_CARD' },
      ),
    ).toMatchObject({ activityType: 'WITHDRAWAL', substituted: true });
  });
});

describe('la sustitución no borra lo que sí sabíamos', () => {
  const transaction = makeTransaction({
    amount: 8000,
    date: '2026-10-22',
    description: 'ABONO',
    kind: TransactionKind.unknown,
  });

  it('la metadata sigue diciendo que no se pudo clasificar', () => {
    const create = toActivityCreate(transaction, {
      accountId: 'acc-card',
      runId: 'run-1',
      accountType: 'CREDIT_CARD',
    });

    expect(create.activityType).toBe('CREDIT');
    const metadata = readChileMetadata(create.metadata as string);
    expect(metadata?.kind).toBe(TransactionKind.unknown);
    expect(metadata?.subst).toBe(true);
  });

  it('al releerla no se convierte en una devolución', () => {
    // Sin la marca, `reconcileKind` ve `CREDIT`, no reconoce `unknown` y deja
    // que el host mande: el movimiento pasaría a contarse como devolución, que
    // es justo la afirmación que no podíamos hacer.
    const create = toActivityCreate(transaction, {
      accountId: 'acc-card',
      runId: 'run-1',
      accountType: 'CREDIT_CARD',
    });

    const rebuilt = activityToTransaction(
      activityStub({
        accountId: 'acc-card',
        activityType: 'CREDIT',
        amount: '8000',
        date: '2026-10-22',
        comment: create.comment as string,
        metadata: readChileMetadata(create.metadata as string) as unknown as Record<
          string,
          unknown
        >,
      }),
    );

    expect(rebuilt?.kind).toBe(TransactionKind.unknown);
  });

  it('el host sigue mandando cuando el usuario cambia el tipo de verdad', () => {
    // La marca cubre la sustitución, no cualquier discrepancia: si la actividad
    // pasa a ser un `WITHDRAWAL`, eso no es una sustitución nuestra.
    const create = toActivityCreate(transaction, {
      accountId: 'acc-card',
      runId: 'run-1',
      accountType: 'CREDIT_CARD',
    });

    const rebuilt = activityToTransaction(
      activityStub({
        accountId: 'acc-card',
        activityType: 'WITHDRAWAL',
        amount: '8000',
        date: '2026-10-22',
        comment: create.comment as string,
        metadata: readChileMetadata(create.metadata as string) as unknown as Record<
          string,
          unknown
        >,
      }),
    );

    expect(rebuilt?.kind).toBe(TransactionKind.expense);
  });
});
