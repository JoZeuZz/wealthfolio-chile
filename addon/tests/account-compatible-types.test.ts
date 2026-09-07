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
        if (
          direction === Direction.in &&
          (kind === TransactionKind.fee || kind === TransactionKind.tax)
        ) {
          expect(() =>
            resolveActivityType({ kind, direction }, { accountType: 'CREDIT_CARD' }),
          ).toThrow(/direction/i);
          continue;
        }
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
    // `UNKNOWN` es mejor donde el host lo acepta: `event_kind` lo manda a
    // `EconomicEventKind::Other` y queda fuera de todo cálculo. La marca de
    // revisión la pone `toActivityCreate`, no el host — ver más abajo.
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

/**
 * Marcar para revisión lo que no se pudo leer.
 *
 * `UNKNOWN` se eligió porque «Wealthfolio lo marca `needs_review` y lo deja
 * fuera de todo cálculo». La segunda mitad es cierta —`event_kind` lo manda a
 * `EconomicEventKind::Other`— pero la primera no: comprobado contra un host
 * 3.7.0 real, una actividad `UNKNOWN` creada por `activities/bulk` vuelve con
 * `needsReview: false`. El host sólo fuerza esa marca en modo sincronización
 * (`activities_service.rs`, `mode.is_sync()`).
 *
 * En una cuenta de tarjeta el agujero es peor. Ahí `UNKNOWN` no se acepta y la
 * sustitución escribe `CREDIT`, que `event_kind` clasifica como
 * `EconomicEventKind::Income`: un abono que el addon se negó explícitamente a
 * clasificar entra al portafolio como ingreso, sin marca de revisión y sin
 * nada que lo distinga de una devolución real.
 *
 * `needs_review` no está declarado en `ActivityCreate` del SDK 3.7.0, pero el
 * backend sí lo acepta (`NewActivity.needs_review: Option<bool>`) y el puente
 * del host reenvía el objeto sin filtrar campos
 * (`apps/frontend/src/addons/type-bridge.ts`). Verificado contra el host real:
 * un create con `needsReview: true` vuelve con `needsReview: true`.
 */
describe('lo que no se pudo clasificar queda marcado para revisión', () => {
  const unreadable = makeTransaction({
    amount: 9900,
    date: '2026-03-24',
    description: 'ABONO VARIOS SIN DETALLE',
    kind: TransactionKind.unknown,
  });

  it('un abono ilegible en una tarjeta se marca, aunque se guarde como CREDIT', () => {
    const create = toActivityCreate(unreadable, {
      accountId: 'acc-card',
      runId: 'run-1',
      accountType: 'CREDIT_CARD',
    });

    expect(create.activityType).toBe('CREDIT');
    expect(create.needsReview).toBe(true);
    // La marca sola no basta: el filtro «necesita revisión» del host consulta
    // `status = 'DRAFT'`, no `needs_review`
    // (`storage-sqlite/src/activities/repository.rs`). Comprobado contra un host
    // 3.7.0 real: con `needsReview: true` y `status` por defecto, la actividad
    // se guarda marcada y `needsReviewFilter: true` devuelve cero filas.
    //
    // `DRAFT` tiene un segundo efecto, y por eso sólo lo llevan las filas sin
    // clasificar: `DefaultActivityCompiler::compile` devuelve `vec![]` para
    // cualquier actividad que no esté `POSTED`, así que una fila en borrador no
    // entra en ningún cálculo del portafolio. Para un abono que nadie pudo leer
    // eso es exactamente lo que se quiere.
    expect(create.status).toBe('DRAFT');
  });

  it('también se marca en una cuenta de efectivo, donde queda como UNKNOWN', () => {
    const create = toActivityCreate(unreadable, {
      accountId: 'acc-cash',
      runId: 'run-1',
      accountType: 'CASH',
    });

    expect(create.activityType).toBe('UNKNOWN');
    expect(create.needsReview).toBe(true);
  });

  it('una sustitución de tipo también se marca: el tipo guardado no es el del movimiento', () => {
    const tax = makeTransaction({
      amount: -1230,
      date: '2026-03-11',
      description: 'IMPUESTO TIMBRES Y ESTAMPILLAS',
      kind: TransactionKind.tax,
    });

    const create = toActivityCreate(tax, {
      accountId: 'acc-card',
      runId: 'run-1',
      accountType: 'CREDIT_CARD',
    });

    expect(create.activityType).toBe('FEE');
    expect(create.needsReview).toBe(true);
    // Pero **sin** `DRAFT`. Un impuesto es un movimiento que el addon leyó y
    // clasificó con confianza; lo único aproximado es el tipo con que la cuenta
    // de tarjeta lo acepta. Marcarlo `DRAFT` lo sacaría del saldo de la cuenta
    // — `compile` descarta lo no `POSTED` — y borrar plata real de la
    // contabilidad para que aparezca en una lista de revisión es un intercambio
    // que no se sostiene.
    expect(create.status).toBeUndefined();
  });

  it('un movimiento que se guarda tal cual no pide revisión', () => {
    const purchase = makeTransaction({
      amount: -15300,
      date: '2026-03-27',
      description: 'TOTTUS PUENTE ALTO',
      kind: TransactionKind.credit_card_purchase,
    });

    const create = toActivityCreate(purchase, {
      accountId: 'acc-card',
      runId: 'run-1',
      accountType: 'CREDIT_CARD',
    });

    expect(create.activityType).toBe('WITHDRAWAL');
    expect(create.needsReview).toBeUndefined();
    expect(create.status).toBeUndefined();
  });

  it('una devolución reconocida por su glosa no pide revisión', () => {
    const refund = makeTransaction({
      amount: 27450,
      date: '2026-03-21',
      description: 'ANULACION COMPRA SODIMAC MAIPU',
      kind: TransactionKind.refund,
    });

    const create = toActivityCreate(refund, {
      accountId: 'acc-card',
      runId: 'run-1',
      accountType: 'CREDIT_CARD',
    });

    expect(create).toMatchObject({ activityType: 'CREDIT', subtype: 'REFUND' });
    expect(create.needsReview).toBeUndefined();
  });
});

