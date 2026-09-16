import { describe, expect, it } from 'vitest';
import { buildDuplicateIndex, classifyDuplicate, type ExistingMovement } from '../src/core/dedupe/classify';
import { hashFields } from '../src/core/hash';
import { descriptionKey } from '../src/core/text';
import { computeFingerprint, computeWeakFingerprint } from '../src/core/dedupe/fingerprint';
import {
  readChileMetadata,
  toActivityCreate,
  type ChileMetadata,
} from '../src/core/mapping/activities';
import { money, toDecimalString } from '../src/core/money';
import { Direction, TransactionKind } from '../src/core/model/kinds';
import type { NormalizedTransaction } from '../src/core/model/transaction';
import {
  activityDateFilters,
  loadDuplicateIndex,
  loadDuplicateIndexResult,
} from '../src/services/activity-index';
import { makeTransaction } from './fixtures';
import { accountStub, activityStub, fakeHost } from './host';

/**
 * The duplicate index, read back from a live host.
 *
 * These tests cover the seam where a wrong answer is invisible: the index looks
 * fine, the import succeeds, and the user finds the same expense twice a month
 * later.
 */

const ACCOUNT = 'acc-1';
const SCOPE = { accountId: ACCOUNT };

function ourMetadata(overrides: { fp: string; wfp?: string; kind?: TransactionKind }) {
  return {
    fp: overrides.fp,
    ...(overrides.wfp ? { wfp: overrides.wfp } : {}),
    inst: 'banco-chile',
    parser: 'banco-chile.cartola-csv',
    parserVersion: '1.0.0',
    fileHash: 'file-hash',
    runId: 'run-1',
    kind: overrides.kind ?? TransactionKind.expense,
  };
}

/**
 * Store a transaction the way the addon really does: through the writer, not by
 * hand. A stub can agree with a reader that both get the sign wrong.
 */
function writeAsAddonWould(transaction: NormalizedTransaction) {
  const create = toActivityCreate(transaction, {
    accountId: ACCOUNT,
    runId: 'run-1',
    weakFingerprint: computeWeakFingerprint(transaction, SCOPE),
  });

  return activityStub({
    accountId: ACCOUNT,
    activityType: create.activityType,
    ...(create.subtype ? { subtype: create.subtype } : {}),
    amount: String(create.amount),
    currency: create.currency ?? 'CLP',
    date: String(create.activityDate),
    comment: create.comment ?? '',
    metadata: readChileMetadata(create.metadata) as ChileMetadata,
  });
}

