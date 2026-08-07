import type { ImportBreakdown, RunImportResult } from '../services/import-runner';

/**
 * How a finished import run is announced.
 *
 * Kept apart from the wizard's JSX for one reason: this is where the dangerous
 * mistake lives. `runImport()` returns several independent facts — how much
 * reached the ledger, whether the run could be logged, what the host complained
 * about — and the wizard used to funnel all of them into a single error string.
 * A ledger that was written correctly then appeared under a red "No se pudo
 * continuar", and a user who reads that imports the file again.
 *
 * So the presentation has three slots with three different meanings:
 *
 * - `failure` — money is missing. Red, and it does ask for action.
 * - `warnings` — the import worked; something adjacent did not. Neutral, and it
 *   must never suggest re-importing.
 * - `details` — the host's own messages. Evidence, not a headline.
 *
 * A failure the wizard could not attribute to a run at all — an exception that
 * left us unable to say whether anything was written — is not modelled here. It
 * stays the wizard's global error, because that one genuinely blocks.
 */

export interface ImportOutcomeView {
  breakdown: ImportBreakdown;
  status: RunImportResult['status'];
  historyRecorded: boolean;
  /** Per-row and per-batch messages from the run. */
  errors: string[];
}

export interface OutcomeNotice {
  title: string;
  description: string;
}

export interface ImportOutcomePresentation {
  title: string;
  toast: { level: 'success' | 'warning' | 'error'; message: string };
  /** Present only when rows the user approved are missing from the ledger. */
  failure?: OutcomeNotice;
  /** Non-blocking notes about a run that did write what it was asked to. */
  warnings: OutcomeNotice[];
  details: string[];
}

/** The one place that decides what a finished run looks like to a person. */
export function describeImportOutcome(outcome: ImportOutcomeView): ImportOutcomePresentation {
  const { breakdown, status } = outcome;

  const warnings: OutcomeNotice[] = [];
  if (!outcome.historyRecorded) {
    // Deliberately says nothing about retrying: the movements are in, and a
    // second import would only re-check duplicates for nothing.
    warnings.push({
      title: 'No se registró en el historial',
      description:
        'Los movimientos fueron importados, pero no se pudo registrar esta ejecución en el historial del addon.',
    });
  }

  const base = { warnings, details: [...outcome.errors] };

  if (status === 'completed') {
    return {
      ...base,
      title: 'Importación completada',
      toast: {
        level: 'success',
        message: `Se importaron ${breakdown.created} movimientos.`,
      },
    };
  }

  if (status === 'partial') {
    return {
      ...base,
      title: 'Importación parcial',
      toast: {
        level: 'warning',
        message:
          `Importación parcial: ${breakdown.created} de ${breakdown.selected} movimientos. ` +
          `${breakdown.failed} no se pudieron guardar.`,
      },
      failure: {
        title: `Se guardaron ${breakdown.created} de ${breakdown.selected} movimientos — ${breakdown.failed} quedaron fuera`,
        description:
          'Revisa el detalle de abajo y vuelve a importar el archivo: los movimientos que sí se guardaron se detectarán como duplicados y no se repetirán.',
      },
    };
  }

  return {
    ...base,
    title: 'No se importó nada',
    toast: { level: 'error', message: 'No se pudo guardar ningún movimiento.' },
    failure: {
      title: 'Wealthfolio rechazó la escritura',
      description:
        'No quedó ningún movimiento guardado. Revisa el detalle de abajo y vuelve a importar el archivo.',
    },
  };
}
