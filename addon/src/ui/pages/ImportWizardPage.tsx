import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Checkbox,
  Separator,
} from '@wealthfolio/ui';
import type { Account } from '@wealthfolio/addon-sdk';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AccountMatch, HostAccountFacts } from '../../core/accounts/match';
import { categoryPath } from '../../core/categories/defaults';
import { buildDuplicateIndex } from '../../core/dedupe/classify';
import { formatIsoDate } from '../../core/dates';
import { formatCLP, toDecimalString } from '../../core/money';
import {
  cardFactLabel,
  type CreditCardStatementFacts,
} from '../../core/model/statement-facts';
import { maskAccountNumber } from '../../core/privacy';
import type { ParsedStatement, RowStats, StatementBalance } from '../../core/model/statement';
import { setRowSelection, type PreparedImport, type PreviewRow } from '../../core/pipeline';
import { listInstitutions, PARSERS } from '../../core/providers/registry';
import type { SourceFile } from '../../core/parsing/tabular';
import {
  prepareImportFromHost,
  type ImportBlocker,
  type PreparationResult,
} from '../../services/import-preparation';
import { runImport } from '../../services/import-runner';
import { loadSettings } from '../../services/settings';
import { useAddon } from '../context';
import { describeImportOutcome, type ImportOutcomeView } from '../import-outcome';
import { FileDrop } from '../components/FileDrop';
import { Amount, Stat } from '../components/Money';

/**
 * The import wizard.
 *
 * Five steps, and the fourth one is the point of the whole feature: nothing is
 * written to the user's ledger until they have seen every movement the parser
 * produced and pressed confirm. Automatic import without preview is a
 * deliberate non-feature while the bank profiles are still being calibrated.
 */

type Step = 'file' | 'detect' | 'preview' | 'done';