/**
 * Qué queda registrado cuando la tarjeta no puede representar el movimiento.
 *
 * Verificado en el checkout de Wealthfolio en la etiqueta `v3.7.0`, no de
 * memoria:
 *
 * - `account_activity_validation_message` (`activities_service.rs`) acepta en
 *   una cuenta `CREDIT_CARD` sólo `WITHDRAWAL`, `TRANSFER_IN`, `CREDIT`, `FEE`
 *   e `INTEREST`. `TRANSFER_OUT` está genuinamente prohibido, así que la
 *   sustitución no es una preferencia del addon: es la única salida
 *   representable para una salida de dinero.
 * - `handle_withdrawal` (`handlers/cash_flows.rs`) y la rama de efectivo de
 *   `handle_transfer_out` (`handlers/transfers.rs`) hacen exactamente lo mismo
 *   con el saldo: `add_cash(-(monto + comisión + impuesto))` y la misma suma a
 *   `net_contribution`. **El saldo de la cuenta no depende de cuál se escriba.**
 * - Donde sí difieren: `economic_events::event_kind` trata `WITHDRAWAL` como
 *   `CashFlow` (flujo externo) y `spending::classify_activity` cuenta un
 *   `WITHDRAWAL` en una tarjeta como `Expense`.
 *
 * Es decir, la degradación cuesta clasificación, no saldos. Y por eso tiene
 * que viajar marcada: `metadata.kind` conserva la lectura real y `needsReview`
 * pide que un humano la mire en el host.
 */
describe('la degradación de una transferencia saliente en una tarjeta', () => {
  it('se escribe WITHDRAWAL, se marca como sustituida y pide revisión', () => {
    const create = toActivityCreate(
      makeTransaction({
        kind: TransactionKind.internal_transfer,
        amount: -120_000,
        date: '2026-02-03',
        description: 'TRASPASO A CUENTA CORRIENTE',
      }),
      { accountId: 'acc-card', runId: 'run-1', accountType: 'CREDIT_CARD' },
    );

    expect(create.activityType).toBe('WITHDRAWAL');
    expect(create.needsReview).toBe(true);

    const metadata = readChileMetadata(create.metadata as string);
    expect(metadata?.kind).toBe(TransactionKind.internal_transfer);
    expect(metadata?.subst).toBe(true);
  });

  it('la entrante sí se representa, y por eso no pide revisión', () => {
    const create = toActivityCreate(
      makeTransaction({
        kind: TransactionKind.internal_transfer,
        amount: 120_000,
        date: '2026-02-03',
        description: 'ABONO DESDE CUENTA CORRIENTE',
      }),
      { accountId: 'acc-card', runId: 'run-1', accountType: 'CREDIT_CARD' },
    );

    expect(create.activityType).toBe('TRANSFER_IN');
    expect(create.needsReview).toBeUndefined();
  });
});
