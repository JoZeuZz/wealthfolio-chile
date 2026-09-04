import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
} from '@wealthfolio/ui';
import { useDeferredValue, useMemo, useState } from 'react';
import { formatIsoDate } from '../../core/dates';
import type { ConditionField, ConditionOperator, Rule, RuleActionType } from '../../core/rules/engine';
import {
  actionRisk,
  EDITABLE_ACTIONS,
  EDITABLE_FIELDS,
  operatorsFor,
  validateUserRule,
  type RulePreview,
} from '../../services/rules';
import { Amount } from './Money';

/**
 * Editing one rule, with the answer to "what would this do?" in view.
 *
 * The preview is not a nicety. Without it the only way to find out that a rule
 * catches four hundred movements is to save it and import; with it, the count
 * and five examples are on screen before the button is pressed. It counts
 * movements whose *outcome changes*, not movements the rule matches — see
 * `services/rules.previewRuleImpact` for why those are different numbers.
 *
 * The form offers exactly the operators the engine implements and exactly the
 * actions `services/rules` classifies as not dangerous. A control that
 * promises expressiveness the engine does not have is a bug report waiting to
 * be filed against the wrong component.
 */

export interface RuleEditorProps {
  rule: Rule;
  /** Runs the candidate against the movements already imported. Pure. */
  preview: (candidate: Rule) => RulePreview;
  /** One sentence naming the set the preview counted over. */
  scope: string;
  onSave: (rule: Rule) => void;
  onCancel: () => void;
}

