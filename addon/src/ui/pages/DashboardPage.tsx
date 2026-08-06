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
  Separator,
} from '@wealthfolio/ui';
import { useEffect, useMemo, useState } from 'react';
import { categoryPath } from '../../core/categories/defaults';
import { addMonthsToKey, formatMonthKey, monthEnd, monthKey, monthStart } from '../../core/dates';
import { buildInsights, type Insight } from '../../core/insights/rules';
import { buildInstallmentPlans, buildOutlook } from '../../core/installments/plans';
import {
  findRecurringCharges,
  summarizeMonth,
  totalsByCategory,
  totalsByMerchant,
} from '../../core/metrics/monthly';
import { formatCLP } from '../../core/money';
import { Confidence } from '../../core/model/kinds';
import type { NormalizedTransaction } from '../../core/model/transaction';
import { ImportHistory, type ImportRun } from '../../services/import-history';
import { loadImportedTransactions } from '../../services/imported-transactions';
import { useAddon } from '../context';
import { Amount, Stat } from '../components/Money';

/**
 * The Chile dashboard.
 *
 * Deliberately not a second copy of Wealthfolio's own overview: it answers the
 * cash-flow questions Wealthfolio does not, and it answers them from activities
 * this addon imported, reconstructed out of the metadata written at import
 * time. Everything shown is arithmetic over that data — no estimates, no model.
 */

/**
 * Months of history loaded behind the selected month.
 *
 * Everything the panel computes needs at most this much context: the month
 * itself, the previous month for the comparisons, and a year of history for the
 * recurring-charge and installment detection. Asking the host for exactly that
 * window — rather than paging blindly through the whole activity table until an
 * arbitrary cap — is what keeps the figures correct as an account grows.
 */
const HISTORY_MONTHS = 13;

interface DashboardData {
  transactions: NormalizedTransaction[];
  runs: ImportRun[];
  currency: string;
  /** True when the host held more rows in the window than we could read. */
  truncated: boolean;
}

