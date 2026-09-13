import { describe, expect, it } from 'vitest';
import { buildDuplicateIndex, classifyDuplicate, type ExistingMovement } from '../src/core/dedupe/classify';
import { money } from '../src/core/money';
import { makeTransaction } from './fixtures';

/**
 * P1 (review independiente) — dedupe histórico Banco de Chile tarjeta.
 *
 * Antes de esta tranche, un archivo Nacional pudo importarse:
 *
 *   A. `banco-chile.tarjeta@0.1.0`, elegido manualmente;
 *   B. `generico.tarjeta`, por autodetección antigua.
 *
 * Ambos pueden haber guardado un monto distinto del que el parser actual
 * calcula para la misma celda. Al reimportar el MISMO archivo con
 * `banco-chile.tarjeta` actual: la huella fuerte cambia (monto distinto ->
 * fingerprint distinto) y la débil también (weak fingerprint incluye el
 * monto), así que `classifyDuplicate` no encuentra la actividad histórica por
 * ninguna de las dos vías y la fila sale `new` — puede duplicarse.
 *
 * El guard es deliberadamente estrecho: sólo mira si YA existe, para el
 * mismo `fileHash`, una actividad escrita por una combinación
 * parser/versión que este proyecto sabe incompatible con
 * `banco-chile.tarjeta` actual. No es "cualquier cambio de parser es
 * sospechoso" — ver `isLegacyIncompatibleCardSource` en `core/dedupe/classify.ts`.
 */

const ACCOUNT = 'acc-card';
const SCOPE = { accountId: ACCOUNT };
const SHARED_FILE_HASH = 'a'.repeat(64);

/** La Activity histórica sintética que 0.1.0/generico habría persistido. */
function legacyMovement(overrides: Partial<ExistingMovement> = {}): ExistingMovement {
  return {
    activityId: 'legacy-activity-1',
    date: '2026-02-05',
    // Monto distinto al que el parser ACTUAL calcula para la misma fila —
    // exactamente el escenario que rompe fingerprint y weak fingerprint a la
    // vez.
    amount: money(-12000, 0, 'CLP'),
    description: 'COMPRA SINTETICA',
    fingerprint: 'legacy-fp-old-amount',
    weakFingerprint: 'legacy-wfp-old-amount',
    parser: 'banco-chile.tarjeta',
    parserVersion: '0.1.0',
    fileHash: SHARED_FILE_HASH,
    ...overrides,
  };
}

/** La fila que el parser ACTUAL produce al reimportar el MISMO archivo. */
function currentCandidate(overrides: Partial<Parameters<typeof makeTransaction>[0]> = {}) {
  return makeTransaction({
    amount: -12450,
    date: '2026-02-05',
    description: 'COMPRA SINTETICA',
    sourceParser: 'banco-chile.tarjeta',
    sourceParserVersion: '0.2.0',
    sourceFileHash: SHARED_FILE_HASH,
    fingerprint: 'current-fp-new-amount',
    ...overrides,
  });
}

describe('legacy-source-conflict: banco-chile.tarjeta@0.1.0', () => {
  it('bloquea para revisión manual en vez de declarar la fila nueva', () => {
    const index = buildDuplicateIndex([legacyMovement()]);
    const finding = classifyDuplicate(currentCandidate(), index, SCOPE, new Map());

    expect(finding.verdict).toBe('probable');
    expect(finding.reason_code).toBe('legacy-source-conflict');
    expect(finding.existingActivityId).toBe('legacy-activity-1');
  });
});

describe('legacy-source-conflict: generico.tarjeta', () => {
  it('mismo bloqueo cuando la actividad histórica vino de generico.tarjeta', () => {
    const index = buildDuplicateIndex([
      legacyMovement({ parser: 'generico.tarjeta', parserVersion: '0.1.0' }),
    ]);
    const finding = classifyDuplicate(currentCandidate(), index, SCOPE, new Map());

    expect(finding.verdict).toBe('probable');
    expect(finding.reason_code).toBe('legacy-source-conflict');
  });
});

describe('sin regresión — casos que deben seguir igual', () => {
  it('archivo nunca visto (fileHash distinto) -> import normal', () => {
    const index = buildDuplicateIndex([legacyMovement({ fileHash: 'otro-hash-distinto' })]);
    const finding = classifyDuplicate(currentCandidate(), index, SCOPE, new Map());

    expect(finding.verdict).toBe('none');
  });

  it('mismo archivo reimportado bajo la versión ACTUAL -> exact duplicate normal, no conflict', () => {
    const index = buildDuplicateIndex([
      legacyMovement({
        parser: 'banco-chile.tarjeta',
        parserVersion: '0.2.0',
        fingerprint: 'current-fp-new-amount',
        amount: money(-12450, 0, 'CLP'),
      }),
    ]);
    const finding = classifyDuplicate(currentCandidate(), index, SCOPE, new Map());

    expect(finding.verdict).toBe('exact');
    expect(finding.reason_code).toBe('exact-fingerprint');
  });

  it('partial import moderno: filas nuevas del mismo archivo bajo la versión actual no se bloquean', () => {
    // Ya hay UNA fila de este mismo archivo importada bajo la versión actual;
    // la fila candidata es OTRA fila del mismo archivo, todavía no importada.
    const index = buildDuplicateIndex([
      legacyMovement({
        parser: 'banco-chile.tarjeta',
        parserVersion: '0.2.0',
        fingerprint: 'otra-fila-ya-importada',
        weakFingerprint: 'otra-fila-wfp',
      }),
    ]);
    const finding = classifyDuplicate(currentCandidate(), index, SCOPE, new Map());

    expect(finding.verdict).toBe('none');
  });

  it('otro archivo distinto no se bloquea sólo porque fecha/descripcion coinciden', () => {
    const index = buildDuplicateIndex([
      legacyMovement({
        fileHash: 'otro-archivo-distinto',
        parser: 'banco-chile.tarjeta',
        parserVersion: '0.1.0',
        amount: money(-12450, 0, 'CLP'),
      }),
    ]);
    const finding = classifyDuplicate(currentCandidate(), index, SCOPE, new Map());

    expect(finding.verdict).not.toBe('probable');
  });

  it('un parser distinto de banco-chile.tarjeta no dispara el guard (alcance estrecho a esta transición)', () => {
    const index = buildDuplicateIndex([legacyMovement({ parser: 'banco-falabella.cmr', parserVersion: '0.1.0' })]);
    const finding = classifyDuplicate(
      currentCandidate({ sourceParser: 'banco-falabella.cmr' }),
      index,
      SCOPE,
      new Map(),
    );

    expect(finding.reason_code).not.toBe('legacy-source-conflict');
  });
});