describe('loadDuplicateIndex', () => {
  it('indexes exact and weak fingerprints from activity metadata', async () => {
    const host = fakeHost({
      activities: [
        activityStub({
          activityType: 'WITHDRAWAL',
          amount: '85400',
          date: '2026-03-06',
          comment: 'SUPERMERCADO',
          metadata: ourMetadata({ fp: 'fp-exact', wfp: 'wfp-weak' }),
        }),
      ],
    });

    const result = await loadDuplicateIndexResult(host.ctx, { accountId: ACCOUNT });

    expect(result.scanned).toBe(1);
    expect(result.truncated).toBe(false);
    expect(result.index.byFingerprint.get('fp-exact')?.activityId).toBeDefined();
    expect(result.index.byWeakFingerprint.get('wfp-weak')).toHaveLength(1);
  });

  it('reconstructs a signed amount from the activity type', async () => {
    const host = fakeHost({
      activities: [
        activityStub({
          activityType: 'WITHDRAWAL',
          amount: '85400',
          date: '2026-03-06',
          metadata: ourMetadata({ fp: 'out' }),
        }),
        activityStub({
          activityType: 'DEPOSIT',
          amount: '1000000',
          date: '2026-03-05',
          metadata: ourMetadata({ fp: 'in', kind: TransactionKind.income }),
        }),
        activityStub({
          activityType: 'TRANSFER_OUT',
          amount: '200000',
          date: '2026-03-07',
          metadata: ourMetadata({ fp: 'xfer-out', kind: TransactionKind.internal_transfer }),
        }),
        activityStub({
          activityType: 'TRANSFER_IN',
          amount: '200000',
          date: '2026-03-07',
          metadata: ourMetadata({ fp: 'xfer-in', kind: TransactionKind.internal_transfer }),
        }),
      ],
    });

    const { index } = await loadDuplicateIndexResult(host.ctx, { accountId: ACCOUNT });

    expect(index.byFingerprint.get('out')?.amount).toEqual(money(-85400, 0, 'CLP'));
    expect(index.byFingerprint.get('in')?.amount).toEqual(money(1000000, 0, 'CLP'));
    expect(index.byFingerprint.get('xfer-out')?.amount).toEqual(money(-200000, 0, 'CLP'));
    expect(index.byFingerprint.get('xfer-in')?.amount).toEqual(money(200000, 0, 'CLP'));
  });

  /**
   * `activityDetailsToSignedMoney` lee un `INTEREST` crudo en cuenta tarjeta
   * como cargo (`activityFlowSign`, `core/mapping/activities.ts`). Este índice
   * tiene que leer esa misma fila con el mismo signo — si no, un interés
   * cobrado que alguien editó a mano en una tarjeta entra al índice como
   * `+15000` mientras `imported-transactions.ts` (y el propio import) lo lee
   * como `-15000`: la reimportación de la misma cartola no lo encuentra y
   * escribe una segunda copia.
   */
  it('firma un INTEREST crudo en tarjeta con el mismo signo que el resto del pipeline', async () => {
    const host = fakeHost({
      accounts: [accountStub({ id: ACCOUNT, accountType: 'CREDIT_CARD' })],
      activities: [
        activityStub({
          accountId: ACCOUNT,
          activityType: 'INTEREST',
          amount: '15000',
          date: '2026-03-06',
          comment: 'INTERES TARJETA',
          // Sin metadata nuestra: editado a mano en Wealthfolio o escrito por
          // otra vía, exactamente el caso que dispara el bug.
          metadata: undefined,
        }),
      ],
    });

    const { index } = await loadDuplicateIndexResult(host.ctx, { accountId: ACCOUNT });

    expect(index.byWeakFingerprint.size).toBe(1);
    const [entry] = [...index.byWeakFingerprint.values()].flat();
    expect(entry?.amount).toEqual(money(-15000, 0, 'CLP'));
  });

  it('reads a null amount as zero instead of failing the whole scan', async () => {
    const host = fakeHost({
      activities: [
        activityStub({
          activityType: 'UNKNOWN',
          amount: null as unknown as string,
          date: '2026-03-06',
          metadata: ourMetadata({ fp: 'empty' }),
        }),
      ],
    });

    const { index } = await loadDuplicateIndexResult(host.ctx, { accountId: ACCOUNT });
    expect(index.byFingerprint.get('empty')?.amount).toEqual(money(0, 0, 'CLP'));
  });

  it('keeps activities that are not ours, so weak matching still sees them', async () => {
    // El título decía esto y la aserción decía lo contrario: `byWeakFingerprint`
    // vacío es precisamente «el matching débil **no** las ve». La actividad se
    // cargaba y quedaba inalcanzable.
    const host = fakeHost({
      activities: [
        activityStub({ activityType: 'WITHDRAWAL', amount: '5000', date: '2026-03-06' }),
      ],
    });

    const result = await loadDuplicateIndexResult(host.ctx, { accountId: ACCOUNT });

    expect(result.scanned).toBe(1);
    // Sin metadata nuestra no hay huella fuerte: eso sigue igual, y debe seguir.
    expect(result.index.byFingerprint.size).toBe(0);
    // Pero la débil se deriva de la cuenta, el día y el monto, que el host sí da.
    expect(result.index.byWeakFingerprint.size).toBe(1);
  });
});

/**
 * P1 (review independiente): dedupe histórico Banco de Chile tarjeta.
 *
 * `ExistingMovement` sólo conservaba `fingerprint`/`weakFingerprint` — nunca
 * `parser`/`parserVersion`/`fileHash`, aunque esos tres campos ya viven en
 * `ChileMetadata` desde 0.1.0. Sin ellos, `classifyDuplicate` no tiene cómo
 * reconocer "este archivo ya se importó antes bajo una semántica de monto
 * incompatible" — ver `dedupe-legacy-source-conflict.test.ts` para el
 * escenario completo. Este describe cubre sólo que la provenance sobrevive
 * la lectura del índice.
 */
