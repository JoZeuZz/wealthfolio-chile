import { describe, expect, it } from 'vitest';
import { buildDuplicateIndex } from '../src/core/dedupe/classify';
import { StatementProduct } from '../src/core/model/statement';
import { prepareImport } from '../src/core/pipeline';
import { readCardFacts } from '../src/core/providers/card-facts';
import { defaultRules } from '../src/core/rules/builtin';
import { fromText } from './fixtures';

/**
 * Extracción de hechos por etiqueta, no por posición.
 *
 * Lo que sí está documentado es **cómo se llama** cada dato: el artículo 26 del
 * reglamento fija las etiquetas — «TOTAL A PAGAR», «PAGAR HASTA», «Pago
 * Mínimo», «Cupo Disponible», «Período de Facturación» — y la página de la CMF
 * enumera los mismos conceptos para el régimen vigente. Lo que no está
 * documentado es dónde queda cada uno en la cartola de un banco chileno de hoy.
 *
 * Por eso se busca la etiqueta en todo el preámbulo y nunca una celda concreta.
 * Un perfil no declara «el pago mínimo está en la fila 4, columna C»: eso sería
 * inventar un formato. La etiqueta viene de la norma; la posición, de la
 * cartola real que todavía no tenemos.
 */
const PREAMBLE = [
  'Banco Generico - Estado de Cuenta Tarjeta de Credito',
  'Fecha del Estado de Cuenta: 20/09/2026',
  'Periodo de Facturacion: 16/08/2026 - 15/09/2026',
  'TOTAL A PAGAR: $412.900',
  'PAGAR HASTA: 05/10/2026',
  'El Pago Minimo es de $35.000',
  'Cupo Total: $1.500.000',
  'Cupo Disponible: $1.087.100',
].join('\n');

const facts = () => readCardFacts({ preamble: PREAMBLE, currency: 'CLP' });

describe('leer lo que el estado de cuenta declara', () => {
  it('lee las tres fechas por su etiqueta', () => {
    const found = facts();
    expect(found.statementDate?.value).toBe('2026-09-20');
    expect(found.dueDate?.value).toBe('2026-10-05');
    expect(found.billingPeriod?.value).toEqual({ from: '2026-08-16', to: '2026-09-15' });
  });

  it('lee los montos por su etiqueta', () => {
    const found = facts();
    expect(found.billedAmount?.value.minor).toBe(412_900);
    expect(found.minimumPayment?.value.minor).toBe(35_000);
    expect(found.creditLimit?.value.minor).toBe(1_500_000);
    expect(found.availableCredit?.value.minor).toBe(1_087_100);
  });

  /**
   * Todo lo que sale de aquí lo dijo el documento. Nada se calcula: un monto
   * facturado sumado de las filas sería una estimación con la autoridad de un
   * hecho declarado, y esa confusión es justo lo que el tipo existe para
   * impedir.
   */
  it('todo lo extraído queda marcado como declarado', () => {
    for (const fact of Object.values(facts())) {
      expect(fact.source).toBe('declared');
    }
  });

  /**
   * El pago mínimo y el cupo total son magnitudes: significan lo mismo con
   * cualquier signo, igual que un `SALDO ANTERIOR $450.000` de tarjeta —que
   * puede ser deuda o saldo a favor y que por eso el parser se niega a leer.
   *
   * El cupo disponible no: en negativo es un cupo excedido, y guardarlo como
   * magnitud informaba holgura donde había sobregiro. Ver
   * `card-facts-review.test.ts`.
   */
  it('el pago mínimo es una magnitud; el cupo disponible conserva su signo', () => {
    const found = readCardFacts({
      preamble: 'Pago Minimo: $-35.000\nCupo Disponible: ($1.087.100)',
      currency: 'CLP',
    });
    expect(found.minimumPayment?.value.minor).toBe(35_000);
    expect(found.availableCredit?.value.minor).toBe(-1_087_100);
  });
});

describe('lo que no está no se inventa', () => {
  it('un preámbulo sin etiquetas no produce ningún hecho', () => {
    expect(readCardFacts({ preamble: 'Banco Generico\nCartola', currency: 'CLP' })).toEqual({});
  });

  /**
   * Ausente es ausente. Un pago mínimo que no aparece no vale cero: cero diría
   * que este mes no hay nada que pagar.
   */
  it('una etiqueta sin cifra al lado no produce un cero', () => {
    const found = readCardFacts({ preamble: 'Pago Minimo:', currency: 'CLP' });
    expect(found.minimumPayment).toBeUndefined();
  });

  it('una cifra ilegible no produce un hecho', () => {
    const found = readCardFacts({ preamble: 'Pago Minimo: no aplica', currency: 'CLP' });
    expect(found.minimumPayment).toBeUndefined();
  });

  it('una fecha imposible no produce un hecho', () => {
    const found = readCardFacts({ preamble: 'PAGAR HASTA: 32/13/2026', currency: 'CLP' });
    expect(found.dueDate).toBeUndefined();
  });
});

