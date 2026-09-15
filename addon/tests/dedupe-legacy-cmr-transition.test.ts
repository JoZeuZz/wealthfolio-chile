import { describe, expect, it } from 'vitest';
import { buildDuplicateIndex, classifyDuplicate, type ExistingMovement } from '../src/core/dedupe/classify';
import { computeWeakFingerprint } from '../src/core/dedupe/fingerprint';
import { money } from '../src/core/money';
import { defaultRules } from '../src/core/rules/builtin';
import { prepareImport, setRowSelection, type PreparedImport } from '../src/core/pipeline';
import { runImport } from '../src/services/import-runner';
import { fromText, makeTransaction } from './fixtures';
import { fakeHost } from './host';

/**
 * P1 (review independiente) — transición histórica de fingerprint CMR.
 *
 * `computeFingerprint` empezó a incluir `installmentRemaining` cuando está
 * presente (ver `core/dedupe/fingerprint.ts`), sin bump de
 * `FINGERPRINT_VERSION` — deliberado, porque el campo sólo se agrega cuando
 * existe y toda huella que nunca lo produjo queda byte-for-byte igual. Eso es
 * cierto para todo OTRO profile, pero no para la propia historia de
 * `banco-falabella.cmr`: una Activity que este parser escribió ANTES de ese
 * cambio, para una fila que sí trae cuota, ahora hashea distinto al
 * reimportar el mismo archivo — la huella fuerte cambia, la débil (que
 * también depende sólo de cuenta/fecha/monto) no ayuda porque igual apunta a
 * la MISMA fila, así que sin guardia esa fila sale `new` y puede duplicarse.
 *
 * `FALABELLA_CARD.parserVersion` se subió a `0.2.0` junto con este fix,
 * exactamente para darle a `isLegacyIncompatibleCmrSource` una frontera de
 * versión real — el mismo patrón que ya usa `isLegacyIncompatibleCardSource`
 * para `banco-chile.tarjeta`. El guard es estrecho: sólo mira, para el MISMO
 * `sourceFileHash`, si ya existe una Activity escrita por una combinación
 * parser/versión que este proyecto sabe incompatible con
 * `banco-falabella.cmr` actual — `generico.tarjeta` (el layout de 6 columnas
 * podía importarse así antes de la detección estructural propia) o
 * `banco-falabella.cmr@0.1.0` (antes de que el conteo restante entrara al
 * fingerprint).
 */

const ACCOUNT = 'acc-cmr';
const SCOPE = { accountId: ACCOUNT };
const SHARED_FILE_HASH = 'b'.repeat(64);

/** La Activity histórica sintética que generico.tarjeta / cmr@0.1.0 habría persistido. */
function legacyMovement(overrides: Partial<ExistingMovement> = {}): ExistingMovement {
  return {
    activityId: 'legacy-cmr-activity-1',
    date: '2026-02-04',
    amount: money(-49990, 0, 'CLP'),
    description: 'FALABELLA RETAIL PLAZA VESPUCIO',
    fingerprint: 'legacy-cmr-fp-sin-remaining',
    weakFingerprint: 'legacy-cmr-wfp',
    parser: 'banco-falabella.cmr',
    parserVersion: '0.1.0',
    fileHash: SHARED_FILE_HASH,
    ...overrides,
  };
}

/** La fila que el parser ACTUAL produce al reimportar el MISMO archivo/ciclo. */
function currentCandidate(overrides: Partial<Parameters<typeof makeTransaction>[0]> = {}) {
  return makeTransaction({
    amount: -49990,
    date: '2026-02-04',
    description: 'FALABELLA RETAIL PLAZA VESPUCIO',
    sourceParser: 'banco-falabella.cmr',
    sourceParserVersion: '0.2.0',
    sourceFileHash: SHARED_FILE_HASH,
    installmentRemaining: 5,
    fingerprint: 'current-cmr-fp-con-remaining',
    ...overrides,
  });
}

describe('legacy-source-conflict CMR: generico.tarjeta', () => {
  it('bloquea para revisión manual en vez de declarar la fila nueva (caso 1)', () => {
    const index = buildDuplicateIndex([legacyMovement({ parser: 'generico.tarjeta', parserVersion: '0.1.0' })]);
    const finding = classifyDuplicate(currentCandidate(), index, SCOPE, new Map());

    expect(finding.verdict).toBe('probable');
    expect(finding.reason_code).toBe('legacy-source-conflict');
    expect(finding.existingActivityId).toBe('legacy-cmr-activity-1');
  });
});

describe('legacy-source-conflict CMR: banco-falabella.cmr@0.1.0', () => {
  it('mismo bloqueo cuando la actividad histórica vino de la propia cmr antes del bump (caso 2)', () => {
    const index = buildDuplicateIndex([legacyMovement()]);
    const finding = classifyDuplicate(currentCandidate(), index, SCOPE, new Map());

    expect(finding.verdict).toBe('probable');
    expect(finding.reason_code).toBe('legacy-source-conflict');
  });
});