describe('provenance preservada en el índice', () => {
  it('parser, parserVersion y fileHash llegan al ExistingMovement', async () => {
    const host = fakeHost({
      activities: [
        activityStub({
          activityType: 'WITHDRAWAL',
          amount: '12450',
          date: '2026-02-05',
          metadata: ourMetadata({ fp: 'fp-legacy' }),
        }),
      ],
    });

    const { index } = await loadDuplicateIndexResult(host.ctx, { accountId: ACCOUNT });

    const byFingerprint = index.byFingerprint.get('fp-legacy');
    expect(byFingerprint?.parser).toBe('banco-chile.cartola-csv');
    expect(byFingerprint?.parserVersion).toBe('1.0.0');
    expect(byFingerprint?.fileHash).toBe('file-hash');

    // Y también indexado por fileHash, que es lo que el guard de dedupe
    // histórico necesita para encontrarlo sin conocer de antemano su huella.
    expect(index.byFileHash.get('file-hash')).toHaveLength(1);
    expect(index.byFileHash.get('file-hash')?.[0]?.activityId).toBe(byFingerprint?.activityId);
  });

  it('una actividad sin metadata nuestra no aporta fileHash (no hay de dónde sacarlo)', async () => {
    const host = fakeHost({
      activities: [
        activityStub({ activityType: 'WITHDRAWAL', amount: '5000', date: '2026-03-06' }),
      ],
    });

    const { index } = await loadDuplicateIndexResult(host.ctx, { accountId: ACCOUNT });
    expect(index.byFileHash.size).toBe(0);
  });
});

describe('pagination', () => {
  it('walks every page until the host reports no more rows', async () => {
    const activities = Array.from({ length: 1250 }, (_, i) =>
      activityStub({
        activityType: 'WITHDRAWAL',
        amount: '1000',
        date: '2026-03-06',
        metadata: ourMetadata({ fp: `fp-${i}` }),
      }),
    );
    const host = fakeHost({ activities });

    const result = await loadDuplicateIndexResult(host.ctx, { accountId: ACCOUNT });

    expect(result.scanned).toBe(1250);
    expect(result.totalRowCount).toBe(1250);
    expect(result.truncated).toBe(false);
    expect(host.searchCalls.map((call) => call.page)).toEqual([0, 1, 2]);
  });

  it('stops on the first short page without asking for another', async () => {
    const host = fakeHost({
      activities: [
        activityStub({
          activityType: 'WITHDRAWAL',
          amount: '1000',
          date: '2026-03-06',
          metadata: ourMetadata({ fp: 'only' }),
        }),
      ],
    });

    await loadDuplicateIndexResult(host.ctx, { accountId: ACCOUNT });
    expect(host.searchCalls).toHaveLength(1);
  });

  it('reports truncation instead of silently returning a partial index', async () => {
    // 40 pages of 500 is the cap; the host holds one row more than that.
    const activities = Array.from({ length: 20_001 }, (_, i) =>
      activityStub({
        activityType: 'WITHDRAWAL',
        amount: '1000',
        date: '2026-03-06',
        metadata: ourMetadata({ fp: `fp-${i}` }),
      }),
    );
    const host = fakeHost({ activities });

    const result = await loadDuplicateIndexResult(host.ctx, { accountId: ACCOUNT });

    expect(result.truncated).toBe(true);
    expect(result.scanned).toBe(20_000);
    expect(result.totalRowCount).toBe(20_001);
  });
});

