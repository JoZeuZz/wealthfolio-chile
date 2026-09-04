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
  Input,
  Label,
  Separator,
  Switch,
} from '@wealthfolio/ui';
import { useCallback, useEffect, useState } from 'react';
import { categoryLabel } from '../../core/categories/defaults';
import { civilToday, monthKey, monthStart, addMonthsToKey } from '../../core/dates';
import type { NormalizedTransaction } from '../../core/model/transaction';
import { defaultRules } from '../../core/rules/builtin';
import type { Rule, RuleActionType } from '../../core/rules/engine';
import { PARSERS } from '../../core/providers/registry';
import { loadImportedTransactions } from '../../services/imported-transactions';
import {
  actionRisk,
  loadUserRules,
  previewRuleImpact,
  saveUserRules,
  validateUserRule,
  type RulePreview,
} from '../../services/rules';
import {
  clampWindow,
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  TRANSFER_WINDOW_MAX,
  TRANSFER_WINDOW_MIN,
  type ChileSettings,
} from '../../services/settings';
import { useAddon } from '../context';
import { RuleEditor } from '../components/RuleEditor';

/**
 * Configuration.
 *
 * Two things this screen deliberately is not. It is not a dump of the addon's
 * internals: the parser ids, the fingerprint version and the shard layout are
 * not settings, they are implementation, and a screen that lists them teaches
 * the user that everything on it is equally adjustable. And it is not a place
 * to reach the whole rule engine. The engine can rewrite what a movement *is*;
 * this screen lets a rule rewrite what a movement is *called*. See
 * `services/rules` for where that line is drawn and why.
 *
 * The layout follows the host's own settings pages — a card per concern, a
 * label and a one-line explanation on the left, the control on the right — so
 * it reads as part of Wealthfolio rather than as a panel bolted onto it.
 */

/** Months of movements the rule preview runs against. */
const PREVIEW_MONTHS = 6;

interface PageState {
  settings: ChileSettings;
  userRules: Rule[];
  movements: NormalizedTransaction[];
  loading: boolean;
  error?: string;
}