export function ImportWizardPage() {
  const ctx = useAddon();

  const [step, setStep] = useState<Step>('file');
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountId, setAccountId] = useState<string>('');
  const [file, setFile] = useState<SourceFile | undefined>();
  const [parserId, setParserId] = useState<string | undefined>();
  const [preparation, setPreparation] = useState<PreparationResult | undefined>();
  const [busy, setBusy] = useState(false);
  // Fatal only: loading the account list, and an exception that left us unable
  // to know whether anything was written. A run that returned a result — even a
  // partial or a failed one — reports through `result`, not here. Parsing and
  // deduplication report separately again.
  const [error, setError] = useState<string | undefined>();
  const [result, setResult] = useState<ImportOutcomeView | undefined>();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await ctx.api.accounts.getAll();
        if (cancelled) return;
        const active = list.filter((account) => account.isActive && !account.isArchived);
        setAccounts(active);
        setAccountId((current) => current || active[0]?.id || '');
      } catch (err) {
        if (!cancelled) setError(messageOf(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ctx]);

  const account = accounts.find((candidate) => candidate.id === accountId);
  const prepared = preparation?.prepared;

  const analyze = useCallback(
    async (source: SourceFile, chosenParser?: string) => {
      if (!accountId) {
        setError('Selecciona primero la cuenta de destino.');
        return;
      }
      setBusy(true);
      setError(undefined);
      try {
        const outcome = await prepareImportFromHost(ctx, {
          file: source,
          accountId,
          ...(account?.name ? { accountName: account.name } : {}),
          ...(account ? { account: accountFacts(account) } : {}),
          ...(chosenParser ? { parserId: chosenParser } : {}),
        });
        setPreparation(outcome);
        if (outcome.prepared) setParserId(outcome.prepared.parser.id);
        setStep('detect');
      } catch (err) {
        // `prepareImportFromHost` catches every failure it knows about, so
        // anything arriving here is one it does not. Without this the rejection
        // was unhandled: `busy` cleared, the step stayed on `file`, and the
        // screen said nothing at all.
        setError(err instanceof Error ? err.message : 'No se pudo leer el archivo.');
      } finally {
        setBusy(false);
      }
    },
    [account, accountId, ctx],
  );

  const onFile = useCallback(
    (source: SourceFile) => {
      setFile(source);
      setResult(undefined);
      void analyze(source);
    },
    [analyze],
  );

  const reparseWith = useCallback(
    (id: string) => {
      if (!file) return;
      void analyze(file, id);
    },
    [analyze, file],
  );

  /** Re-run the whole preparation, which is also how "Reintentar" recovers. */
  const retry = useCallback(() => {
    if (!file) return;
    void analyze(file, parserId);
  }, [analyze, file, parserId]);

  const confirm = useCallback(async () => {
    if (!prepared || !account || !preparation?.canImport) return;
    setBusy(true);
    setError(undefined);
    try {
      const settings = await loadSettings(ctx.api.storage);
      const outcome = await runImport({
        ctx,
        prepared,
        accountId: account.id,
        accountName: account.name,
        accountType: accountFacts(account).accountType,
        verboseLogging: settings.verboseLogging,
      });

      const view: ImportOutcomeView = {
        breakdown: outcome.breakdown,
        status: outcome.status,
        historyRecorded: outcome.historyRecorded,
        errors: outcome.errors,
      };
      setResult(view);
      setStep('done');

      // A partial or failed run never gets the success toast: a green message
      // over a half-written import is how a person stops checking. A run that
      // wrote everything and only failed to log itself still gets it, because
      // the ledger is correct — the warning lives in the result card.
      const { toast } = describeImportOutcome(view);
      ctx.api.toast[toast.level](toast.message);
    } catch (err) {
      // The only genuinely fatal branch: `runImport()` never threw us a result,
      // so we cannot say whether anything reached the ledger. That uncertainty
      // is what the global error is for.
      setError(messageOf(err));
      ctx.api.toast.error('No se pudo completar la importación.');
    } finally {
      setBusy(false);
    }
  }, [account, ctx, prepared, preparation?.canImport]);

  const restart = () => {
    setStep('file');
    setFile(undefined);
    setPreparation(undefined);
    setParserId(undefined);
    setResult(undefined);
    setError(undefined);
  };

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">Importar cartola</h1>
        <p className="text-muted-foreground text-sm">
          Los movimientos se revisan antes de escribirse. Nada se guarda hasta que confirmes.
        </p>
      </header>

      <Steps current={step} />

      {error ? (
        <Alert variant="destructive">
          <AlertTitle>No se pudo continuar</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {preparation?.rules.status === 'fallback' ? (
        <Alert>
          <AlertTitle>Reglas no disponibles</AlertTitle>
          <AlertDescription>{preparation.rules.message}</AlertDescription>
        </Alert>
      ) : null}

      {preparation && preparation.blockers.length > 0 && step !== 'done' ? (
        <ImportBlockedAlert
          blockers={preparation.blockers}
          onRetry={retry}
          busy={busy || !file}
        />
      ) : null}

      {step === 'file' ? (
        <Card>
          <CardHeader>
            <CardTitle>1. Elige la cuenta y el archivo</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <label className="flex flex-col gap-2 text-sm">
              <span className="font-medium">Cuenta de destino</span>
              <select
                className="border-input bg-background h-9 rounded-md border px-3 text-sm"
                value={accountId}
                onChange={(event) => setAccountId(event.target.value)}
              >
                {accounts.length === 0 ? <option value="">No hay cuentas activas</option> : null}
                {accounts.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name} ({candidate.currency})
                  </option>
                ))}
              </select>
            </label>
            <FileDrop onFile={onFile} disabled={busy || accountId === ''} />
          </CardContent>
        </Card>
      ) : null}

      {step === 'detect' && prepared ? (
        <DetectionStep
          prepared={prepared}
          {...(preparation?.accountMatch ? { accountMatch: preparation.accountMatch } : {})}
          selectedParser={parserId}
          onSelectParser={reparseWith}
          onContinue={() => setStep('preview')}
          onBack={restart}
          busy={busy}
        />
      ) : null}

      {step === 'preview' && prepared ? (
        <PreviewStep
          prepared={prepared}
          dedupeAvailable={preparation?.duplicateIndex.status === 'ready'}
          blockers={preparation?.blockers ?? []}
          onToggle={(key, willImport) =>
            setPreparation((current) =>
              current?.prepared
                ? { ...current, prepared: setRowSelection(current.prepared, key, willImport) }
                : current,
            )
          }
          onBack={() => setStep('detect')}
          onConfirm={confirm}
          busy={busy}
        />
      ) : null}

      {step === 'done' && result ? (
        <ResultStep
          result={result}
          onRestart={restart}
          onGoToDashboard={() => ctx.api.navigation.navigate('/addons/wealthfolio-chile')}
        />
      ) : null}
    </div>
  );
}