describe('filters sent to the host', () => {
  it('uses the dateFrom/dateTo names v3.6.2 actually reads, padded by a day', () => {
    expect(
      activityDateFilters({ accountId: ACCOUNT, fromDate: '2026-03-01', toDate: '2026-03-31' }),
    ).toEqual({ accountIds: ACCOUNT, dateFrom: '2026-02-28', dateTo: '2026-04-01' });
  });

  it('omits bounds that were not asked for', () => {
    expect(activityDateFilters({ accountId: ACCOUNT })).toEqual({ accountIds: ACCOUNT });
    expect(activityDateFilters({})).toEqual({});
  });

  it('narrows the scan to the requested window', async () => {
    const host = fakeHost({
      activities: [
        activityStub({
          activityType: 'WITHDRAWAL',
          amount: '1000',
          date: '2026-01-15',
          metadata: ourMetadata({ fp: 'january' }),
        }),
        activityStub({
          activityType: 'WITHDRAWAL',
          amount: '2000',
          date: '2026-03-15',
          metadata: ourMetadata({ fp: 'march' }),
        }),
      ],
    });

    const { index } = await loadDuplicateIndexResult(host.ctx, {
      accountId: ACCOUNT,
      fromDate: '2026-03-01',
      toDate: '2026-03-31',
    });

    expect(index.byFingerprint.has('march')).toBe(true);
    expect(index.byFingerprint.has('january')).toBe(false);
    expect(host.searchCalls[0]?.filters).toEqual({
      accountIds: ACCOUNT,
      dateFrom: '2026-02-28',
      dateTo: '2026-04-01',
    });
  });

  /**
   * Observed on a real Wealthfolio v3.6.2 container on 2026-08-07: the backend
   * reads `dateFrom`/`dateTo` in the instance timezone while storing our bare
   * `YYYY-MM-DD` activity dates at UTC midnight, so under `America/Santiago`
   * the whole window comes back slid a day forward. A movement on the first day
   * of the window then never reaches the index, the import calls it new, and the
   * user gets it twice.
   */
  it('still sees the edges of the window when the host slides it a day', async () => {
    const host = fakeHost({
      dateFilterShiftDays: 1,
      activities: [
        activityStub({
          activityType: 'WITHDRAWAL',
          amount: '1000',
          date: '2026-03-01',
          metadata: ourMetadata({ fp: 'primer-dia' }),
        }),
        activityStub({
          activityType: 'WITHDRAWAL',
          amount: '2000',
          date: '2026-03-31',
          metadata: ourMetadata({ fp: 'ultimo-dia' }),
        }),
      ],
    });

    const { index } = await loadDuplicateIndexResult(host.ctx, {
      accountId: ACCOUNT,
      fromDate: '2026-03-01',
      toDate: '2026-03-31',
    });

    expect(index.byFingerprint.has('primer-dia')).toBe(true);
    expect(index.byFingerprint.has('ultimo-dia')).toBe(true);
  });

  it('drops what the padding dragged in beyond the window', async () => {
    const host = fakeHost({
      activities: [
        activityStub({
          activityType: 'WITHDRAWAL',
          amount: '1000',
          date: '2026-02-28',
          metadata: ourMetadata({ fp: 'vispera' }),
        }),
        activityStub({
          activityType: 'WITHDRAWAL',
          amount: '2000',
          date: '2026-03-01',
          metadata: ourMetadata({ fp: 'dentro' }),
        }),
        activityStub({
          activityType: 'WITHDRAWAL',
          amount: '3000',
          date: '2026-04-01',
          metadata: ourMetadata({ fp: 'siguiente' }),
        }),
      ],
    });

    const result = await loadDuplicateIndexResult(host.ctx, {
      accountId: ACCOUNT,
      fromDate: '2026-03-01',
      toDate: '2026-03-31',
    });

    expect(result.index.byFingerprint.has('dentro')).toBe(true);
    expect(result.index.byFingerprint.has('vispera')).toBe(false);
    expect(result.index.byFingerprint.has('siguiente')).toBe(false);
    expect(result.scanned).toBe(1);
  });

  it('only reads the requested account', async () => {
    const host = fakeHost({
      activities: [
        activityStub({
          accountId: 'acc-2',
          activityType: 'WITHDRAWAL',
          amount: '1000',
          date: '2026-03-15',
          metadata: ourMetadata({ fp: 'other-account' }),
        }),
      ],
    });

    const { index } = await loadDuplicateIndexResult(host.ctx, { accountId: ACCOUNT });
    expect(index.byFingerprint.size).toBe(0);
  });
});

describe('failure', () => {
  it('propagates a host error rather than returning an empty index', async () => {
    const host = fakeHost();
    host.searchError = new Error('backend unavailable');

    await expect(loadDuplicateIndex(host.ctx, { accountId: ACCOUNT })).rejects.toThrow(
      'backend unavailable',
    );
  });
});