export function SettingsPage() {
  const ctx = useAddon();
  const [state, setState] = useState<PageState>({
    settings: DEFAULT_SETTINGS,
    userRules: [],
    movements: [],
    loading: true,
  });
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<Rule | undefined>();
  // The window is typed digit by digit, so clamping on every keystroke fights
  // the user: "12" arrives as "1" and then "12", and a clamp in between turns
  // the field into whatever the bounds allow. The draft is text until the
  // field is left.
  const [windowDraft, setWindowDraft] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [settings, userRules] = await Promise.all([
          loadSettings(ctx.api.storage),
          loadUserRules(ctx.api.storage),
        ]);
        // The movements are only for the preview, so a failure to read them
        // costs the preview and nothing else: the rest of the screen still
        // works without them.
        const movements = await loadPreviewMovements(ctx);
        if (!cancelled) setState({ settings, userRules, movements, loading: false });
      } catch (err) {
        if (!cancelled) {
          setState((previous) => ({
            ...previous,
            loading: false,
            error: err instanceof Error ? err.message : String(err),
          }));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ctx]);

  const persist = useCallback(
    async (settings: ChileSettings) => {
      setState((previous) => ({ ...previous, settings }));
      setSaving(true);
      try {
        await saveSettings(ctx.api.storage, settings);
      } catch (err) {
        setState((previous) => ({
          ...previous,
          error: err instanceof Error ? err.message : String(err),
        }));
      } finally {
        setSaving(false);
      }
    },
    [ctx],
  );

  const persistRules = useCallback(
    async (userRules: Rule[]) => {
      setState((previous) => ({ ...previous, userRules }));
      setSaving(true);
      try {
        await saveUserRules(ctx.api.storage, userRules);
      } catch (err) {
        setState((previous) => ({
          ...previous,
          error: err instanceof Error ? err.message : String(err),
        }));
      } finally {
        setSaving(false);
      }
    },
    [ctx],
  );

  const preview = useCallback(
    (candidate: Rule): RulePreview =>
      previewRuleImpact(
        candidate,
        [...defaultRules(), ...state.userRules],
        state.movements,
        { accountId: 'preview' },
      ),
    [state.userRules, state.movements],
  );

  if (state.loading) {
    return (
      <div className="mx-auto w-full max-w-4xl p-6">
        <p className="text-muted-foreground text-sm" role="status">
          Cargando la configuración…
        </p>
      </div>
    );
  }

  const { settings, userRules } = state;
  const disabled = new Set(settings.disabledBuiltinRules);

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">Configuración</h1>
        <p className="text-muted-foreground text-sm">
          Cómo Wealthfolio Chile interpreta tus cartolas. Los movimientos ya importados los guarda
          Wealthfolio; aquí sólo se ajusta la lectura.
        </p>
      </header>

      {state.error ? (
        <Alert variant="destructive">
          <AlertTitle>No se pudo guardar</AlertTitle>
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}

      <Separator />

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Conciliación</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <Label htmlFor="transfer-window" className="text-base">
                Días de margen para emparejar transferencias
              </Label>
              <p className="text-muted-foreground text-xs">
                Una transferencia entre tus cuentas puede aparecer con fechas distintas en cada
                cartola. Cuanto más ancho el margen, más pares se proponen y más hay que descartar.
              </p>
            </div>
            <Input
              id="transfer-window"
              type="number"
              className="w-24"
              min={TRANSFER_WINDOW_MIN}
              max={TRANSFER_WINDOW_MAX}
              value={windowDraft ?? String(settings.transferWindowDays)}
              disabled={saving}
              onChange={(event) => setWindowDraft(event.target.value)}
              onBlur={() => {
                const days = clampWindow(Number(windowDraft ?? settings.transferWindowDays));
                setWindowDraft(undefined);
                if (days !== settings.transferWindowDays) {
                  void persist({ ...settings, transferWindowDays: days });
                }
              }}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Reglas predefinidas</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-muted-foreground text-sm">
            Vienen con el addon y están escritas contra glosas chilenas concretas. Puedes
            desactivar cualquiera; se guarda que la desactivaste, así que una versión nueva no te la
            vuelve a encender.
          </p>
          <ul className="divide-border divide-y">
            {defaultRules().map((rule) => (
              <li key={rule.id} className="flex items-center justify-between gap-4 py-3">
                <div className="space-y-0.5">
                  <Label htmlFor={`rule-${rule.id}`} className="text-base">
                    {rule.name}
                  </Label>
                  <p className="text-muted-foreground text-xs">{describeRule(rule)}</p>
                </div>
                <div className="flex items-center gap-2">
                  {riskBadge(rule)}
                  <Switch
                    id={`rule-${rule.id}`}
                    checked={!disabled.has(rule.id)}
                    disabled={saving}
                    onCheckedChange={(on: boolean) =>
                      void persist({
                        ...settings,
                        disabledBuiltinRules: on
                          ? settings.disabledBuiltinRules.filter((id) => id !== rule.id)
                          : [...settings.disabledBuiltinRules, rule.id],
                      })
                    }
                  />
                </div>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Tus reglas</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-muted-foreground text-sm">
            Una regla tuya puede cambiar la categoría, el comercio o las etiquetas de un
            movimiento, y puede dejarlo fuera de una importación. No puede cambiar qué es el
            movimiento —de gasto a transferencia, por ejemplo— porque eso decide si Wealthfolio lo
            cuenta como gasto, como ingreso o como nada.
          </p>

          {userRules.length === 0 ? (
            <p className="text-muted-foreground text-sm">Todavía no has creado ninguna.</p>
          ) : (
            <ul className="divide-border divide-y">
              {userRules.map((rule) => (
                <li key={rule.id} className="flex items-center justify-between gap-4 py-3">
                  <div className="space-y-0.5">
                    <span className="text-base font-medium">{rule.name}</span>
                    <p className="text-muted-foreground text-xs">{describeRule(rule)}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch
                      aria-label={`Activar la regla ${rule.name}`}
                      checked={rule.enabled}
                      disabled={saving}
                      onCheckedChange={(on: boolean) =>
                        void persistRules(
                          userRules.map((r) => (r.id === rule.id ? { ...r, enabled: on } : r)),
                        )
                      }
                    />
                    <Button variant="outline" size="sm" onClick={() => setEditing(rule)}>
                      Editar
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={saving}
                      onClick={() =>
                        void persistRules(userRules.filter((r) => r.id !== rule.id))
                      }
                    >
                      Eliminar
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <Button onClick={() => setEditing(newRule())}>Nueva regla</Button>

          {state.movements.length === 0 ? (
            <p className="text-muted-foreground text-xs">
              Todavía no hay movimientos importados contra los que probar una regla, así que la
              vista previa dirá que no afecta a nada. Eso no significa que no vaya a afectar a una
              cartola futura.
            </p>
          ) : (
            <p className="text-muted-foreground text-xs">
              La vista previa se calcula sobre {state.movements.length} movimientos de los últimos{' '}
              {PREVIEW_MONTHS} meses, sin escribir nada.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Bancos reconocidos</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-muted-foreground text-sm">
            Cada formato se calibró contra documentación pública o contra un archivo real. La
            diferencia importa: un perfil sin cartola real detrás puede leer mal una columna sin que
            nada falle.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-muted-foreground border-b text-left text-xs uppercase">
                <tr>
                  <th scope="col" className="py-2 pr-4">
                    Formato
                  </th>
                  <th scope="col" className="py-2 pr-4">
                    Producto
                  </th>
                  <th scope="col" className="py-2 pr-4">
                    Calibración
                  </th>
                  <th scope="col" className="py-2">
                    Saldo declarado
                  </th>
                </tr>
              </thead>
              <tbody>
                {PARSERS.map((parser) => (
                  <tr key={parser.id} className="border-b last:border-0">
                    <td className="py-2 pr-4">{parser.label}</td>
                    <td className="text-muted-foreground py-2 pr-4">
                      {productLabel(parser.profile.product)}
                    </td>
                    <td className="py-2 pr-4">
                      {parser.profile.validationStatus === 'verified' ? (
                        <Badge variant="secondary">Verificado</Badge>
                      ) : (
                        <Badge variant="outline">Sin cartola real</Badge>
                      )}
                    </td>
                    <td className="text-muted-foreground py-2">
                      {parser.profile.balanceCheck === 'authoritative'
                        ? 'Bloquea si no cuadra'
                        : 'Sólo avisa'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Privacidad</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-muted-foreground text-sm">
            El archivo de la cartola no se guarda: de cada importación queda su huella SHA-256, el
            nombre del archivo con los identificadores borrados y unos conteos. Nada sale de tu
            equipo.
          </p>
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <Label htmlFor="verbose-logging" className="text-base">
                Diagnóstico detallado
              </Label>
              <p className="text-muted-foreground text-xs">
                Añade líneas al registro de Wealthfolio para depurar una importación. Siguen sin
                incluir glosas, RUT ni números de cuenta: sólo cifras.
              </p>
            </div>
            <Switch
              id="verbose-logging"
              checked={settings.verboseLogging}
              disabled={saving}
              onCheckedChange={(on: boolean) => void persist({ ...settings, verboseLogging: on })}
            />
          </div>
        </CardContent>
      </Card>

      {editing ? (
        <RuleEditor
          rule={editing}
          preview={preview}
          onCancel={() => setEditing(undefined)}
          onSave={(saved) => {
            const next = state.userRules.some((r) => r.id === saved.id)
              ? state.userRules.map((r) => (r.id === saved.id ? saved : r))
              : [...state.userRules, saved];
            setEditing(undefined);
            void persistRules(next);
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * Movements to run the preview against.
 *
 * Six months of what this addon already imported. Reading them costs one
 * windowed query and gives the preview something real to answer with; failing
 * to read them costs the preview and nothing else, which is why the caller
 * treats an empty list as "no answer yet" rather than as "no effect".
 */
async function loadPreviewMovements(
  ctx: ReturnType<typeof useAddon>,
): Promise<NormalizedTransaction[]> {
  try {
    const today = monthKey(civilToday());
    const { transactions } = await loadImportedTransactions(ctx, {
      fromDate: monthStart(addMonthsToKey(today, -(PREVIEW_MONTHS - 1))),
    });
    return transactions;
  } catch {
    return [];
  }
}

function newRule(): Rule {
  return {
    id: `user.${Date.now().toString(36)}`,
    name: '',
    enabled: true,
    priority: 500,
    match: 'all',
    conditions: [{ field: 'description', operator: 'contains', value: '' }],
    actions: [{ type: 'set_category', value: '' }],
    origin: 'user',
  };
}

/** What a rule does, in one line, without naming an action type. */
function describeRule(rule: Rule): string {
  const actions = rule.actions.map(describeAction).filter((text) => text !== '');
  return actions.length > 0 ? actions.join(' · ') : 'Sin efecto';
}

function describeAction(action: { type: RuleActionType; value?: string }): string {
  switch (action.type) {
    case 'set_category':
      return `Categoría: ${categoryLabel(action.value)}`;
    case 'set_merchant':
      return `Comercio: ${action.value ?? ''}`;
    case 'add_tag':
      return `Etiqueta: ${action.value ?? ''}`;
    case 'ignore':
      return 'Deja el movimiento fuera de la importación';
    case 'set_kind':
      return `Reclasifica el movimiento como ${action.value ?? ''}`;
    case 'mark_transfer':
      return 'Marca el movimiento como transferencia entre cuentas propias';
  }
}

/**
 * A badge only where it earns one.
 *
 * Marking every rule with its risk level would make the word meaningless. The
 * built-in rules that change what a movement *is* are the ones worth pointing
 * at, because switching one off changes totals rather than labels.
 */
function riskBadge(rule: Rule) {
  const dangerous = rule.actions.some((action) => actionRisk(action.type) === 'dangerous');
  if (!dangerous) return null;
  return (
    <Badge variant="outline" title="Cambia cómo se cuenta el movimiento, no sólo cómo se llama">
      Afecta a los totales
    </Badge>
  );
}

function productLabel(product: string): string {
  switch (product) {
    case 'checking':
      return 'Cuenta corriente / vista';
    case 'savings':
      return 'Ahorro';
    case 'credit_card':
      return 'Tarjeta de crédito';
    case 'credit_line':
      return 'Línea de crédito';
    default:
      return 'Sin determinar';
  }
}

export { validateUserRule };
