# ADR 0001 — Addon sobre fork

- **Estado:** aceptado
- **Fecha:** 2026-08-05
- **Contexto:** Wealthfolio v3.6.2, Addon SDK 3.6.2

## Problema

Wealthfolio Chile necesita importar cartolas chilenas, deduplicar, conciliar
transferencias, detectar cuotas y mostrar análisis de gasto. ¿Se construye sobre
el SDK de addons o forkeando el core?

## Qué se verificó

Se clonó `wealthfolio/wealthfolio` en v3.6.2 y se leyó el código, no solo la
documentación. Resultados:

| Necesidad | ¿Alcanzable desde un addon? | Cómo |
| --- | --- | --- |
| Crear movimientos | Sí | `ctx.api.activities.saveMany({ creates })` |
| Leer movimientos | Sí | `ctx.api.activities.search()` paginado |
| Metadata propia por movimiento | Sí | `ActivityCreate.metadata` (JSON libre), devuelta en `ActivityDetails.metadata` |
| Estado propio del addon | Sí | `ctx.api.storage` (SQLite del host, ~250 KB por valor) |
| Páginas y navegación | Sí | `contributes.routes` + `contributes.links` en el manifiesto |
| Leer un archivo | **No** por API | Se resuelve con `<input type="file">` en el iframe |
| Reglas de categorización del core | **No expuesto** | Motor propio — ver ADR 0003 |
| Jobs en segundo plano | **No** | La importación es explícita; no la necesitamos |

Los tres "no" tienen solución dentro del addon y ninguno bloquea el MVP.

## Decisión

Construir como addon. No modificar el core.

## Consecuencias

**A favor**

- Cada release de Wealthfolio llega gratis. Upstream publica cada pocas semanas.
- La superficie a mantener es nuestra lógica, no un motor de portafolio en Rust.
- Distribuible: cualquiera puede instalar el ZIP sin compilar nada.
- El aislamiento del sandbox es una garantía de privacidad, no un estorbo.

**En contra**

- Sin acceso al subsistema `spending` del core; duplicamos reglas y categorías.
- Sin trabajo en segundo plano: la importación es siempre explícita.
- El bundle carga SheetJS (~700 KB) porque no puede pedírselo al host.

**Neutro**

- `.upstream/wealthfolio` se mantiene como checkout de referencia, ignorado por
  Git. No vendorizamos código.

## Cuándo reconsiderar

Un fork podría justificarse si apareciera **al menos uno** de estos, y solo
después de agotar las alternativas soportadas:

1. Necesitamos un tipo de dominio nuevo, imposible de expresar con las 14
   actividades canónicas más metadata.
2. Necesitamos metadata persistente que ni `metadata` ni `storage` puedan
   sostener (por volumen o por consultabilidad).
3. Necesitamos ejecutar trabajo mientras la app está cerrada.
4. Necesitamos integrarnos con el motor de `spending` del core de una forma que
   ninguna API host permita.
5. La reconciliación tiene que ocurrir dentro del cálculo de holdings.

## Proceso obligatorio antes de tocar el core

1. Identificar el problema concreto, con un caso de uso real.
2. Buscar una API oficial que lo resuelva.
3. Leer el código de upstream que lo implementa.
4. Revisar issues y roadmap de upstream.
5. Estudiar cómo lo resuelven los addons oficiales
   (`wealthfolio/wealthfolio-addons`).
6. Escribir un ADR `docs/adr/XXXX-core-fork-required.md` con: problema,
   limitación exacta del SDK, alternativas probadas, cambio mínimo necesario y
   costo de mantención.
7. **Considerar contribuir primero una API genérica upstream.** Una limitación
   que nos afecta a nosotros probablemente afecta a otros addons, y una API
   aceptada aguas arriba es infinitamente más barata que un fork.
8. Recién entonces, evaluar el fork.