describe('sin regresión — casos que deben seguir igual', () => {
  it('archivo distinto y remaining 5->4: sigue siendo la cuota del ciclo siguiente, no legacy-source-conflict (caso 3)', () => {
    // La Activity histórica quedó del ciclo ANTERIOR (SHARED_FILE_HASH). La
    // fila candidata es el ciclo SIGUIENTE: mismo comercio/monto/glosa, pero
    // un archivo distinto y un remaining que avanzó de 5 a 4 — un hecho
    // nuevo, no un reimport del mismo archivo.
    const index = buildDuplicateIndex([legacyMovement({ amount: money(-49990, 0, 'CLP') })]);
    const finding = classifyDuplicate(
      currentCandidate({ sourceFileHash: 'archivo-ciclo-siguiente', installmentRemaining: 4 }),
      index,
      SCOPE,
      new Map(),
    );

    expect(finding.reason_code).not.toBe('legacy-source-conflict');
  });

  it('mismo archivo reimportado bajo la versión ACTUAL (0.2.0) -> exact duplicate normal, no conflict (caso 5)', () => {
    const index = buildDuplicateIndex([
      legacyMovement({
        parser: 'banco-falabella.cmr',
        parserVersion: '0.2.0',
        fingerprint: 'current-cmr-fp-con-remaining',
        amount: money(-49990, 0, 'CLP'),
      }),
    ]);
    const finding = classifyDuplicate(currentCandidate(), index, SCOPE, new Map());

    expect(finding.verdict).toBe('exact');
    expect(finding.reason_code).toBe('exact-fingerprint');
  });

  it('partial import moderno: otra fila del mismo archivo ya importada bajo 0.2.0 no bloquea filas nuevas (caso 6)', () => {
    const index = buildDuplicateIndex([
      legacyMovement({
        parser: 'banco-falabella.cmr',
        parserVersion: '0.2.0',
        fingerprint: 'otra-fila-cmr-ya-importada',
        weakFingerprint: 'otra-fila-cmr-wfp',
      }),
    ]);
    const finding = classifyDuplicate(currentCandidate(), index, SCOPE, new Map());

    expect(finding.verdict).toBe('none');
  });

  it('un plan sin cuota (installmentRemaining undefined) reimportado bajo la actual sigue como exact normal', () => {
    const index = buildDuplicateIndex([
      legacyMovement({
        parser: 'banco-falabella.cmr',
        parserVersion: '0.2.0',
        fingerprint: 'fp-sin-cuota',
        amount: money(-12000, 0, 'CLP'),
        description: 'COMPRA SIN CUOTAS',
      }),
    ]);
    const finding = classifyDuplicate(
      currentCandidate({
        installmentRemaining: undefined,
        amount: -12000,
        description: 'COMPRA SIN CUOTAS',
        fingerprint: 'fp-sin-cuota',
      }),
      index,
      SCOPE,
      new Map(),
    );

    expect(finding.verdict).toBe('exact');
    expect(finding.reason_code).toBe('exact-fingerprint');
  });
});

describe('precedencia: legacy-source-conflict antes que similarity (CMR)', () => {
  it('fileHash legacy incompatible + match similar existente -> sigue siendo legacy-source-conflict', () => {
    const candidate = currentCandidate({ fingerprint: 'current-cmr-fp-precedencia' });
    const weak = computeWeakFingerprint(candidate, SCOPE);
    const similarAndLegacy = legacyMovement({
      fingerprint: 'legacy-cmr-fp-precedencia',
      weakFingerprint: weak,
      amount: candidate.amount,
      description: candidate.description,
    });
    const index = buildDuplicateIndex([similarAndLegacy]);

    const finding = classifyDuplicate(candidate, index, SCOPE, new Map());

    expect(finding.verdict).toBe('probable');
    expect(finding.reason_code).toBe('legacy-source-conflict');
  });
});

/**
 * Fail-closed end to end, igual que el guard de Banco de Chile: la
 * clasificación es sólo la mitad de la garantía. La otra mitad es que nada
 * río abajo puede convertir esta fila en una segunda Activity — caso 7.
 */
describe('legacy-source-conflict CMR: fail-closed a lo largo de todo el pipeline', () => {
  const ACCOUNT2 = 'acc-cmr-2';

  function preparedWithConflictRow(): PreparedImport {
    const prepared = prepareImport({
      file: fromText(
        'cmr.csv',
        ['Fecha;Descripcion;Monto;Cuotas Pendientes', '04/02/2026;FALABELLA RETAIL;49.990;5'].join('\n'),
      ),
      accountId: ACCOUNT2,
      accountName: 'CMR',
      parserId: 'banco-falabella.cmr',
      rules: defaultRules(),
      duplicateIndex: buildDuplicateIndex([]),
    });
    const rows = prepared.rows.map((row) => ({
      ...row,
      willImport: false,
      duplicate: {
        verdict: 'probable' as const,
        reason_code: 'legacy-source-conflict' as const,
        reason: 'Coincide con una actividad escrita por una versión de parser incompatible para este archivo.',
        existingActivityId: 'legacy-cmr-activity-1',
      },
    }));
    return { ...prepared, rows };
  }

  it('la fila nace deseleccionada (default de prepareImport)', () => {
    const prepared = preparedWithConflictRow();
    expect(prepared.rows[0]?.willImport).toBe(false);
  });

  it('setRowSelection se niega a marcarla para importar', () => {
    const prepared = preparedWithConflictRow();
    const row = prepared.rows[0];
    if (!row) throw new Error('fixture sin filas');

    const attempted = setRowSelection(prepared, row.key, true);

    expect(attempted.rows[0]?.willImport).toBe(false);
  });

  it('runImport nunca escribe la fila aunque willImport llegue en true sin pasar por setRowSelection', async () => {
    const prepared = preparedWithConflictRow();
    const forced: PreparedImport = {
      ...prepared,
      rows: prepared.rows.map((row) => ({ ...row, willImport: true })),
    };
    const host = fakeHost();

    const result = await runImport({
      ctx: host.ctx,
      prepared: forced,
      accountId: ACCOUNT2,
      accountName: 'CMR',
    });

    expect(host.saveManyCalls).toEqual([]);
    expect(host.activities).toEqual([]);
    expect(result.breakdown.created).toBe(0);
    expect(result.breakdown.skippedProbableDuplicate).toBe(1);
  });
});