/** Title and consequence for each reason the write is refused. */
const BLOCKER_COPY: Record<ImportBlocker['code'], { title: string; consequence: string }> = {
  'parse-failed': {
    title: 'No se pudo leer el archivo',
    consequence: 'No hay nada que importar hasta poder leerlo.',
  },
  'duplicate-check-unavailable': {
    title: 'No se puede comprobar si hay duplicados',
    consequence:
      'Sin esa comprobación un movimiento ya registrado se guardaría dos veces, así que importar queda deshabilitado.',
  },
  'account-mismatch': {
    title: 'La cartola no es de esta cuenta',
    consequence:
      'Importarla aquí dejaría los movimientos en la cuenta equivocada, y la deduplicación no lo detectaría: en otra cuenta esos movimientos son nuevos. Elige la cuenta correcta en el primer paso.',
  },
  'statement-invalid': {
    title: 'La cartola no se puede importar tal como se leyó',
    // Overridden by the blocker's own `remedy`: the reasons a statement is
    // invalid have opposite remedies, so fixed copy here would be wrong for
    // roughly half of them.
    consequence: '',
  },
};

/**
 * Why the write is refused, in full.
 *
 * The preview stays visible and honest about what the parser produced; what
 * this removes is the ability to confirm it. Every blocker is listed at once —
 * fixing one and discovering another is worse than seeing both.
 */