describe('etiquetas que se parecen entre sí', () => {
  it('no confunde el cupo total con el disponible', () => {
    const found = readCardFacts({
      preamble: 'Cupo Total: $1.500.000\nCupo Disponible: $200.000',
      currency: 'CLP',
    });
    expect(found.creditLimit?.value.minor).toBe(1_500_000);
    expect(found.availableCredit?.value.minor).toBe(200_000);
  });

  it('no confunde el total a pagar con el pago mínimo', () => {
    const found = readCardFacts({
      preamble: 'TOTAL A PAGAR: $412.900\nPago Minimo: $35.000',
      currency: 'CLP',
    });
    expect(found.billedAmount?.value.minor).toBe(412_900);
    expect(found.minimumPayment?.value.minor).toBe(35_000);
  });

  /**
   * La deuda extranjera sólo se registra si la línea dice en qué moneda está:
   * anotada en la moneda del estado de cuenta quedaba sumable con la nacional
   * sin ningún tipo de cambio.
   */
  it('separa la deuda nacional de la que está en moneda extranjera', () => {
    const found = readCardFacts({
      preamble: 'Deuda Nacional: $300.000\nDeuda en Moneda Extranjera: US$ 1.129,00',
      currency: 'CLP',
    });
    expect(found.domesticDebt?.value.minor).toBe(300_000);
    expect(found.domesticDebt?.value.currency).toBe('CLP');
    expect(found.foreignDebt?.value.currency).toBe('USD');
  });
});

/**
 * Un estado de cuenta trae el nombre del titular, su RUT, su dirección y parte
 * del número de tarjeta. El addon no necesita ninguno de los cuatro, y no
 * modelarlos es la forma más barata de no filtrarlos.
 */
describe('lo que deliberadamente no se lee', () => {
  it('no extrae datos personales aunque estén en el preámbulo', () => {
    const found = readCardFacts({
      preamble: [
        'Nombre del Titular: Juan Perez Gonzalez',
        'RUT: 12.345.678-9',
        'N de Tarjeta: XXXX-XXXX-XXXX-7788',
        'Direccion: Av. Generica 123, Comuna',
        'Pago Minimo: $35.000',
      ].join('\n'),
      currency: 'CLP',
    });

    const serialized = JSON.stringify(found);
    expect(serialized).not.toContain('Juan');
    expect(serialized).not.toContain('12.345.678');
    expect(serialized).not.toContain('7788');
    expect(serialized).not.toContain('Generica');
    expect(found.minimumPayment?.value.minor).toBe(35_000);
  });
});

/**
 * Los hechos son del estado de cuenta de una tarjeta. Una cuenta corriente no
 * factura, no tiene pago mínimo y no tiene cupo: buscar esas etiquetas ahí sólo
 * puede producir falsos positivos.
 */
describe('de punta a punta, desde el archivo', () => {
  const CARD = [
    'Banco Generico - Estado de Cuenta Tarjeta de Credito',
    'Tarjeta N: XXXX-XXXX-XXXX-7788',
    'Periodo de Facturacion: 16/08/2026 - 15/09/2026',
    'TOTAL A PAGAR: $412.900',
    'PAGAR HASTA: 05/10/2026',
    'El Pago Minimo es de $35.000',
    '',
    'Fecha;Descripcion;Monto;Cuotas;Rubro',
    '02/09/2026;SUPERMERCADO GENERICO;45.000;;Alimentacion',
  ].join('\n');

  const ACCOUNT = [
    'Banco Generico - Cartola Cuenta Corriente',
    'Saldo Inicial: 1.000.000',
    'Pago Minimo: $35.000',
    '',
    'Fecha;Descripcion;Cargo;Abono;Saldo',
    '02/09/2026;COMPRA GENERICA;45.000;;955.000',
  ].join('\n');

  const parse = (text: string) =>
    prepareImport({
      file: fromText('cartola.csv', text),
      accountId: 'acct',
      rules: defaultRules(),
      duplicateIndex: buildDuplicateIndex([]),
    }).statement;

  it('un estado de cuenta de tarjeta trae sus hechos', () => {
    const statement = parse(CARD);
    expect(statement.account.product).toBe(StatementProduct.credit_card);
    expect(statement.cardFacts?.minimumPayment?.value.minor).toBe(35_000);
    expect(statement.cardFacts?.dueDate?.value).toBe('2026-10-05');
  });

  /**
   * `PAGO MINIMO` en el preámbulo de una cuenta corriente no es el pago mínimo
   * de esa cuenta: no existe tal cosa. Sería el de una tarjeta mencionada de
   * paso, o texto promocional.
   */
  it('una cartola de cuenta no trae hechos de tarjeta', () => {
    const statement = parse(ACCOUNT);
    expect(statement.account.product).not.toBe(StatementProduct.credit_card);
    expect(statement.cardFacts).toBeUndefined();
  });
});