describe('end to end: index feeds classification', () => {
  it('flags an exact re-import and a probable near-match from real host rows', async () => {
    const original = makeTransaction({
      date: '2026-03-06',
      amount: -85_400,
      description: 'SUPERMERCADO LIDER',
      kind: TransactionKind.expense,
      direction: Direction.out,
    });
    const fingerprint = computeFingerprint(original, SCOPE);
    const weak = computeWeakFingerprint(original, SCOPE);

    const host = fakeHost({
      activities: [
        activityStub({
          activityType: 'WITHDRAWAL',
          amount: '85400',
          date: '2026-03-06',
          comment: 'SUPERMERCADO LIDER',
          metadata: ourMetadata({ fp: fingerprint, wfp: weak }),
        }),
      ],
    });

    const index = await loadDuplicateIndex(host.ctx, { accountId: ACCOUNT });

    const exact = classifyDuplicate({ ...original, fingerprint }, index, SCOPE, new Map());
    expect(exact.verdict).toBe('exact');

    const drifted = makeTransaction({
      date: '2026-03-06',
      amount: -85_400,
      description: 'SUPERMERCADO LIDER LOCAL 22',
      kind: TransactionKind.expense,
      direction: Direction.out,
    });
    const probable = classifyDuplicate(
      { ...drifted, fingerprint: computeFingerprint(drifted, SCOPE) },
      index,
      SCOPE,
      new Map(),
    );
    expect(probable.verdict).toBe('probable');
  });

  /**
   * The same path for a row nothing classified.
   *
   * Written through the real `toActivityCreate()` rather than a hand-made stub,
   * because the bug lived precisely in what the writer produces: an outgoing
   * 4.500 becomes `UNKNOWN` with `amount = 4500`, and before `metadata.dir`
   * existed the index rebuilt it as `+4500` and matched nothing.
   */
  it('flags a drifted re-import of an UNKNOWN outflow as probable', async () => {
    const source = makeTransaction({
      date: '2026-03-01',
      amount: -4_500,
      description: 'CARGO NO RECONOCIDO 4471',
      kind: TransactionKind.unknown,
      direction: Direction.out,
    });
    const original = { ...source, fingerprint: computeFingerprint(source, SCOPE) };

    const stored = writeAsAddonWould(original);
    expect(stored.activityType).toBe('UNKNOWN');
    expect(stored.amount).toBe('4500');

    const host = fakeHost({ activities: [stored] });
    const index = await loadDuplicateIndex(host.ctx, { accountId: ACCOUNT });

    expect(index.byFingerprint.get(original.fingerprint)?.amount).toEqual(money(-4_500, 0, 'CLP'));

    // The bank re-exports the same charge with a longer glosa: the exact
    // fingerprint no longer matches, so only the signed amount can catch it.
    const reExported = makeTransaction({
      date: '2026-03-01',
      amount: -4_500,
      description: 'CARGO NO RECONOCIDO 4471 REF',
      kind: TransactionKind.unknown,
      direction: Direction.out,
    });
    const candidate = { ...reExported, fingerprint: computeFingerprint(reExported, SCOPE) };
    expect(candidate.fingerprint).not.toBe(original.fingerprint);

    const finding = classifyDuplicate(candidate, index, SCOPE, new Map());

    expect(finding.verdict).toBe('probable');
    expect(finding.existingActivityId).toBe(stored.id);
  });
});

/**
 * El índice tiene que ver todo lo que ya está en la cuenta.
 *
 * `loadDuplicateIndexResult` lee **todas** las actividades de la ventana y ya
 * tiene de cada una la cuenta, la fecha, el monto, la moneda y el comentario —
 * todo lo que `computeWeakFingerprint` necesita. Pero sólo poblaba las claves
 * desde nuestra propia metadata, así que un movimiento que este addon no
 * escribió entraba al índice y quedaba estructuralmente inalcanzable: ni
 * `exact` ni `probable` podían encontrarlo.
 *
 * El caso concreto: alguien prueba el importador CSV que trae Wealthfolio con
 * su cartola de agosto, no le convence, instala este addon e importa el mismo
 * archivo. Todas las filas volvían «Nuevo», el botón quedaba habilitado, y la
 * tarjeta de resultado le decía que reimportar no duplicaría nada.
 */
