# ADR 0003 — Categorización propia pese a que el core ya la tiene

- **Estado:** aceptado
- **Fecha:** 2026-08-05

## Problema

Wealthfolio v3.6 **sí** trae un subsistema de gasto en el core:

```
crates/storage-sqlite/src/spending/
├── categorization_rules.rs
├── budget.rs
├── activity_splits.rs
├── activity_assignments.rs
├── activity_events.rs
└── settings.rs
```

Hay incluso herramientas de agente para crear reglas
(`crates/agent-tools/src/tools/create_categorization_rule.rs`) y contexto de
categorización con normalización de merchants
(`crates/agent-tools/src/tools/categorization_context.rs`).

Duplicar eso en el addon es, a primera vista, exactamente la clase de deuda
técnica que hay que evitar.

## Qué se verificó

`packages/addon-sdk/src/host-api.ts` define la interfaz `HostAPI` completa:

```
accounts, portfolio, activities, market, assets, quotes, performance,
exchangeRates, contributionLimits, goals, settings, files, snapshots,
secrets, storage, logger, events, navigation, query, network, toast
```

**No hay `spending`. No hay `taxonomies`. No hay `categorization`.**

Tampoco aparece en las categorías de permisos (`permissions.ts`), lo que
confirma que no es una omisión de tipos sino que no está expuesto.

## Alternativas evaluadas

### A. Usar el subsistema del core

Imposible hoy: no hay API. Descartada por verificación, no por preferencia.

### B. Escribir SQLite directamente

Descartada de plano. Rompe el aislamiento del sandbox, no sobrevive a una
migración de esquema, y contradice el principio de no tocar el core.

### C. No categorizar

Descartada. Sin categorías no hay «¿en qué gasté?», que es la mitad del
producto.

### D. Motor propio en el addon ✅

Reglas condición→acción y árbol de categorías en `core/rules` y
`core/categories`, persistidos en `ctx.api.storage`. La categoría también viaja
en `metadata.cat` de cada actividad, así que sobrevive aunque el
almacenamiento del addon se pierda.

## Decisión

Motor propio. Diseñado para poder retirarse:

1. La categoría de cada movimiento vive en `metadata.cat`, no solo en el
   almacenamiento del addon.
2. Las reglas usan vocabulario propio (`condition` / `action`) similar en forma
   al de Actual Budget y Firefly III, no una copia de su implementación.
3. `core/rules/engine.ts` es puro: migrar a una API host sería reescribir la
   capa de persistencia, no la lógica.

## Consecuencias

- Un usuario que categorice en la UI de Wealthfolio y en Wealthfolio Chile
  tendrá dos categorizaciones. Hay que decirlo en el README.
- Nuestras categorías no alimentan los presupuestos del core.
- Mantenemos código que upstream ya tiene.

## Qué pediríamos upstream

Una API mínima que eliminaría esta duplicación:

```ts
interface SpendingAPI {
  categories: {
    getAll(): Promise<Category[]>;
    create(category: NewCategory): Promise<Category>;
  };
  assignments: {
    set(activityId: string, categoryId: string): Promise<void>;
    get(activityIds: string[]): Promise<Record<string, string>>;
  };
}
```

Solo lectura de categorías y asignación por actividad. No hace falta exponer
reglas ni presupuestos: con eso bastaría para que la categorización del addon
alimente el motor del core.

**Antes de forkear por esto, se propone esa API upstream.** Es una necesidad que
cualquier addon de importación va a tener, no solo el nuestro.

## Cuándo revisar

En cada actualización de upstream, comprobar si apareció una API de spending:

```bash
grep -rn "spending\|categorization\|taxonom" .upstream/wealthfolio/packages/addon-sdk/src/
```

Si aparece, migrar y borrar `core/rules` y `core/categories` con gusto.
