import { describe, expect, it } from 'vitest';
import { describeImportOutcome, type ImportOutcomeView } from '../src/ui/import-outcome';
import type { ImportBreakdown } from '../src/services/import-runner';

/**
 * What a finished run says to the user.
 *
 * The case that matters is `completed` + `historyRecorded: false`: the money is
 * in Wealthfolio and only the addon's own log of the run is missing. The wizard
 * used to put that message into its global error slot, so the screen showed a
 * green toast and a red "No se pudo continuar" at the same time — and a user who
 * believes the red one imports the file a second time.
 */

const breakdown = (overrides: Partial<ImportBreakdown> = {}): ImportBreakdown => ({
  detected: 10,
  selected: 8,
  created: 8,
  failed: 0,
  skippedExactDuplicate: 1,
  skippedProbableDuplicate: 0,
  skippedByRule: 1,
  skippedByUser: 0,
  ...overrides,
});

const view = (overrides: Partial<ImportOutcomeView> = {}): ImportOutcomeView => ({
  breakdown: breakdown(),
  status: 'completed',
  historyRecorded: true,
  errors: [],
  ...overrides,
});

describe('completed', () => {
  it('is plain success when the history was recorded too', () => {
    const shown = describeImportOutcome(view());

    expect(shown.title).toBe('Importación completada');
    expect(shown.toast.level).toBe('success');
    expect(shown.failure).toBeUndefined();
    expect(shown.warnings).toEqual([]);
    expect(shown.details).toEqual([]);
  });
});

describe('completed but the history could not be written', () => {
  const shown = describeImportOutcome(
    view({
      historyRecorded: false,
      errors: ['No se pudo registrar la importación en el historial: storage full'],
    }),
  );

  it('still reports the import as completed', () => {
    expect(shown.title).toBe('Importación completada');
    expect(shown.toast.level).toBe('success');
  });

  it('raises no failure: nothing is missing from the ledger', () => {
    expect(shown.failure).toBeUndefined();
  });

  it('says the movements were imported and only the run was not logged', () => {
    expect(shown.warnings).toHaveLength(1);
    expect(shown.warnings[0]?.description).toBe(
      'Los movimientos fueron importados, pero no se pudo registrar esta ejecución en el historial del addon.',
    );
  });

  it('never tells the user to import again', () => {
    const text = [
      shown.title,
      shown.toast.message,
      ...shown.warnings.flatMap((warning) => [warning.title, warning.description]),
    ].join(' ');

    expect(text).not.toContain('No se pudo continuar');
    expect(text).not.toMatch(/vuelve a importar|reinten/i);
  });

  it('keeps the underlying message as detail rather than as a headline', () => {
    expect(shown.details).toHaveLength(1);
    expect(shown.details[0]).toContain('storage full');
  });
});

describe('partial', () => {
  const shown = describeImportOutcome(
    view({
      status: 'partial',
      breakdown: breakdown({ created: 5, failed: 3 }),
      errors: ['row 5 rejected', 'row 6 rejected', 'row 7 rejected'],
    }),
  );

  it('names both numbers, created and failed', () => {
    expect(shown.failure?.title).toContain('5');
    expect(shown.failure?.title).toContain('8');
    expect(shown.failure?.title).toContain('3');
  });

  it('never uses the green toast', () => {
    expect(shown.toast.level).toBe('warning');
    expect(shown.title).toBe('Importación parcial');
  });

  it('carries the per-row messages inside the result', () => {
    expect(shown.details).toEqual(['row 5 rejected', 'row 6 rejected', 'row 7 rejected']);
  });

  it('does ask for a re-import, because rows really are missing', () => {
    expect(shown.failure?.description).toMatch(/vuelve a importar/i);
  });
});

describe('failed', () => {
  const shown = describeImportOutcome(
    view({
      status: 'failed',
      breakdown: breakdown({ created: 0, failed: 8 }),
      errors: ['host rejected the batch'],
    }),
  );

  it('is destructive and says nothing was saved', () => {
    expect(shown.title).toBe('No se importó nada');
    expect(shown.toast.level).toBe('error');
    expect(shown.failure?.title).toBe('Wealthfolio rechazó la escritura');
  });
});

describe('a partial run whose history also failed', () => {
  const shown = describeImportOutcome(
    view({
      status: 'partial',
      historyRecorded: false,
      breakdown: breakdown({ created: 5, failed: 3 }),
      errors: ['row 5 rejected', 'No se pudo registrar la importación en el historial: storage full'],
    }),
  );

  it('reports the two problems separately, not as one', () => {
    expect(shown.failure).toBeDefined();
    expect(shown.warnings).toHaveLength(1);
    expect(shown.warnings[0]?.title).toBe('No se registró en el historial');
  });
});
