import { describe, expect, it } from 'vitest';
import { detectAutomaticMandate } from '../src/core/chile/mandates';
import { findRecurringCharges } from '../src/core/recurring/detect';
import { money } from '../src/core/money';
import { Confidence, Direction, TransactionKind } from '../src/core/model/kinds';
import type { NormalizedTransaction } from '../src/core/model/transaction';
import { normalizeDescription } from '../src/core/text';
import { makeTransaction } from './fixtures';

/**
 * Gasto recurrente.
 *
 * La pregunta que este archivo defiende no es "¿se repite?" sino "¿es un
 * compromiso que sigue corriendo solo?". Una compra en seis cuotas se repite
 * seis veces, el mismo mes del mes, por el mismo monto y en el mismo comercio:
 * cumple todos los criterios estadísticos y no es un gasto recurrente. Un pago
 * de tarjeta también. Por eso la mitad de las pruebas de aquí son exclusiones.
 */

function charge(
  date: string,
  amount: number,
  merchant: string,
  extra: Partial<Omit<NormalizedTransaction, 'amount'>> = {},
): NormalizedTransaction {
  const description = extra.description ?? merchant.toUpperCase();
  return makeTransaction({
    date,
    amount: -amount,
    description,
    normalizedDescription: normalizeDescription(description),
    merchant,
    kind: TransactionKind.expense,
    direction: Direction.out,
    ...extra,
  });
}

const NETFLIX = ['2026-06-05', '2026-07-05', '2026-08-05'] as const;

describe('detectAutomaticMandate', () => {
  it('reconoce un PAC como cargo automático de cuentas', () => {
    expect(detectAutomaticMandate(normalizeDescription('PAC AGUAS ANDINAS'))).toBe('pac');
    expect(detectAutomaticMandate(normalizeDescription('CARGO PAC ENEL DISTRIBUCION'))).toBe('pac');
  });

  it('reconoce un PAT como cargo automático a la tarjeta', () => {
    expect(detectAutomaticMandate(normalizeDescription('PAT ENTEL PCS'))).toBe('pat');
  });

  it('reconoce las formas escritas del mandato', () => {
    expect(detectAutomaticMandate(normalizeDescription('PAGO AUTOMÁTICO VTR'))).toBe('automatico');
    expect(detectAutomaticMandate(normalizeDescription('DEBITO AUTOMATICO SEGURO'))).toBe(
      'automatico',
    );
    expect(detectAutomaticMandate(normalizeDescription('SUSCRIPCION SPOTIFY'))).toBe('automatico');
    expect(detectAutomaticMandate(normalizeDescription('CARGO AUTOMATICO SEGURO'))).toBe(
      'automatico',
    );
    expect(detectAutomaticMandate(normalizeDescription('P.A.C. AGUAS ANDINAS'))).toBe('pac');
    expect(detectAutomaticMandate(normalizeDescription('P.A.T. ENTEL'))).toBe('pat');
    expect(detectAutomaticMandate(normalizeDescription('PAC/PAT SERVICIO'))).toBe('automatico');
  });

  it('no confunde una palabra que empieza igual', () => {
    for (const text of [
      'SEGUROS PACIFICO',
      'IMPACTO PUBLICIDAD',
      'PACK FAMILIAR LIDER',
      'PATIO OUTLET',
      'PATAGONIA STORE',
      'EMPRESA PAT SPA',
      'EMPRESA PAT SERVICIOS SPA',
      'COMPACTO SERVICIOS',
      'SUPERMERCADO PATRONATO',
    ]) {
      expect(detectAutomaticMandate(normalizeDescription(text))).toBeUndefined();
    }
  });

  it('una glosa sin mandato no declara ninguno', () => {
    expect(detectAutomaticMandate(normalizeDescription('COMPRA WEBPAY LIDER'))).toBeUndefined();
  });
});