describe('movimientos que no escribió este addon', () => {
  it('entran al índice como candidatos a duplicado probable', async () => {
    const host = fakeHost({
      activities: [
        activityStub({
          id: 'act-ajena',
          accountId: 'acc-1',
          activityType: 'WITHDRAWAL',
          amount: '85400',
          date: '2026-02-04',
          comment: 'COMPRA INT WEBPAY TRANSBANK SUPERMERCADO LIDER LAS CONDES',
          // Sin metadata: la escribió el importador del propio Wealthfolio.
          metadata: undefined,
        }),
      ],
    });

    const result = await loadDuplicateIndexResult(host.ctx, { accountId: 'acc-1' });

    expect(result.scanned).toBe(1);
    expect(result.index.byWeakFingerprint.size).toBe(1);
  });

  it('y una reimportación del mismo movimiento ya no dice «nuevo»', async () => {
    const host = fakeHost({
      activities: [
        activityStub({
          id: 'act-ajena',
          accountId: 'acc-1',
          activityType: 'WITHDRAWAL',
          amount: '85400',
          date: '2026-02-04',
          comment: 'COMPRA INT WEBPAY TRANSBANK SUPERMERCADO LIDER LAS CONDES',
          metadata: undefined,
        }),
      ],
    });

    const { index } = await loadDuplicateIndexResult(host.ctx, { accountId: 'acc-1' });
    const scope = { accountId: 'acc-1' };
    const candidate = {
      ...makeTransaction({
        amount: -85400,
        date: '2026-02-04',
        description: 'COMPRA INT WEBPAY TRANSBANK SUPERMERCADO LIDER LAS CONDES',
      }),
      fingerprint: '',
    };

    const finding = classifyDuplicate(candidate, index, scope, new Map());

    expect(finding.verdict).toBe('probable');
    expect(finding.existingActivityId).toBe('act-ajena');
  });
});

/**
 * Las huellas que escribió 0.1.x tienen que seguir encontrándose.
 *
 * `7f93a0b` cambió la receta para que la escala decimal dejara de formar parte
 * de la identidad, y afirmó que las filas de 0.1.x seguirían coincidiendo
 * «porque para un monto sin fracción las dos formas son idénticas». Cierto —
 * pero 0.1.x escribió `toDecimalString`, así que un movimiento parseado de
 * `49.990,50` quedó guardado como `fp(…"49990.50"…)` y la receta nueva hashea
 * `"49990.5"`.
 *
 * Peor: el índice prefiere `metadata.wfp` sobre la huella derivada, así que
 * para **nuestras propias** filas antiguas la vía débil tampoco rescata nada.
 * El resultado es `nuevo`, marcado por defecto: una segunda copia completa de
 * cada cartola con céntimos.
 */
/**
 * P1 (review independiente): `installmentRemaining` stale viola host
 * authority en `ActivityIndex`/dedupe.
 *
 * `loadDuplicateIndexResult` ya calcula `modified` (via `wasModifiedAfterImport`,
 * la misma regla de frescura que `activityToTransaction` aplica con
 * `metadataCacheIsCurrent`/`activityProjection`) y lo usa para decidir si el
 * MONTO cacheado sigue siendo de fiar. Pero `metadata.cuotaRem` se copiaba a
 * `ExistingMovement.installmentRemaining` sin consultar `modified` — así que
 * una Activity editada en Wealthfolio (glosa corregida a mano, por ejemplo)
 * seguía aportando un `installmentRemaining` de un snapshot que ya no existe.
 * `classifyDuplicate` usa ese campo para decidir "ciclo distinto, no
 * comparar por similitud" (`core/dedupe/classify.ts`), así que un
 * `cuotaRem` stale podía hacer que un duplicado real saliera `new` en vez de
 * `probable`.
 *
 * El repro edita sólo `comment` (no fecha/monto): la receta de
 * `weakFingerprint` (`weakFingerprintOf`) sólo depende de cuenta/fecha/monto,
 * así que tocar sólo la glosa deja el bucket débil intacto y aísla el bug de
 * `installmentRemaining` sin arrastrar ninguna staleness de `weakFingerprint`
 * (fuera de alcance de este P1).
 */
