import { describe, expect, it } from 'vitest';
import { defaultKindForRow } from '../src/core/classify/card-semantics';
import { detectFinancialCost, withFinancialCost } from '../src/core/chile/financial-costs';
import { readChileMetadata, toActivityCreate } from '../src/core/mapping/activities';
import { financialCostBreakdown } from '../src/core/metrics/monthly';
import { FinancialCostKind } from '../src/core/model/financial-cost';
import { Confidence, Direction, TransactionKind } from '../src/core/model/kinds';
import { StatementProduct } from '../src/core/model/statement';
import type { NormalizedTransaction } from '../src/core/model/transaction';
import { findRecurringCharges } from '../src/core/recurring/detect';
import { normalizeDescription } from '../src/core/text';
import { makeTransaction } from './fixtures';

const read = (description: string) => detectFinancialCost(normalizeDescription(description));

function row(
  description: string,
  overrides: Partial<Omit<NormalizedTransaction, 'amount'>> & { amount?: number } = {},
): NormalizedTransaction {
  return makeTransaction({
    date: '2026-09-10',
    description,
    kind: TransactionKind.credit_card_purchase,
    kindConfidence: Confidence.suggested,
    ...overrides,
    amount: overrides.amount ?? -4500,
  });
}

/**
 * Lo que un review especializado encontró en la primera versión de la dimensión
 * de costo financiero. Cada caso es un movimiento chileno plausible que el
 * modelo clasificaba mal, y cada uno vale un test propio porque el modo de
 * falla no es un error visible: es un número creíble en el lugar equivocado.
 */
describe('un costo financiero es sólo un costo si además es gasto', () => {
  /**
   * `metadata.fc` sobrevive a que el usuario cambie el tipo de la actividad en
   * Wealthfolio, y debe sobrevivir: es el registro de qué decía la glosa. Lo
   * que no puede sobrevivir es contarlo en un desglose del gasto cuando el host
   * ya dijo que esa fila no es gasto.
   */
  it('no cuenta una fila que el host reclasificó como transferencia', () => {
    const breakdown = financialCostBreakdown(
      [
        row('COMISION DE MANTENCION', {
          kind: TransactionKind.internal_transfer,
          financialCost: {
            kind: FinancialCostKind.maintenance,
            confidence: Confidence.confirmed,
            matchedText: 'COMISION DE MANTENCION',
          },
        }),
      ],
      { currency: 'CLP' },
    );
    expect(breakdown.total.minor).toBe(0);
  });

  /**
   * `COMISION` a secas dice que hay una comisión y no cuál. La corrección de
   * tipo ya se negaba a actuar sobre esa lectura; el desglose la sumaba igual.
   * Una comisión de corretaje de propiedad de $1.500.000 aparecía como el costo
   * del crédito del mes.
   */
  it('no cuenta una lectura que no nombró el costo', () => {
    const annotated = withFinancialCost(
      row('COMISION CORRETAJE PROPIEDAD', {
        amount: -1_500_000,
        kind: TransactionKind.fee,
        kindConfidence: Confidence.confirmed,
      }),
    );
    expect(annotated.financialCost?.confidence).toBe(Confidence.suggested);

    const breakdown = financialCostBreakdown([annotated], { currency: 'CLP' });
    expect(breakdown.total.minor).toBe(0);
  });
});

describe('palabras que aparecen en nombres de comercios chilenos', () => {
  /**
   * Las imprentas de timbres de goma son un rubro real. `TIMBRES` como palabra
   * suelta convertía una compra de $12.900 en una imprenta en impuesto al
   * crédito.
   */
  it('una imprenta de timbres no es el impuesto de timbres', () => {
    expect(read('TIMBRES Y GOMAS SPA')).toBeUndefined();
    expect(read('IMPRENTA TIMBRES GENERICA')).toBeUndefined();
    expect(read('IMPUESTO DE TIMBRES Y ESTAMPILLAS')?.kind).toBe(FinancialCostKind.credit_tax);
  });

  /**
   * La comisión de administración de un fondo mutuo, de un APV o de un edificio
   * no es la mantención de una tarjeta. Sin un sustantivo que diga de qué
   * producto se habla, `ADMINISTRACION` no alcanza.
   */
  it('la administración de un fondo no es la mantención de la tarjeta', () => {
    // Sigue siendo una comisión, y decirlo es correcto. Lo que no puede es
    // llamarse mantención de tarjeta, ni entrar al desglose de costos del
    // crédito: una lectura sin apellido no se cuenta.
    for (const glosa of ['COMISION DE ADMINISTRACION FONDO MUTUO', 'COMISION ADMINISTRACION EDIFICIO']) {
      expect(read(glosa)?.kind).toBe(FinancialCostKind.other);
      expect(read(glosa)?.confidence).toBe(Confidence.suggested);
    }
    expect(read('COMISION DE ADMINISTRACION TARJETA')?.kind).toBe(FinancialCostKind.maintenance);
  });

  it('la mantención de una línea telefónica no es la de una línea de crédito', () => {
    expect(read('MANTENCION LINEA TELEFONICA')).toBeUndefined();
    expect(read('MANTENCION LINEA DE CREDITO')?.kind).toBe(FinancialCostKind.maintenance);
  });
});

/**
 * `normalizeDescription` conserva `.`, `-`, `/` y `*` a propósito: llevan
 * contadores de cuotas y colas de tarjeta. Los patrones que sólo aceptaban
 * espacios no veían `COMISION-MANTENCION`, que es como sale un export derivado
 * de un archivo de ancho fijo.
 */