export function RuleEditor({ rule, preview, scope, onSave, onCancel }: RuleEditorProps) {
  const [draft, setDraft] = useState<Rule>(rule);
  const [attempted, setAttempted] = useState(false);
  // The operand is text while it is being typed. Re-parsing on every keystroke
  // rewrote what the user had half-written: typing `1` into a range produced
  // `[1, NaN → 0]`, the field re-rendered as `1-0`, and the next digit landed
  // after the max — a range above 9 could not be typed at all, and the rule
  // could not be saved because `[1, 0]` is inverted. Same shape as the
  // reconciliation window on the settings page.
  const [operandDraft, setOperandDraft] = useState<string | undefined>();

  const validation = useMemo(() => validateUserRule(draft), [draft]);

  /**
   * The preview lags the typing on purpose.
   *
   * `previewRuleImpact` runs the whole rule set twice over every movement in
   * the window. Measured on this machine: 60 ms at 300 movements, 214 ms at
   * 1.000, 840 ms at 5.000 — once per keystroke, synchronously, in the tab the
   * user is typing in. Someone with a few accounts and six months of history
   * would be typing into a field that answers a second late.
   *
   * `useDeferredValue` is the whole fix: the input renders from `draft` and
   * stays immediate, while the count recomputes from a value React is allowed
   * to let fall behind. The number is still exact — it is late, not
   * approximate — which matters, because the honest alternative (previewing a
   * sample) would have made it neither.
   */
  const deferred = useDeferredValue(draft);
  // Only previewed once the rule is coherent: running a half-typed condition
  // reports "0 movimientos", which reads as "this rule does nothing" rather
  // than "this rule is not finished".
  const impact = useMemo(
    () => (validateUserRule(deferred).errors.length === 0 ? preview(deferred) : undefined),
    [deferred, preview],
  );

  const condition = draft.conditions[0];
  const action = draft.actions[0];
  if (!condition || !action) return null;

  const setCondition = (patch: Partial<typeof condition>) =>
    setDraft((current) => ({
      ...current,
      conditions: [{ ...condition, ...patch } as typeof condition],
    }));

  /** Turn what was typed into what the condition holds. */
  const commitOperand = () => {
    if (operandDraft === undefined) return;
    const text = operandDraft;
    setOperandDraft(undefined);
    setCondition({ value: parseOperand(condition.operator, text) });
  };

  return (
    <Card role="dialog" aria-label="Editar regla">
      <CardHeader>
        <CardTitle className="text-lg">
          {rule.name === '' ? 'Nueva regla' : `Editar «${rule.name}»`}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-col gap-1">
          <Label htmlFor="rule-name">Nombre</Label>
          <Input
            id="rule-name"
            value={draft.name}
            placeholder="Farmacias"
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          />
        </div>

        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium">Cuando</legend>
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex flex-col gap-1">
              <Label htmlFor="condition-field">Campo</Label>
              <select
                id="condition-field"
                className="border-input bg-background h-9 rounded-md border px-2 text-sm"
                value={condition.field}
                onChange={(event) => {
                  const field = event.target.value as ConditionField;
                  const operators = operatorsFor(field);
                  setCondition({
                    field,
                    // Keeping a text operator on a numeric field silently
                    // matches nothing, which looks like a rule that is simply
                    // wrong rather than one that cannot be expressed.
                    ...(operators.includes(condition.operator)
                      ? {}
                      : { operator: operators[0] as ConditionOperator, value: '' }),
                  });
                }}
              >
                {EDITABLE_FIELDS.map((field) => (
                  <option key={field} value={field}>
                    {fieldLabel(field)}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-1">
              <Label htmlFor="condition-operator">Comparación</Label>
              <select
                id="condition-operator"
                className="border-input bg-background h-9 rounded-md border px-2 text-sm"
                value={condition.operator}
                onChange={(event) =>
                  setCondition({ operator: event.target.value as ConditionOperator })
                }
              >
                {operatorsFor(condition.field).map((operator) => (
                  <option key={operator} value={operator}>
                    {operatorLabel(operator)}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-1">
              <Label htmlFor="condition-value">Valor</Label>
              <Input
                id="condition-value"
                className="w-56"
                value={operandDraft ?? operandText(condition.value)}
                onChange={(event) => setOperandDraft(event.target.value)}
                onBlur={() => commitOperand()}
              />
            </div>
          </div>
        </fieldset>

        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium">Entonces</legend>
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex flex-col gap-1">
              <Label htmlFor="action-type">Acción</Label>
              <select
                id="action-type"
                className="border-input bg-background h-9 rounded-md border px-2 text-sm"
                value={action.type}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    actions: [{ type: event.target.value as RuleActionType }],
                  })
                }
              >
                {EDITABLE_ACTIONS.map((type) => (
                  <option key={type} value={type}>
                    {actionLabel(type)}
                  </option>
                ))}
              </select>
            </div>

            {action.type === 'ignore' ? null : (
              <div className="flex flex-col gap-1">
                <Label htmlFor="action-value">Valor</Label>
                <Input
                  id="action-value"
                  className="w-56"
                  value={action.value ?? ''}
                  onChange={(event) =>
                    setDraft({ ...draft, actions: [{ ...action, value: event.target.value }] })
                  }
                />
              </div>
            )}
          </div>

          {actionRisk(action.type) === 'review-required' ? (
            <Alert>
              <AlertTitle>Esta acción omite movimientos</AlertTitle>
              <AlertDescription>
                Los movimientos que coincidan no se escribirán en Wealthfolio. No se pierden: siguen
                en la cartola y vuelven si desactivas la regla y reimportas el archivo.
              </AlertDescription>
            </Alert>
          ) : null}
        </fieldset>

        {attempted && validation.errors.length > 0 ? (
          <Alert variant="destructive">
            <AlertTitle>La regla todavía no se puede guardar</AlertTitle>
            <AlertDescription>
              <ul className="list-disc pl-4">
                {validation.errors.map((error) => (
                  <li key={error}>{error}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        ) : null}

        {impact ? <PreviewPanel impact={impact} scope={scope} /> : null}

        <div className="flex gap-2">
          <Button
            // `onMouseDown` fires before the input's `blur`, and a click on
            // Guardar is exactly how someone finishes typing a value. Committing
            // here as well means the last thing typed is part of what is saved.
            onMouseDown={commitOperand}
            onClick={() => {
              const pending =
                operandDraft === undefined
                  ? draft
                  : {
                      ...draft,
                      conditions: [
                        { ...condition, value: parseOperand(condition.operator, operandDraft) },
                      ],
                    };
              setOperandDraft(undefined);
              setDraft(pending);
              setAttempted(true);
              if (validateUserRule(pending).errors.length === 0) onSave(pending);
            }}
          >
            Guardar regla
          </Button>
          <Button variant="outline" onClick={onCancel}>
            Cancelar
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * What the rule would have done.
 *
 * The three numbers answer three different questions, and collapsing them
 * would hide the interesting case: a rule can match plenty of movements and
 * change none, because a rule that runs earlier already did the same thing.
 */
function PreviewPanel({ impact, scope }: { impact: RulePreview; scope: string }) {
  return (
    <div className="bg-muted/40 flex flex-col gap-2 rounded-md p-3" aria-live="polite">
      <p className="text-sm font-medium">
        {impact.changed === 0
          ? `No cambiaría ninguno de los ${impact.evaluated} movimientos revisados.`
          : `Cambiaría ${impact.changed} de ${impact.evaluated} movimientos revisados.`}
      </p>
      {impact.matched > impact.changed ? (
        <p className="text-muted-foreground text-xs">
          Coincide con {impact.matched}, pero en {impact.matched - impact.changed} de ellos otra
          regla ya hacía lo mismo o se aplicaba antes.
        </p>
      ) : null}
      {impact.ignored > 0 ? (
        <p className="text-xs font-medium">
          {impact.ignored} quedarían fuera de la importación.
        </p>
      ) : null}

      <p className="text-muted-foreground text-xs">{scope}</p>

      {impact.samples.length > 0 ? (
        <ul className="flex flex-col gap-1 text-xs">
          {impact.samples.map((sample) => (
            <li key={`${sample.date}-${sample.description}`} className="flex flex-wrap gap-2">
              <span className="text-muted-foreground tabular-nums">
                {formatIsoDate(sample.date)}
              </span>
              <span className="flex-1">{sample.description}</span>
              <Amount value={sample.amount} />
              <span className="text-muted-foreground">{sample.effects.join(' · ')}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * Turn what the user typed into what the condition holds.
 *
 * A range is two numbers; every other numeric operator is one. Storing the raw
 * string for a numeric comparison works today — the engine coerces — but it
 * makes the saved rule depend on that coercion, and a rule set is written once
 * and read by every later version.
 */
/** How a stored operand reads back into the field. */
function operandText(value: Rule['conditions'][number]['value']): string {
  return Array.isArray(value) ? value.join('-') : String(value);
}

function parseOperand(operator: ConditionOperator, text: string): string | number | [number, number] {
  if (operator === 'between') {
    const [min, max] = text.split(/[-–a]/).map((part) => Number(part.trim()));
    return [Number.isFinite(min) ? (min as number) : 0, Number.isFinite(max) ? (max as number) : 0];
  }
  if (operator === 'gt' || operator === 'gte' || operator === 'lt' || operator === 'lte') {
    const value = Number(text.replace(/[^\d.-]/g, ''));
    return Number.isFinite(value) ? value : text;
  }
  return text;
}

function fieldLabel(field: ConditionField): string {
  switch (field) {
    case 'description':
      return 'Glosa';
    case 'merchant':
      return 'Comercio';
    case 'absAmount':
      return 'Monto (sin signo)';
    case 'amount':
      return 'Monto (con signo)';
    case 'direction':
      return 'Entrada o salida';
    case 'operationType':
      return 'Tipo que imprime el banco';
    case 'institution':
      return 'Banco';
    case 'product':
      return 'Producto de la cartola';
    default:
      return field;
  }
}

function operatorLabel(operator: ConditionOperator): string {
  switch (operator) {
    case 'contains':
      return 'contiene';
    case 'not_contains':
      return 'no contiene';
    case 'equals':
      return 'es igual a';
    case 'not_equals':
      return 'no es igual a';
    case 'starts_with':
      return 'empieza por';
    case 'ends_with':
      return 'termina en';
    case 'matches':
      return 'coincide con la expresión';
    case 'gt':
      return 'es mayor que';
    case 'gte':
      return 'es mayor o igual que';
    case 'lt':
      return 'es menor que';
    case 'lte':
      return 'es menor o igual que';
    case 'between':
      return 'está entre';
  }
}

function actionLabel(type: RuleActionType): string {
  switch (type) {
    case 'set_category':
      return 'poner la categoría';
    case 'set_merchant':
      return 'poner el comercio';
    case 'add_tag':
      return 'añadir la etiqueta';
    case 'ignore':
      return 'dejarlo fuera de la importación';
    default:
      return type;
  }
}
