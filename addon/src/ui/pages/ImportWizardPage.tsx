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
import { categoryPath } from '../../core/categories/defaults';
import { buildDuplicateIndex } from '../../core/dedupe/classify';
import { formatIsoDate } from '../../core/dates';
import { maskAccountNumber } from '../../core/privacy';
import {
  prepareImport,
  setRowSelection,
  type PreparedImport,
  type PreviewRow,
} from '../../core/pipeline';
import { listInstitutions, PARSERS } from '../../core/providers/registry';
import type { SourceFile } from '../../core/parsing/tabular';
import { loadDuplicateIndex } from '../../services/activity-index';
import { runImport } from '../../services/import-runner';
import { loadEffectiveRules, loadSettings } from '../../services/settings';
import { useAddon } from '../context';
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
  const [prepared, setPrepared] = useState<PreparedImport | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [result, setResult] = useState<{ imported: number; skipped: number } | undefined>();

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

  const analyze = useCallback(
    async (source: SourceFile, chosenParser?: string) => {
      if (!accountId) {
        setError('Selecciona primero la cuenta de destino.');
        return;
      }
      setBusy(true);
      setError(undefined);
      try {
        const [rules, duplicateIndex] = await Promise.all([
          loadEffectiveRules(ctx.api.storage),
          loadDuplicateIndex(ctx, { accountId }),
        ]);

        const next = prepareImport({
          file: source,
          accountId,
          ...(account?.name ? { accountName: account.name } : {}),
          ...(chosenParser ? { parserId: chosenParser } : {}),
          rules,
          duplicateIndex,
        });

        setPrepared(next);
        setParserId(next.parser.id);
        setStep('detect');
      } catch (err) {
        setPrepared(undefined);
        setError(messageOf(err));
        // Falling back to an empty index keeps the manual picker reachable even
        // when reading existing activities failed.
        setStep('detect');
      } finally {
        setBusy(false);
      }
    },
    [account?.name, accountId, ctx],
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

  const confirm = useCallback(async () => {
    if (!prepared || !account) return;
    setBusy(true);
    setError(undefined);
    try {
      const settings = await loadSettings(ctx.api.storage);
      const outcome = await runImport({
        ctx,
        prepared,
        accountId: account.id,
        accountName: account.name,
        verboseLogging: settings.verboseLogging,
      });
      setResult({
        imported: outcome.createdCount,
        skipped: prepared.rows.length - outcome.createdCount,
      });
      if (outcome.errors.length > 0) setError(outcome.errors.join(' · '));
      setStep('done');
      ctx.api.toast.success(`Se importaron ${outcome.createdCount} movimientos.`);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }, [account, ctx, prepared]);

  const restart = () => {
    setStep('file');
    setFile(undefined);
    setPrepared(undefined);
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
          onToggle={(fingerprint, willImport) =>
            setPrepared(setRowSelection(prepared, fingerprint, willImport))
          }
          onBack={() => setStep('detect')}
          onConfirm={confirm}
          busy={busy}
        />
      ) : null}

      {step === 'done' && result ? (
        <Card>
          <CardHeader>
            <CardTitle>Importación completada</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <p className="text-sm">
              Se importaron <strong>{result.imported}</strong> movimientos.{' '}
              {result.skipped > 0 ? `Se omitieron ${result.skipped}.` : null}
            </p>
            <p className="text-muted-foreground text-sm">
              Si vuelves a importar el mismo archivo no se duplicará ningún movimiento.
            </p>
            <div className="flex gap-2">
              <Button onClick={restart}>Importar otra cartola</Button>
              <Button
                variant="outline"
                onClick={() => ctx.api.navigation.navigate('/addons/wealthfolio-chile')}
              >
                Ir al panel
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}
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
          <span className={index === activeIndex ? 'font-medium' : 'text-muted-foreground'}>
            {step.label}
          </span>
          {index < steps.length - 1 ? <span className="text-muted-foreground">→</span> : null}
        </li>
      ))}
    </ol>
  );
}

function DetectionStep({
  prepared,
  selectedParser,
  onSelectParser,
  onContinue,
  onBack,
  busy,
}: {
  prepared: PreparedImport;
  selectedParser: string | undefined;
  onSelectParser: (id: string) => void;
  onContinue: () => void;
  onBack: () => void;
  busy: boolean;
}) {
  const { statement, detections, parser } = prepared;
  const unverified = parser.profile.validationStatus === 'pending-real-sample';
  const errors = statement.issues.filter((issue) => issue.level === 'error');

  return (
    <Card>
      <CardHeader>
        <CardTitle>2. Banco y cuenta detectados</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Banco" value={parser.label} />
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
          />
          <Field
            label="Movimientos"
            value={`${statement.transactions.length} · ${statement.account.currency}`}
          />
        </div>

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
  onToggle,
  onBack,
  onConfirm,
  busy,
}: {
  prepared: PreparedImport;
  onToggle: (fingerprint: string, willImport: boolean) => void;
  onBack: () => void;
  onConfirm: () => void;
  busy: boolean;
}) {
  const { totals, rows, installmentPlans } = prepared;
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
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
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
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
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
          </div>

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
                <th className="w-10 p-2" />
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
                <PreviewRowView key={row.transaction.fingerprint} row={row} onToggle={onToggle} />
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <div className="flex flex-wrap gap-2">
        <Button onClick={onConfirm} disabled={busy || totals.toImport === 0}>
          {busy ? 'Importando…' : `Confirmar e importar ${totals.toImport} movimientos`}
        </Button>
        <Button variant="outline" onClick={onBack} disabled={busy}>
          Volver
        </Button>
      </div>
    </div>
  );
}

function PreviewRowView({
  row,
  onToggle,
}: {
  row: PreviewRow;
  onToggle: (fingerprint: string, willImport: boolean) => void;
}) {
  const { transaction } = row;
  return (
    <tr className={`border-b ${row.willImport ? '' : 'opacity-50'}`}>
      <td className="p-2">
        <Checkbox
          checked={row.willImport}
          onCheckedChange={(checked) =>
            onToggle(transaction.fingerprint, checked === true)
          }
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
        {row.duplicate.verdict === 'exact' ? (
          <Badge variant="outline">Duplicado</Badge>
        ) : row.duplicate.verdict === 'probable' ? (
          <Badge variant="outline" title={row.duplicate.reason}>
            Posible duplicado
          </Badge>
        ) : row.ignoredByRule ? (
          <Badge variant="outline">Ignorado por regla</Badge>
        ) : transaction.warnings.length > 0 ? (
          <Badge variant="outline" title={transaction.warnings.map((w) => w.message).join(' · ')}>
            Revisar
          </Badge>
        ) : (
          <span className="text-muted-foreground">Nuevo</span>
        )}
      </td>
    </tr>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-muted-foreground text-xs uppercase tracking-wide">{label}</span>
      <span className="text-sm font-medium">{value}</span>
    </div>
  );
}

const KIND_LABELS: Record<string, string> = {
  income: 'Ingreso',
  expense: 'Gasto',
  internal_transfer: 'Transferencia propia',
  credit_card_payment: 'Pago tarjeta',
  credit_card_purchase: 'Compra tarjeta',
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export { buildDuplicateIndex };