describe('los separadores que el normalizador deja pasar', () => {
  it('lee un costo separado por guiones o puntos', () => {
    expect(read('COMISION-MANTENCION-TARJETA')?.kind).toBe(FinancialCostKind.maintenance);
    expect(read('IMPUESTO.AL.CREDITO')?.kind).toBe(FinancialCostKind.credit_tax);
    expect(read('INTERES/MORA')?.kind).toBe(FinancialCostKind.late_interest);
  });
});

describe('lo que una lectura de costo no puede pisar', () => {
  /**
   * `mark_transfer` deja `internal_transfer` en `suggested`, no en `confirmed`.
   * Una lectura de costo que sólo miraba la confianza reescribía esa fila a
   * `fee` y metía el monto dentro del gasto bruto — exactamente lo que la
   * marca de transferencia existía para evitar.
   */
  it('no convierte en gasto un movimiento marcado como transferencia', () => {
    const annotated = withFinancialCost(
      row('TRASPASO COMISION DE MANTENCION', {
        kind: TransactionKind.internal_transfer,
        kindConfidence: Confidence.suggested,
      }),
    );
    expect(annotated.kind).toBe(TransactionKind.internal_transfer);
    expect(annotated.financialCost?.kind).toBe(FinancialCostKind.maintenance);
  });
});

describe('el avance, otra vez', () => {
  /**
   * `AVANCE` a secas no está documentado en ninguna cartola, y hay empresas
   * chilenas cuyo nombre empieza con esa palabra. La versión anterior lo
   * clasificaba como avance «pero pidiendo revisión», y esa revisión no
   * existía: el preview no marca un `cash_advance` sugerido.
   */
  it('un comercio llamado AVANCE no es un avance', () => {
    const reading = defaultKindForRow({
      product: StatementProduct.credit_card,
      direction: Direction.out,
      description: 'AVANCE CAPACITACION LTDA',
    });
    expect(reading.kind).toBe(TransactionKind.credit_card_purchase);
  });

  it('las formas documentadas siguen leyéndose', () => {
    expect(
      defaultKindForRow({
        product: StatementProduct.credit_card,
        direction: Direction.out,
        description: 'AVANCE EN EFECTIVO',
      }).kind,
    ).toBe(TransactionKind.cash_advance);
  });

  /**
   * El avance que se abona en la cuenta corriente es la otra mitad del mismo
   * hecho: dinero prestado, no ingreso. Leerlo como ingreso decía que el mes
   * tuvo $200.000 de ingresos que nunca existieron, y además el gasto posterior
   * de ese efectivo se contaba aparte.
   */
  it('un avance abonado en la cuenta no es ingreso', () => {
    const reading = defaultKindForRow({
      product: StatementProduct.checking,
      direction: Direction.in,
      description: 'ABONO AVANCE EN EFECTIVO',
    });
    expect(reading.kind).not.toBe(TransactionKind.income);
    expect(reading.confidence).toBe(Confidence.unknown);
  });

  /**
   * `core/recurring` repite la lista de tipos excluidos justamente para que
   * agregar uno a `SPENDING_KINDS` no lo convierta en una suscripción. Al
   * agregar `cash_advance` la lista no se actualizó, y tres avances mensuales
   * del mismo monto se leían como un cargo recurrente de $200.000 al mes.
   */
  it('tres avances seguidos no son una suscripción', () => {
    const charges = findRecurringCharges([
      makeTransaction({
        amount: -200_000,
        date: '2026-07-05',
        description: 'AVANCE EN EFECTIVO',
        kind: TransactionKind.cash_advance,
        merchant: 'Avance en efectivo',
      }),
      makeTransaction({
        amount: -200_000,
        date: '2026-08-05',
        description: 'AVANCE EN EFECTIVO',
        kind: TransactionKind.cash_advance,
        merchant: 'Avance en efectivo',
      }),
      makeTransaction({
        amount: -200_000,
        date: '2026-09-04',
        description: 'AVANCE EN EFECTIVO',
        kind: TransactionKind.cash_advance,
        merchant: 'Avance en efectivo',
      }),
    ]);
    expect(charges).toEqual([]);
  });
});

describe('lo que se persiste de un costo', () => {
  /**
   * Sólo se escribe la lectura que nombró el costo. Al releer, la presencia del
   * campo ya significa «confirmado», y no hace falta guardar la confianza para
   * no ascender una sugerencia a certeza al volver del host.
   */
  it('una lectura sugerida no se persiste', () => {
    const annotated = withFinancialCost(row('COMISION'));
    expect(annotated.financialCost?.kind).toBe(FinancialCostKind.other);

    const activity = toActivityCreate(annotated, { accountId: 'acc', runId: 'run' });
    expect(readChileMetadata(activity.metadata)?.fc).toBeUndefined();
  });

  /**
   * La metadata es JSON que sobrevivió un viaje de ida y vuelta por el host y
   * pudo ser editada a mano. Un valor que no está en la taxonomía produciría
   * una fila del panel con monto y sin nombre.
   */
  it('un valor que no está en la taxonomía se descarta al leer', () => {
    const metadata = readChileMetadata(
      JSON.stringify({
        wealthfolioChile: {
          v: 4,
          fp: 'x',
          inst: 'i',
          parser: 'p',
          parserVersion: '1',
          fileHash: 'h',
          runId: 'r',
          kind: TransactionKind.fee,
          fc: 'no-existe',
        },
      }),
    );
    expect(metadata?.fc).toBeUndefined();
  });
});