describe('findRecurringCharges', () => {
  it('tres cargos mensuales sin mandato siguen siendo posibles, no probables', () => {
    const rows = NETFLIX.map((date) => charge(date, 9_900, 'Netflix'));
    const found = findRecurringCharges(rows);

    expect(found).toHaveLength(1);
    expect(found[0]?.merchant).toBe('Netflix');
    expect(found[0]?.confidence).toBe('possible');
    expect(found[0]?.occurrences).toBe(3);
    expect(found[0]?.typicalAmount).toEqual(money(9_900, 0, 'CLP'));
    expect(found[0]?.medianIntervalDays).toBe(30);
  });

  it('dos cargos no bastan sin un mandato declarado por el banco', () => {
    const rows = NETFLIX.slice(0, 2).map((date) => charge(date, 9_900, 'Netflix'));
    expect(findRecurringCharges(rows)).toEqual([]);
  });

  it('dos cargos con mandato se muestran sólo como posibles', () => {
    const rows = ['2026-07-10', '2026-08-10'].map((date) =>
      charge(date, 32_000, 'Aguas Andinas', { description: 'PAC AGUAS ANDINAS' }),
    );
    const found = findRecurringCharges(rows);

    expect(found).toHaveLength(1);
    expect(found[0]?.mandate).toBe('pac');
    expect(found[0]?.confidence).toBe('possible');
  });

  it('tres cargos con mandato y cadencia estable sí son probables', () => {
    const rows = NETFLIX.map((date) =>
      charge(date, 32_000, 'Aguas Andinas', { description: 'PAC AGUAS ANDINAS' }),
    );

    expect(findRecurringCharges(rows)[0]?.confidence).toBe('likely');
  });

  it('un mandato parcial o contradictorio no refuerza el patrón', () => {
    const partial = NETFLIX.map((date, index) =>
      charge(date, 32_000, 'Servicio', {
        description: index === 0 ? 'PAC SERVICIO' : 'SERVICIO',
      }),
    );
    const conflicting = NETFLIX.map((date, index) =>
      charge(date, 32_000, 'Servicio', {
        description: index === 1 ? 'PAT SERVICIO' : 'PAC SERVICIO',
      }),
    );

    expect(findRecurringCharges(partial)[0]?.confidence).toBe('possible');
    expect(findRecurringCharges(partial)[0]?.mandate).toBeUndefined();
    expect(findRecurringCharges(conflicting)[0]?.confidence).toBe('possible');
    expect(findRecurringCharges(conflicting)[0]?.mandate).toBeUndefined();
  });

  it('dos cargos necesitan mandato compatible en ambos', () => {
    const rows = ['2026-07-10', '2026-08-10'].map((date, index) =>
      charge(date, 32_000, 'Servicio', {
        description: index === 0 ? 'PAC SERVICIO' : 'SERVICIO',
      }),
    );

    expect(findRecurringCharges(rows)).toEqual([]);
  });

  it('dos cargos con mandato exigen la cadencia estrecha', () => {
    // 44 días entra en la ventana ancha, pero con un solo intervalo medido no
    // hay con qué distinguir un mandato de dos compras sueltas en un comercio
    // que lleva la sigla en su propio nombre.
    const rows = ['2026-06-10', '2026-07-24'].map((date) =>
      charge(date, 32_000, 'Pat Industrial', { description: 'PAT INDUSTRIAL SOLUTIONS' }),
    );
    expect(findRecurringCharges(rows)).toEqual([]);
  });

  it('un solo cargo nunca es recurrente, ni con mandato', () => {
    expect(
      findRecurringCharges([
        charge('2026-08-10', 32_000, 'Aguas Andinas', { description: 'PAC AGUAS ANDINAS' }),
      ]),
    ).toEqual([]);
  });

  it('un monto que varía mucho baja a posible, no desaparece', () => {
    const rows = [
      charge('2026-06-05', 30_000, 'Enel'),
      charge('2026-07-05', 42_000, 'Enel'),
      charge('2026-08-05', 36_000, 'Enel'),
    ];
    const found = findRecurringCharges(rows);

    expect(found).toHaveLength(1);
    expect(found[0]?.confidence).toBe('possible');
    expect(found[0]?.amountSpread).toBeGreaterThan(0.15);
  });

  it('un monto errático no es recurrencia', () => {
    const rows = [
      charge('2026-06-05', 5_000, 'Copec'),
      charge('2026-07-05', 60_000, 'Copec'),
      charge('2026-08-05', 12_000, 'Copec'),
    ];
    expect(findRecurringCharges(rows)).toEqual([]);
  });

  it('un comercio visitado seguido no es una suscripción', () => {
    const rows = [
      charge('2026-08-01', 9_000, 'Lider'),
      charge('2026-08-08', 9_000, 'Lider'),
      charge('2026-08-15', 9_000, 'Lider'),
      charge('2026-08-22', 9_000, 'Lider'),
    ];
    expect(findRecurringCharges(rows)).toEqual([]);
  });

  it('acepta deriva mensual normal y rechaza una cadencia rota', () => {
    const monthly = ['2026-04-01', '2026-04-28', '2026-05-30', '2026-06-29'].map((date) =>
      charge(date, 9_900, 'Netflix'),
    );
    const broken = ['2026-01-01', '2026-01-06', '2026-02-05', '2026-04-06'].map((date) =>
      charge(date, 9_900, 'Netflix'),
    );

    expect(findRecurringCharges(monthly)).toHaveLength(1);
    expect(findRecurringCharges(broken)).toEqual([]);
  });

  it('no fusiona comercios distintos aunque cobren lo mismo', () => {
    const rows = NETFLIX.map((date, index) =>
      charge(date, 9_900, index === 1 ? 'Spotify' : 'Netflix'),
    );

    expect(findRecurringCharges(rows)).toEqual([]);
  });

  describe('exclusiones', () => {
    it('una compra en cuotas no es un gasto recurrente', () => {
      const rows = NETFLIX.map((date, index) =>
        charge(date, 39_990, 'Falabella', {
          description: `FALABELLA CUOTA ${index + 1} DE 6`,
          installment: {
            current: index + 1,
            total: 6,
            confidence: Confidence.confirmed,
            matchedText: `CUOTA ${index + 1} DE 6`,
          },
        }),
      );
      expect(findRecurringCharges(rows)).toEqual([]);
    });

    it('una cuota histórica bare de tarjeta tampoco es recurrente', () => {
      const rows = NETFLIX.map((date, index) =>
        charge(date, 39_990, 'Falabella', {
          description: `FALABELLA ${index + 1}/6`,
          kind: TransactionKind.credit_card_purchase,
        }),
      );

      expect(findRecurringCharges(rows)).toEqual([]);
    });

    it('un contador bare inequívoco tampoco es recurrencia fuera de tarjeta', () => {
      const rows = NETFLIX.map((date, index) =>
        charge(date, 39_990, 'Falabella', {
          description: `FALABELLA ${index + 1}/24`,
        }),
      );

      expect(findRecurringCharges(rows)).toEqual([]);
    });

    it('un traspaso entre cuentas propias tampoco', () => {
      const rows = NETFLIX.map((date) =>
        charge(date, 200_000, 'Traspaso', { kind: TransactionKind.internal_transfer }),
      );
      expect(findRecurringCharges(rows)).toEqual([]);
    });

    it('un pago de tarjeta mensual tampoco', () => {
      const rows = NETFLIX.map((date) =>
        charge(date, 350_000, 'Pago Tarjeta', { kind: TransactionKind.credit_card_payment }),
      );
      expect(findRecurringCharges(rows)).toEqual([]);
    });

    it('una devolución mensual tampoco', () => {
      const rows = NETFLIX.map((date) =>
        makeTransaction({
          date,
          amount: 9_900,
          description: 'DEVOLUCION NETFLIX',
          merchant: 'Netflix',
          kind: TransactionKind.refund,
          direction: Direction.in,
        }),
      );
      expect(findRecurringCharges(rows)).toEqual([]);
    });

    it('una devolución no rompe ni refuerza una recurrencia real', () => {
      const rows = [
        ...NETFLIX.map((date) => charge(date, 9_900, 'Netflix')),
        makeTransaction({
          date: '2026-07-20',
          amount: 9_900,
          description: 'DEVOLUCION NETFLIX',
          merchant: 'Netflix',
          kind: TransactionKind.refund,
          direction: Direction.in,
        }),
      ];
      const found = findRecurringCharges(rows);

      expect(found).toHaveLength(1);
      expect(found[0]?.occurrences).toBe(3);
    });

    it('un movimiento sin comercio no puede agruparse', () => {
      const rows = NETFLIX.map((date) => {
        const row: Record<string, unknown> = { ...charge(date, 9_900, 'Netflix') };
        delete row.merchant;
        return row as unknown as NormalizedTransaction;
      });
      expect(findRecurringCharges(rows)).toEqual([]);
    });

    it('un comercio vacío o genérico no puede fusionar cargos ajenos', () => {
      expect(findRecurringCharges(NETFLIX.map((date) => charge(date, 9_900, '   ')))).toEqual([]);
      expect(findRecurringCharges(NETFLIX.map((date) => charge(date, 9_900, 'Compra')))).toEqual([]);
      expect(findRecurringCharges(NETFLIX.map((date) => charge(date, 9_900, 'Compra.')))).toEqual(
        [],
      );
      expect(
        findRecurringCharges(
          NETFLIX.map((date) => charge(date, 9_900, 'PAC', { description: 'PAC SERVICIO' })),
        ),
      ).toEqual([]);
    });

    it('un movimiento de monto cero no constituye un cargo', () => {
      const rows = NETFLIX.map((date) => ({
        ...charge(date, 9_900, 'Netflix'),
        amount: money(0, 0, 'CLP'),
      }));

      expect(findRecurringCharges(rows)).toEqual([]);
    });
  });

  describe('invariantes', () => {
    it('permutar la entrada no cambia el resultado', () => {
      const rows = [
        ...NETFLIX.map((date) => charge(date, 9_900, 'Netflix')),
        ...['2026-06-12', '2026-07-12', '2026-08-12'].map((date) =>
          charge(date, 45_000, 'Entel', { description: 'PAT ENTEL' }),
        ),
        charge('2026-08-02', 3_500, 'Cafe'),
      ];
      const forward = findRecurringCharges(rows);
      const reversed = findRecurringCharges([...rows].reverse());
      const rotated = findRecurringCharges([...rows.slice(3), ...rows.slice(0, 3)]);

      expect(reversed).toEqual(forward);
      expect(rotated).toEqual(forward);
      expect(forward.length).toBe(2);
    });

    it('un movimiento no relacionado no destruye un patrón', () => {
      const base = NETFLIX.map((date) => charge(date, 9_900, 'Netflix'));
      const withNoise = [...base, charge('2026-07-19', 120_000, 'Sodimac')];

      expect(findRecurringCharges(withNoise)).toEqual(findRecurringCharges(base));
    });

    it('dos monedas nunca se agrupan en el mismo patrón', () => {
      const clp = NETFLIX.map((date) => charge(date, 9_900, 'Netflix'));
      const usd = NETFLIX.map((date) => ({
        ...charge(date, 999, 'Netflix'),
        amount: money(-999, 2, 'USD'),
      }));
      const found = findRecurringCharges([...clp, ...usd]);

      expect(found).toHaveLength(2);
      expect(new Set(found.map((entry) => entry.currency))).toEqual(new Set(['CLP', 'USD']));
    });

    it('cada patrón lleva las huellas de los cargos que lo prueban', () => {
      const rows = NETFLIX.map((date) => charge(date, 9_900, 'Netflix'));
      const found = findRecurringCharges(rows);

      expect(found[0]?.fingerprints).toEqual([...rows.map((row) => row.fingerprint)].sort());
    });

    it('el umbral de 15 por ciento se decide con los enteros de Money', () => {
      const amounts = [money(-200, 2, 'CLP'), money(-200, 2, 'CLP'), money(-170, 2, 'CLP')];
      const rows = NETFLIX.map((date, index) => ({
        ...charge(date, 1, 'Servicio', { description: 'PAC SERVICIO' }),
        amount: amounts[index] as (typeof amounts)[number],
      }));

      expect(findRecurringCharges(rows)[0]?.confidence).toBe('likely');
    });

    it('la opción de mínimo no permite dos cargos sin mandato', () => {
      const rows = NETFLIX.slice(0, 2).map((date) => charge(date, 9_900, 'Netflix'));

      expect(findRecurringCharges(rows, { minOccurrences: 2 })).toEqual([]);
    });
  });
});