export function DashboardPage() {
  const ctx = useAddon();
  const [data, setData] = useState<DashboardData | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [month, setMonth] = useState<string>(() => monthKey(new Date().toISOString().slice(0, 10)));

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        const [loaded, runs, settings] = await Promise.all([
          loadImportedTransactions(ctx, {
            fromDate: monthStart(addMonthsToKey(month, -HISTORY_MONTHS)),
            toDate: monthEnd(month),
          }),
          ImportHistory.from(ctx).recent(10),
          ctx.api.settings.get().catch(() => undefined),
        ]);
        if (cancelled) return;
        setData({
          transactions: loaded.transactions,
          runs,
          currency: settings?.baseCurrency ?? 'CLP',
          truncated: loaded.truncated,
        });
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ctx, month]);

  const view = useMemo(() => {
    if (!data) return undefined;
    return buildView(data, month);
  }, [data, month]);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold">Chile</h1>
          <p className="text-muted-foreground text-sm">
            Flujo de caja, categorías y cuotas a partir de tus cartolas importadas.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setMonth(addMonthsToKey(month, -1))}>
            ←
          </Button>
          <span className="min-w-40 text-center text-sm font-medium">{formatMonthKey(month)}</span>
          <Button variant="outline" size="sm" onClick={() => setMonth(addMonthsToKey(month, 1))}>
            →
          </Button>
          <Button onClick={() => ctx.api.navigation.navigate('/addons/wealthfolio-chile/importar')}>
            Importar cartola
          </Button>
        </div>
      </header>

      {error ? (
        <Alert variant="destructive">
          <AlertTitle>No se pudieron cargar los datos</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {data?.truncated ? (
        <Alert variant="destructive">
          <AlertTitle>Cifras incompletas</AlertTitle>
          <AlertDescription>
            Este período tiene más movimientos de los que se alcanzaron a leer, así que los totales
            de abajo están por debajo del valor real. Reduce el rango o revisa los movimientos
            directamente en Wealthfolio.
          </AlertDescription>
        </Alert>
      ) : null}

      {loading ? <p className="text-muted-foreground text-sm">Cargando…</p> : null}

      {!loading && data && data.transactions.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Todavía no hay movimientos importados</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <p className="text-sm">
              Importa una cartola para empezar. Los movimientos que importes desde aquí quedan
              marcados y alimentan este panel.
            </p>
            <div>
              <Button
                onClick={() => ctx.api.navigation.navigate('/addons/wealthfolio-chile/importar')}
              >
                Importar mi primera cartola
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {view ? (
        <>
          <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Ingresos del mes" value={view.summary.income} tone="positive" />
            <Stat label="Egresos del mes" value={view.summary.expenses} tone="negative" />
            <Stat
              label="Flujo neto"
              value={view.summary.net}
              tone={view.summary.net.minor < 0 ? 'negative' : 'positive'}
              hint={
                view.summary.savingsRate !== undefined
                  ? `Tasa de ahorro ${Math.round(view.summary.savingsRate * 100)}%`
                  : undefined
              }
            />
            <Stat
              label="Comprometido en cuotas"
              value={view.outlook.committedTotal}
              hint={`${view.outlook.openPlans.length} compra(s) activa(s)`}
            />
          </section>

          <section className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Gastos por categoría</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                {view.categories.length === 0 ? (
                  <p className="text-muted-foreground text-sm">Sin gastos este mes.</p>
                ) : (
                  view.categories.slice(0, 8).map((entry) => (
                    <div key={entry.category} className="flex flex-col gap-1">
                      <div className="flex items-baseline justify-between gap-2 text-sm">
                        <span>{categoryPath(entry.category)}</span>
                        <Amount value={entry.amount} />
                      </div>
                      <div className="bg-muted h-1.5 w-full overflow-hidden rounded-full">
                        <div
                          className="bg-primary h-full"
                          style={{ width: `${Math.round(entry.share * 100)}%` }}
                        />
                      </div>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Comercios principales</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
                {view.merchants.length === 0 ? (
                  <p className="text-muted-foreground text-sm">Sin comercios este mes.</p>
                ) : (
                  view.merchants.map((entry) => (
                    <div
                      key={entry.merchant}
                      className="flex items-baseline justify-between gap-2 text-sm"
                    >
                      <span>
                        {entry.merchant}
                        <span className="text-muted-foreground ml-2 text-xs">
                          {entry.transactionCount}×
                        </span>
                      </span>
                      <Amount value={entry.amount} />
                    </div>
                  ))
                )}
              </CardContent>
            </Card>
          </section>

          <section className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Cuotas comprometidas</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                {view.outlook.schedule.length === 0 ? (
                  <p className="text-muted-foreground text-sm">
                    No se detectaron compras en cuotas pendientes.
                  </p>
                ) : (
                  <>
                    {view.outlook.schedule.slice(0, 6).map((entry) => (
                      <div
                        key={entry.month}
                        className="flex items-baseline justify-between gap-2 text-sm"
                      >
                        <span>{formatMonthKey(entry.month)}</span>
                        <Amount value={entry.amount} />
                      </div>
                    ))}
                    <Separator />
                    {view.outlook.openPlans.slice(0, 5).map((plan) => (
                      <div key={plan.id} className="flex items-baseline justify-between gap-2 text-xs">
                        <span>
                          {plan.merchant}{' '}
                          <span className="text-muted-foreground">
                            {plan.currentInstallment}/{plan.totalInstallments}
                          </span>
                          {plan.confidence !== Confidence.confirmed || plan.hasGaps ? (
                            <Badge variant="outline" className="ml-2">
                              estimado
                            </Badge>
                          ) : null}
                        </span>
                        <span className="text-muted-foreground tabular-nums">
                          quedan {formatCLP(plan.remainingAmount)}
                        </span>
                      </div>
                    ))}
                  </>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Movimientos que no son gasto</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-3 text-sm">
                <div className="flex items-baseline justify-between gap-2">
                  <span>Transferencias entre cuentas propias</span>
                  <Amount value={view.summary.internalTransfers} />
                </div>
                <div className="flex items-baseline justify-between gap-2">
                  <span>Pagos de tarjeta de crédito</span>
                  <Amount value={view.summary.cardPayments} />
                </div>
                <p className="text-muted-foreground text-xs">
                  Ninguno de estos montos se cuenta como ingreso ni como gasto: mueven dinero que ya
                  tenías.
                </p>
                <Separator />
                <div className="flex items-baseline justify-between gap-2">
                  <span>Gastos fijos</span>
                  <Amount value={view.summary.fixedExpenses} />
                </div>
                <div className="flex items-baseline justify-between gap-2">
                  <span>Gastos variables</span>
                  <Amount value={view.summary.variableExpenses} />
                </div>
              </CardContent>
            </Card>
          </section>

          <Card>
            <CardHeader>
              <CardTitle>Observaciones</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {view.insights.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  Necesitamos al menos dos meses de datos para comparar tendencias.
                </p>
              ) : (
                view.insights.map((insight) => <InsightRow key={insight.id} insight={insight} />)
              )}
            </CardContent>
          </Card>

          {view.recurring.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>Gastos recurrentes detectados</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-2 text-sm">
                {view.recurring.slice(0, 8).map((charge) => (
                  <div
                    key={charge.merchant}
                    className="flex items-baseline justify-between gap-2"
                  >
                    <span>
                      {charge.merchant}
                      <span className="text-muted-foreground ml-2 text-xs">
                        cada ~{charge.cadenceDays} días · {charge.occurrences} cargos
                      </span>
                    </span>
                    <Amount value={charge.amount} />
                  </div>
                ))}
              </CardContent>
            </Card>
          ) : null}

          {data && data.runs.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>Últimas importaciones</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-2 text-sm">
                {data.runs.slice(0, 5).map((run) => (
                  <div key={run.id} className="flex items-baseline justify-between gap-2">
                    <span>
                      {run.fileName}
                      <span className="text-muted-foreground ml-2 text-xs">
                        {run.institution} · {run.timestamp.slice(0, 10)}
                      </span>
                    </span>
                    <span className="text-muted-foreground text-xs">
                      {run.importedRows} importados
                    </span>
                  </div>
                ))}
                <div>
                  <Button
                    variant="link"
                    className="px-0"
                    onClick={() =>
                      ctx.api.navigation.navigate('/addons/wealthfolio-chile/importaciones')
                    }
                  >
                    Ver historial completo
                  </Button>
                </div>
              </CardContent>
            </Card>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function InsightRow({ insight }: { insight: Insight }) {
  const tone =
    insight.severity === 'attention'
      ? 'border-l-destructive'
      : insight.severity === 'positive'
        ? 'border-l-success'
        : 'border-l-muted-foreground';
  return (
    <div className={`border-l-2 pl-3 ${tone}`}>
      <p className="text-sm">{insight.message}</p>
      {insight.detail ? (
        <p className="text-muted-foreground text-xs">{insight.detail}</p>
      ) : null}
    </div>
  );
}

interface DashboardView {
  summary: ReturnType<typeof summarizeMonth>;
  categories: ReturnType<typeof totalsByCategory>;
  merchants: ReturnType<typeof totalsByMerchant>;
  recurring: ReturnType<typeof findRecurringCharges>;
  outlook: ReturnType<typeof buildOutlook>;
  insights: Insight[];
}

function buildView(data: DashboardData, month: string): DashboardView {
  const inMonth = data.transactions.filter((t) => monthKey(t.date) === month);
  const previousMonth = addMonthsToKey(month, -1);
  const inPrevious = data.transactions.filter((t) => monthKey(t.date) === previousMonth);

  const summary = summarizeMonth(month, inMonth, { currency: data.currency });
  const previousSummary = summarizeMonth(previousMonth, inPrevious, { currency: data.currency });

  const categories = totalsByCategory(inMonth, { currency: data.currency });
  const previousCategories = totalsByCategory(inPrevious, { currency: data.currency });
  const merchants = totalsByMerchant(inMonth, 8, { currency: data.currency });
  const recurring = findRecurringCharges(data.transactions);

  const plans = buildInstallmentPlans(data.transactions);
  const outlook = buildOutlook(plans, month, 12, data.currency);

  const insights = buildInsights({
    month,
    current: summary,
    ...(inPrevious.length > 0 ? { previous: previousSummary } : {}),
    categories,
    ...(inPrevious.length > 0 ? { previousCategories } : {}),
    merchants,
    recurring,
    installments: outlook,
  });

  return { summary, categories, merchants, recurring, outlook, insights };
}