describe('P1: cuotaRem stale no participa en dedupe tras una edición del host', () => {
  function cuotaTransaction(installmentRemaining: number) {
    return makeTransaction({
      amount: -49990,
      date: '2026-09-04',
      description: 'FALABELLA RETAIL PLAZA VESPUCIO',
      kind: TransactionKind.credit_card_purchase,
      installmentRemaining,
    });
  }

  it('cuotaRem fresca (Activity no editada) sobrevive el roundtrip al índice', async () => {
    const original = cuotaTransaction(5);
    const stored = writeAsAddonWould(original);

    const { index } = await loadDuplicateIndexResult(fakeHost({ activities: [stored] }).ctx, {
      accountId: ACCOUNT,
    });

    expect(index.byFingerprint.get(original.fingerprint)?.installmentRemaining).toBe(5);
  });

  it('cuotaRem=0 sobrevive el roundtrip sin perderse por truthiness', async () => {
    const original = cuotaTransaction(0);
    const stored = writeAsAddonWould(original);

    const { index } = await loadDuplicateIndexResult(fakeHost({ activities: [stored] }).ctx, {
      accountId: ACCOUNT,
    });

    expect(index.byFingerprint.get(original.fingerprint)?.installmentRemaining).toBe(0);
  });

  it('cuotaRem se descarta del índice cuando el host editó la Activity después del import', async () => {
    const original = cuotaTransaction(5);
    const stored = writeAsAddonWould(original);

    // Edición económica en Wealthfolio: sólo la glosa cambia. Sigue siendo una
    // edición real según `activityProjection` (el comment es parte de la
    // proyección), y `metadata.cuotaRem` no se toca — queda stale.
    const edited = { ...stored, comment: 'FALABELLA RETAIL PLAZA VESPUCIO (CORREGIDO)' };

    const { index } = await loadDuplicateIndexResult(fakeHost({ activities: [edited] }).ctx, {
      accountId: ACCOUNT,
    });

    expect(index.byFingerprint.get(original.fingerprint)?.installmentRemaining).toBeUndefined();
  });

  it('con cuotaRem stale, un candidate con remaining distinto ya no evita el match por similitud (probable, no new)', async () => {
    const original = cuotaTransaction(5);
    const stored = writeAsAddonWould(original);
    const edited = { ...stored, comment: 'FALABELLA RETAIL PLAZA VESPUCIO (CORREGIDO)' };

    const { index } = await loadDuplicateIndexResult(fakeHost({ activities: [edited] }).ctx, {
      accountId: ACCOUNT,
    });

    const candidate = makeTransaction({
      amount: -49990,
      date: '2026-09-04',
      description: 'FALABELLA RETAIL PLAZA VESPUCIO (CORREGIDO)',
      installmentRemaining: 4,
      sourceFileHash: 'otro-archivo',
    });
    const finding = classifyDuplicate(
      { ...candidate, fingerprint: computeFingerprint(candidate, SCOPE) },
      index,
      SCOPE,
      new Map(),
    );

    expect(finding.verdict).toBe('probable');
    expect(finding.reason_code).toBe('similar');
  });

  it('sin edición, un candidate con remaining distinto sigue siendo new (no rompe 9164e91)', async () => {
    const original = cuotaTransaction(5);
    const stored = writeAsAddonWould(original);

    const { index } = await loadDuplicateIndexResult(fakeHost({ activities: [stored] }).ctx, {
      accountId: ACCOUNT,
    });

    const candidate = makeTransaction({
      amount: -49990,
      date: '2026-09-04',
      description: 'FALABELLA RETAIL PLAZA VESPUCIO',
      installmentRemaining: 4,
      sourceFileHash: 'ciclo-siguiente',
    });
    const finding = classifyDuplicate(
      { ...candidate, fingerprint: computeFingerprint(candidate, SCOPE) },
      index,
      SCOPE,
      new Map(),
    );

    expect(finding.verdict).toBe('none');
    expect(finding.reason_code).toBe('new');
  });

  it('exact-fingerprint sigue ganando aunque exista remaining metadata (no cambia la precedencia)', async () => {
    const original = cuotaTransaction(5);
    const stored = writeAsAddonWould(original);

    const { index } = await loadDuplicateIndexResult(fakeHost({ activities: [stored] }).ctx, {
      accountId: ACCOUNT,
    });

    const sameFile = { ...original, installmentRemaining: 4 };
    const finding = classifyDuplicate(sameFile, index, SCOPE, new Map());

    expect(finding.verdict).toBe('exact');
    expect(finding.reason_code).toBe('exact-fingerprint');
  });

  it('múltiples existing: uno fresco con remaining distinto se ignora, uno stale/sin remaining sigue dando probable', () => {
    const candidate = { ...cuotaTransaction(4), fingerprint: 'candidate-fp' };
    const freshDiffering: ExistingMovement = {
      activityId: 'fresh-differing',
      date: candidate.date,
      amount: candidate.amount,
      description: candidate.description,
      fingerprint: 'fresh-fp',
      weakFingerprint: computeWeakFingerprint(candidate, SCOPE),
      installmentRemaining: 9,
    };
    const staleUnknown: ExistingMovement = {
      activityId: 'stale-unknown',
      date: candidate.date,
      amount: candidate.amount,
      description: candidate.description,
      fingerprint: 'stale-fp',
      weakFingerprint: computeWeakFingerprint(candidate, SCOPE),
      // Sin installmentRemaining: como quedaría tras el fix, para una
      // Activity editada.
    };
    const index = buildDuplicateIndex([freshDiffering, staleUnknown]);

    const finding = classifyDuplicate(candidate, index, SCOPE, new Map());

    expect(finding.verdict).toBe('probable');
    expect(finding.reason_code).toBe('similar');
    expect(finding.existingActivityId).toBe('stale-unknown');
  });
});