function ImportBlockedAlert({
  blockers,
  onRetry,
  busy,
}: {
  blockers: readonly ImportBlocker[];
  onRetry: () => void;
  busy: boolean;
}) {
  return (
    <Alert variant="destructive">
      <AlertTitle>
        {blockers.length === 1
          ? (BLOCKER_COPY[blockers[0]!.code]?.title ?? 'No se puede importar')
          : `No se puede importar (${blockers.length} motivos)`}
      </AlertTitle>
      <AlertDescription className="flex flex-col items-start gap-3">
        {blockers.map((blocker) => (
          <div key={blocker.code} className="flex flex-col gap-1">
            {blockers.length > 1 ? (
              <span className="font-medium">{BLOCKER_COPY[blocker.code]?.title}</span>
            ) : null}
            <span>{blocker.message}</span>
            <span>
              {blocker.code === 'statement-invalid'
                ? blocker.remedy
                : BLOCKER_COPY[blocker.code]?.consequence}
            </span>
            {blocker.code === 'statement-invalid' && blocker.issues.length > 0 ? (
              <ul className="list-disc pl-5 text-xs">
                {blocker.issues.slice(0, 5).map((issue, index) => (
                  <li key={`${issue.code}-${issue.line ?? index}`}>{issue.message}</li>
                ))}
                {blocker.issues.length > 5 ? (
                  <li>y {blocker.issues.length - 5} más.</li>
                ) : null}
              </ul>
            ) : null}
            {blocker.code === 'account-mismatch' ? (
              <ul className="list-disc pl-5 text-xs">
                {blocker.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ))}
        <Button size="sm" variant="outline" onClick={onRetry} disabled={busy}>
          Reintentar
        </Button>
      </AlertDescription>
    </Alert>
  );
}

function ResultStep({
  result,
  onRestart,
  onGoToDashboard,
}: {
  result: ImportOutcomeView;
  onRestart: () => void;
  onGoToDashboard: () => void;
}) {
  const { breakdown } = result;
  const { title, failure, warnings, details } = describeImportOutcome(result);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {failure ? (
          <Alert variant="destructive">
            <AlertTitle>{failure.title}</AlertTitle>
            <AlertDescription>{failure.description}</AlertDescription>
          </Alert>
        ) : null}

        {/*
          Neutral variant on purpose. A run that wrote the ledger and then failed
          to log itself is not a failed import, and the copy never suggests
          retrying — that would only re-check duplicates for nothing.
        */}
        {warnings.map((warning) => (
          <Alert key={warning.title}>
            <AlertTitle>{warning.title}</AlertTitle>
            <AlertDescription>{warning.description}</AlertDescription>
          </Alert>
        ))}

        <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <Counter label="Detectados en el archivo" value={breakdown.detected} />
          <Counter label="Seleccionados" value={breakdown.selected} />
          <Counter label="Creados en Wealthfolio" value={breakdown.created} />
          <Counter label="Fallaron al escribir" value={breakdown.failed} />
          <Counter label="Duplicados exactos" value={breakdown.skippedExactDuplicate} />
          <Counter label="Posibles duplicados" value={breakdown.skippedProbableDuplicate} />
          <Counter label="Ignorados por regla" value={breakdown.skippedByRule} />
          <Counter label="Desmarcados por ti" value={breakdown.skippedByUser} />
        </dl>

        {details.length > 0 ? (
          <details className="text-sm">
            <summary className="cursor-pointer font-medium">
              Detalle de la ejecución ({details.length})
            </summary>
            <ul className="text-muted-foreground mt-2 list-disc pl-5">
              {details.slice(0, 20).map((message, index) => (
                <li key={`${index}-${message}`}>{message}</li>
              ))}
            </ul>
          </details>
        ) : null}

        <p className="text-muted-foreground text-sm">
          Si vuelves a importar el mismo archivo no se duplicará ningún movimiento.
        </p>

        <div className="flex gap-2">
          <Button onClick={onRestart}>Importar otra cartola</Button>
          <Button variant="outline" onClick={onGoToDashboard}>
            Ir al panel
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function Counter({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col">
      <dt className="text-muted-foreground text-xs uppercase tracking-wide">{label}</dt>
      <dd className="text-base font-medium tabular-nums">{value}</dd>
    </div>
  );
}

function Steps({ current }: { current: Step }) {
  const steps: Array<{ id: Step; label: string }> = [
    { id: 'file', label: 'Archivo' },
    { id: 'detect', label: 'Detección' },
    { id: 'preview', label: 'Vista previa' },
    { id: 'done', label: 'Confirmación' },
  ];
  const activeIndex = steps.findIndex((step) => step.id === current);

  return (
    <ol className="flex flex-wrap items-center gap-2 text-sm">
      {steps.map((step, index) => (
        <li key={step.id} className="flex items-center gap-2">
          <span
            className={[
              'flex h-6 w-6 items-center justify-center rounded-full text-xs font-medium',
              index <= activeIndex
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-muted-foreground',
            ].join(' ')}
          >
            {index + 1}
          </span>
          <span
            className={index === activeIndex ? 'font-medium' : 'text-muted-foreground'}
            // Weight alone does not say which step this is; nothing but the
            // pixels distinguished the current one.
            {...(index === activeIndex ? { 'aria-current': 'step' as const } : {})}
          >
            {step.label}
          </span>
          {index < steps.length - 1 ? (
            <span className="text-muted-foreground" aria-hidden>
              →
            </span>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

function DetectionStep({
  prepared,
  accountMatch,
  selectedParser,
  onSelectParser,
  onContinue,
  onBack,
  busy,
}: {
  prepared: PreparedImport;
  accountMatch?: AccountMatch;
  selectedParser: string | undefined;
  onSelectParser: (id: string) => void;
  onContinue: () => void;
  onBack: () => void;
  busy: boolean;
}) {
  const { statement, detections, parser } = prepared;
  const detection = detections.find((entry) => entry.parser === parser.id);
  const unverified = parser.profile.validationStatus === 'pending-real-sample';
  const errors = statement.issues.filter((issue) => issue.level === 'error');

  return (
    <Card>
      <CardHeader>
        <CardTitle>2. Banco y cuenta detectados</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Archivo" value={statement.fileName} />
          <Field
            label="Banco"
            value={parser.label}
            // How sure the detector was, next to what it decided. A profile
            // picked at 40 % and one picked at 100 % are not the same claim,
            // and the number was only visible on the buttons below.
            hint={
              detection
                ? `${Math.round(detection.score * 100)}% de coincidencia`
                : 'Elegido a mano'
            }
          />
          <Field
            label="Cuenta en la cartola"
            value={statement.account.number ? maskAccountNumber(statement.account.number) : '—'}
          />
          <Field
            label="Período"
            value={
              statement.period.from && statement.period.to
                ? `${formatIsoDate(statement.period.from)} → ${formatIsoDate(statement.period.to)}`
                : '—'
            }
            // The range the file covers, which can come from the movements or
            // from a label in the preamble — the model does not tell the two
            // apart today, so the hint says the one thing true either way. The
            // billing cycle below is a different question and says so.
            hint="Rango que cubre el archivo."
          />
          <Field
            label="Movimientos"
            value={`${statement.transactions.length} · ${statement.account.currency}`}
            hint={describeRowStats(statement.rowStats)}
          />
          {statement.openingBalance || statement.closingBalance ? (
            <Field
              label="Saldos"
              value={`${describeBalance(statement.openingBalance)} → ${describeBalance(statement.closingBalance)}`}
              hint={describeBalanceSources(statement)}
            />
          ) : null}
          {/* What a card statement asserts about the debt it bills — the part a
              person actually acts on, and which the wizard read and then threw
              away. Each one appears only if the document said it: an absent
              pago mínimo is not drawn as "$0", because zero would claim there
              is nothing to pay this month. */}
          {cardFactFields(statement.cardFacts).map((fact) => (
            <Field key={fact.label} label={fact.label} value={fact.value} hint={fact.hint} />
          ))}
        </div>

        {accountMatch && !accountMatch.blocking ? (
          <Alert>
            <AlertTitle>
              {accountMatch.verdict === 'confirmed'
                ? 'La cartola corresponde a esta cuenta'
                : 'No se pudo confirmar que la cartola sea de esta cuenta'}
            </AlertTitle>
            <AlertDescription>
              <ul className="list-disc pl-4">
                {accountMatch.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
              {accountMatch.verdict === 'compatible' ? (
                <p className="mt-2">
                  Nada contradice la elección, pero tampoco hay con qué comprobarla. Revisa que sea
                  la cuenta correcta antes de continuar.
                </p>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : null}

        {unverified ? (
          <Alert>
            <AlertTitle>Formato pendiente de validación</AlertTitle>
            <AlertDescription>
              {parser.profile.validationNotes ??
                'Este formato se construyó sin una cartola real. Revisa la vista previa con atención.'}
            </AlertDescription>
          </Alert>
        ) : null}

        {errors.length > 0 ? (
          <Alert variant="destructive">
            <AlertTitle>Problemas al leer el archivo</AlertTitle>
            <AlertDescription>
              <ul className="list-disc pl-4">
                {errors.slice(0, 5).map((issue) => (
                  <li key={`${issue.code}-${issue.line ?? 0}`}>{issue.message}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        ) : null}

        <Separator />

        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">¿No es el banco correcto?</span>
          <div className="flex flex-wrap gap-2">
            {PARSERS.map((candidate) => {
              const detection = detections.find((entry) => entry.parser === candidate.id);
              const selected = candidate.id === selectedParser;
              return (
                <Button
                  key={candidate.id}
                  size="sm"
                  variant={selected ? 'default' : 'outline'}
                  disabled={busy}
                  onClick={() => onSelectParser(candidate.id)}
                >
                  {candidate.label}
                  {detection ? (
                    <Badge variant="secondary" className="ml-2">
                      {Math.round(detection.score * 100)}%
                    </Badge>
                  ) : null}
                </Button>
              );
            })}
          </div>
          <p className="text-muted-foreground text-xs">
            Bancos disponibles: {listInstitutions().map((entry) => entry.label).join(' · ')}
          </p>
        </div>

        <div className="flex gap-2">
          <Button onClick={onContinue} disabled={busy || statement.transactions.length === 0}>
            Ver movimientos
          </Button>
          <Button variant="outline" onClick={onBack} disabled={busy}>
            Cambiar archivo
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function PreviewStep({
  prepared,
  dedupeAvailable,
  blockers,
  onToggle,
  onBack,
  onConfirm,
  busy,
}: {
  prepared: PreparedImport;
  dedupeAvailable: boolean;
  blockers: readonly ImportBlocker[];
  onToggle: (rowKey: string, willImport: boolean) => void;
  onBack: () => void;
  onConfirm: () => void;
  busy: boolean;
}) {
  const { totals, rows, installmentPlans } = prepared;
  const canImport = blockers.length === 0;
  const warnings = useMemo(
    () => prepared.validation.issues.filter((issue) => issue.level === 'warning'),
    [prepared.validation.issues],
  );

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>3. Resumen de lo que se va a importar</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Ingresos" value={totals.income} tone="positive" />
            <Stat label="Egresos" value={totals.expenses} tone="negative" />
            <Stat
              label="Flujo neto"
              value={totals.net}
              tone={totals.net.minor < 0 ? 'negative' : 'positive'}
            />
            <Stat
              label="Movimientos"
              value={`${totals.toImport} de ${totals.rows}`}
              hint={`${totals.exactDuplicates} duplicados · ${totals.probableDuplicates} probables · ${totals.ignored} ignorados`}
            />
          </dl>

          <dl className="grid gap-4 sm:grid-cols-3">
            <Stat
              label="Transferencias propias"
              value={totals.internalTransfers}
              hint="No cuentan como gasto ni ingreso"
            />
            <Stat
              label="Pagos de tarjeta"
              value={totals.cardPayments}
              hint="Mueven deuda, no son gasto nuevo"
            />
            <Stat
              label="Requieren revisión"
              value={String(totals.needsReview)}
              hint={`${totals.unknownKind} sin clasificar`}
            />
          </dl>

          {totals.hostModifiedDuplicates > 0 ? (
            <Alert>
              <AlertTitle>
                {totals.hostModifiedDuplicates} movimiento(s) fueron editados en Wealthfolio
              </AlertTitle>
              <AlertDescription>
                Se importaron antes y después alguien cambió la actividad, así que ya no coinciden
                con la fila del archivo. No se marcan para importar: decide fila por fila si falta
                el movimiento original o si la versión editada lo reemplaza.
              </AlertDescription>
            </Alert>
          ) : null}

          {installmentPlans.length > 0 ? (
            <Alert>
              <AlertTitle>Compras en cuotas detectadas</AlertTitle>
              <AlertDescription>
                {installmentPlans
                  .slice(0, 4)
                  .map(
                    (plan) =>
                      `${plan.merchant} ${plan.currentInstallment}/${plan.totalInstallments}`,
                  )
                  .join(' · ')}
              </AlertDescription>
            </Alert>
          ) : null}

          {warnings.length > 0 ? (
            <details className="text-sm">
              <summary className="cursor-pointer font-medium">
                {warnings.length} advertencia(s)
              </summary>
              <ul className="text-muted-foreground mt-2 list-disc pl-5">
                {warnings.slice(0, 20).map((issue, index) => (
                  <li key={`${issue.code}-${index}`}>{issue.message}</li>
                ))}
              </ul>
            </details>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>4. Revisa los movimientos</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-muted-foreground border-b text-left">
                <th className="w-10 p-2">
                  <span className="sr-only">Importar</span>
                </th>
                <th className="p-2">Fecha</th>
                <th className="p-2">Descripción</th>
                <th className="p-2 text-right">Monto</th>
                <th className="p-2">Tipo</th>
                <th className="p-2">Categoría</th>
                <th className="p-2">Estado</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <PreviewRowView
                  key={row.key}
                  row={row}
                  dedupeAvailable={dedupeAvailable}
                  onToggle={onToggle}
                />
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={onConfirm} disabled={busy || totals.toImport === 0 || !canImport}>
          {busy ? 'Importando…' : `Confirmar e importar ${totals.toImport} movimientos`}
        </Button>
        <Button variant="outline" onClick={onBack} disabled={busy}>
          Volver
        </Button>
        {!canImport ? (
          <span className="text-muted-foreground text-xs">
            Importar está deshabilitado:{' '}
            {blockers.map((blocker) => BLOCKER_COPY[blocker.code]?.title.toLowerCase()).join(' · ')}.
          </span>
        ) : null}
      </div>
    </div>
  );
}

function PreviewRowView({
  row,
  dedupeAvailable,
  onToggle,
}: {
  row: PreviewRow;
  dedupeAvailable: boolean;
  onToggle: (rowKey: string, willImport: boolean) => void;
}) {
  const { transaction } = row;
  return (
    <tr className={`border-b ${row.willImport ? '' : 'opacity-50'}`}>
      <td className="p-2">
        <Checkbox
          checked={row.willImport}
          // Without a name this is one of 400 unlabelled checkboxes to anyone
          // not reading the row visually. The date, the amount and the glosa
          // are what identify the row on screen, so they are what it says.
          aria-label={`Importar el movimiento del ${formatIsoDate(transaction.date)} por ${toDecimalString(transaction.amount)} ${transaction.amount.currency}: ${transaction.description}`}
          onCheckedChange={(checked) => onToggle(row.key, checked === true)}
        />
      </td>
      <td className="p-2 whitespace-nowrap tabular-nums">{formatIsoDate(transaction.date)}</td>
      <td className="p-2">
        <div className="flex flex-col">
          <span>{transaction.merchant ?? transaction.description}</span>
          {transaction.merchant ? (
            <span className="text-muted-foreground text-xs">{transaction.description}</span>
          ) : null}
          {transaction.installment ? (
            <span className="text-muted-foreground text-xs">
              Cuota {transaction.installment.current}/{transaction.installment.total}
            </span>
          ) : null}
        </div>
      </td>
      <td className="p-2 text-right">
        <Amount value={transaction.amount} signed />
      </td>
      <td className="p-2">
        <Badge variant="secondary">{kindLabel(transaction.kind)}</Badge>
      </td>
      <td className="text-muted-foreground p-2 text-xs">{categoryPath(transaction.category)}</td>
      <td className="p-2 text-xs">
        {/*
          Reasons are rendered, not hidden in a `title`. A tooltip is invisible
          on touch and to a keyboard, and "this movement may be missing from
          your ledger" is not a footnote.
        */}
        {!dedupeAvailable ? (
          <div className="flex flex-col gap-1">
            <Badge variant="outline">Sin verificar</Badge>
            <span className="text-muted-foreground">
              No se pudieron leer los movimientos ya registrados.
            </span>
          </div>
        ) : row.duplicate.verdict === 'exact' ? (
          <Badge variant="outline">Duplicado</Badge>
        ) : row.duplicate.verdict === 'probable' ? (
          <div className="flex flex-col gap-1">
            <Badge variant="outline">Posible duplicado</Badge>
            <span className="text-muted-foreground max-w-xs">{row.duplicate.reason}</span>
          </div>
        ) : row.ignoredByRule ? (
          <Badge variant="outline">Ignorado por regla</Badge>
        ) : transaction.warnings.length > 0 ? (
          <div className="flex flex-col gap-1">
            <Badge variant="outline">Revisar</Badge>
            <span className="text-muted-foreground max-w-xs">
              {transaction.warnings.map((w) => w.message).join(' · ')}
            </span>
          </div>
        ) : (
          <span className="text-muted-foreground">Nuevo</span>
        )}
      </td>
    </tr>
  );
}

function Field({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-muted-foreground text-xs uppercase tracking-wide">{label}</span>
      <span className="text-sm font-medium">{value}</span>
      {hint ? <span className="text-muted-foreground text-xs">{hint}</span> : null}
    </div>
  );
}

/**
 * A balance, or a dash where the file gave no evidence for one.
 *
 * The dash is the point of showing this at all: it says the cartola never
 * stated where the period started, which is why nothing checked it.
 */
function describeBalance(balance: StatementBalance | undefined): string {
  return balance ? formatCLP(balance.amount, { withSymbol: true }) : '—';
}

/**
 * Where each balance came from.
 *
 * A user comparing these against their bank app needs to know which of the two
 * numbers the cartola actually printed and which one this addon worked out, so
 * that a disagreement points at the right suspect.
 */
function describeBalanceSources(statement: ParsedStatement): string {
  const word = (balance: StatementBalance | undefined) =>
    balance === undefined
      ? 'sin dato'
      : balance.source === 'declared'
        ? 'declarado'
        : 'calculado';
  return `inicial ${word(statement.openingBalance)} · final ${word(statement.closingBalance)}`;
}

/**
 * What became of every row below the header.
 *
 * Shown even when nothing went wrong: "12 leídas de 12" is the sentence that
 * makes "11 leídas de 12" mean something when it appears.
 */
export function describeRowStats(stats: RowStats): string {
  const parts = [`${stats.mapped} de ${stats.dataRows} filas leídas`];
  if (stats.skipped > 0) parts.push(`${stats.skipped} omitidas`);
  if (stats.failed > 0) parts.push(`${stats.failed} con error`);
  return parts.join(' · ');
}

/**
 * The card facts a statement declared, ready to render.
 *
 * Only declared facts, and only the ones present. Nothing here computes a
 * figure: a billed amount added up from the rows would look identical to one
 * the issuer printed, and they are not the same claim.
 */
function cardFactFields(
  facts: CreditCardStatementFacts | undefined,
): Array<{ label: string; value: string; hint?: string }> {
  if (!facts) return [];
  const out: Array<{ label: string; value: string; hint?: string }> = [];

  const period = facts.billingPeriod;
  if (period) {
    out.push({
      label: cardFactLabel('billingPeriod'),
      value: `${formatIsoDate(period.value.from)} → ${formatIsoDate(period.value.to)}`,
      hint: 'El ciclo que factura este estado de cuenta, que no es un mes calendario.',
    });
  }

  for (const key of ['statementDate', 'dueDate'] as const) {
    const fact = facts[key];
    if (fact) {
      out.push({ label: cardFactLabel(key), value: formatIsoDate(fact.value), hint: source(fact) });
    }
  }

  for (const key of [
    'billedAmount',
    'minimumPayment',
    'totalDebt',
    'domesticDebt',
    'foreignDebt',
    'creditLimit',
    'availableCredit',
  ] as const) {
    const fact = facts[key];
    if (fact) {
      out.push({ label: cardFactLabel(key), value: formatCLP(fact.value), hint: source(fact) });
    }
  }

  return out;
}

/**
 * Where a fact came from, said out loud.
 *
 * Today every card fact is `declared` — nothing derives one — and the label
 * still shows it, because the day something does derive a billed amount the two
 * must not look alike. That confusion is the whole reason the provenance is in
 * the type rather than in a comment.
 */
function source(fact: { source: 'declared' | 'derived' }): string {
  return fact.source === 'declared'
    ? 'Declarado por el emisor en la cartola.'
    : 'Derivado de los movimientos, no impreso por el emisor.';
}

const KIND_LABELS: Record<string, string> = {
  income: 'Ingreso',
  expense: 'Gasto',
  internal_transfer: 'Transferencia propia',
  credit_card_payment: 'Pago tarjeta',
  credit_card_purchase: 'Compra tarjeta',
  cash_advance: 'Avance en efectivo',

  refund: 'Devolución',
  fee: 'Comisión',
  interest: 'Interés',
  tax: 'Impuesto',
  investment: 'Inversión',
  unknown: 'Sin clasificar',
};

export function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}

/**
 * The parts of a Wealthfolio account the statement is checked against.
 *
 * Narrowed here rather than passing the whole `Account` so the comparison in
 * `core/` stays a pure function of four fields, testable without an SDK type.
 */
function accountFacts(account: Account): HostAccountFacts {
  return {
    ...(account.accountNumber ? { accountNumber: account.accountNumber } : {}),
    accountType: account.accountType as HostAccountFacts['accountType'],
    currency: account.currency,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export { buildDuplicateIndex };