describe('compatibilidad con las huellas de 0.1.x', () => {
  /** La receta exacta de 0.1.x: `toDecimalString`, con la escala dentro. */
  function legacyFingerprints(transaction: NormalizedTransaction, accountId: string) {
    const amountText = toDecimalString(transaction.amount);
    return {
      fp: hashFields([
        'v1',
        accountId,
        transaction.date,
        amountText,
        transaction.amount.currency,
        descriptionKey(transaction.description),
        transaction.reference ?? '',
      ]),
      wfp: hashFields([
        'v1',
        'weak',
        accountId,
        transaction.date,
        amountText,
        transaction.amount.currency,
      ]),
    };
  }

  const withCents = {
    ...makeTransaction({ amount: -4999050, date: '2026-02-04', description: 'COMPRA PARIS' }),
    amount: money(-4999050, 2, 'CLP'),
  };

  it('un movimiento con céntimos importado por 0.1.x se reconoce como duplicado', async () => {
    const legacy = legacyFingerprints(withCents, 'acc-1');
    // Sanity: la receta nueva ya no produce esa huella.
    expect(computeFingerprint(withCents, { accountId: 'acc-1' })).not.toBe(legacy.fp);

    const host = fakeHost({
      activities: [
        activityStub({
          id: 'act-vieja',
          accountId: 'acc-1',
          activityType: 'WITHDRAWAL',
          amount: '49990.50',
          date: '2026-02-04',
          comment: 'COMPRA PARIS',
          metadata: ourMetadata({ fp: legacy.fp, wfp: legacy.wfp }),
        }),
      ],
    });

    const { index } = await loadDuplicateIndexResult(host.ctx, { accountId: 'acc-1' });
    const finding = classifyDuplicate(
      { ...withCents, fingerprint: computeFingerprint(withCents, { accountId: 'acc-1' }) },
      index,
      { accountId: 'acc-1' },
      new Map(),
    );

    expect(finding.verdict).toBe('exact');
    expect(finding.existingActivityId).toBe('act-vieja');
  });

  it('y un movimiento sin céntimos sigue funcionando igual que siempre', async () => {
    const whole = makeTransaction({ amount: -10000, date: '2026-02-05', description: 'COMPRA LIDER' });
    const legacy = legacyFingerprints(whole, 'acc-1');
    expect(computeFingerprint(whole, { accountId: 'acc-1' })).toBe(legacy.fp);
  });
});
