# Estado actual

Qué funciona **hoy**, verificado, y qué no.

Actualizado: 2026-09-03 · Wealthfolio v3.7.0 · addon 0.2.0-rc.1

---

## Cómo leer los estados

Cuatro niveles distintos, que esta documentación no mezcla:

| Nivel | Qué significa |
| --- | --- |
| **implementado** | El código existe y sus tests unitarios pasan |
| **integrado** | Está enganchado al flujo real del addon, no sólo disponible |
| **validado en host** | Se ejecutó contra un Wealthfolio v3.7.0 corriendo |
| **validado con banco real** | Se ejecutó contra una cartola real de ese banco |

**El proyecto está en *validado en host* contra 3.7.0.** Falta el último nivel:
ninguna cartola real ha tocado este código, y por eso la versión es un
release candidate y no un `0.2.0`.

---

## Verificación automática

```
typecheck   ✅  tsc --noEmit, strict + noUncheckedIndexedAccess
lint        ✅  eslint, 0 errores, 0 warnings, sin `any`
tests       ✅  582 pasando (34 archivos), incluidos 33 de UI sobre DOM
build       ✅  dist/addon.js — un solo archivo, 797 KB
package     ✅  wealthfolio-chile-<versión>.zip, 211 KB
coverage    ✅  93 % de líneas y 87 % de ramas sobre `src/core/`
```

`pnpm verify` corre typecheck, lint, tests y build.

---

## Compatibilidad

| Dato | Valor |
| --- | --- |
| Host | Wealthfolio **3.7.0** |
| `@wealthfolio/addon-sdk` | 3.7.0 |
| `@wealthfolio/ui` | 3.7.0 |
| `@wealthfolio/addon-dev-tools` | 3.7.0 |
| `minWealthfolioVersion` | 3.7.0 |
| Build target | chrome107, edge107, firefox104, safari16 |

El addon no usa ninguna API exclusiva de 3.7 (`ctx.assets`, `enable` async).
`minWealthfolioVersion` está en 3.7.0 igualmente porque es el único host contra
el que se ha verificado, y declarar soporte de una versión que nadie corrió es
la clase de afirmación que este proyecto no hace. Ver
[UPSTREAM.md](UPSTREAM.md).

---

## Validación contra host real (2026-09-03, Wealthfolio 3.7.0)

Diez escenarios, todos con datos sintéticos, ejecutados por la UI dentro del
iframe del host y verificados además por la API HTTP.

| # | Escenario | Resultado |
| --- | --- | --- |
| 1 | Importar una cartola válida | 5 movimientos creados, tipos y metadata v3 correctos |
| 2 | Reimportar el mismo archivo | 5/5 duplicados exactos, confirmar deshabilitado en 0 |
| 3 | Editar una actividad en Wealthfolio y reimportar | sólo esa fila baja a «posible duplicado», con el motivo visible; las otras 4 siguen siendo duplicados exactos |
| 4 | Cartola con una fila ilegible | importación bloqueada, **cero escrituras** (33 actividades antes y después) |
| 5 | Cartola CLP en una cuenta USD | bloqueada, con la razón concreta (moneda) y la que no se pudo comprobar (número de cuenta) |
| 6 | Devolución en tarjeta | `CREDIT/REFUND`, **no** pago de tarjeta |
| 7 | Pago recibido en tarjeta | `TRANSFER_IN`, clasificado como pago de tarjeta |
| 8 | Fechas ambiguas | orden resuelto para el archivo entero; ninguna advertencia por fila |
| 9 | Dos monedas en el mismo mes | métricas separadas por moneda, nunca sumadas |
| 10 | Conciliación | 2 pares confirmados, 2 sugeridos, 0 ambiguos, 3 pagos de tarjeta con su evidencia |

El escenario 6 **falló la primera vez** y ese fallo es el hallazgo más
importante de la sesión: Wealthfolio rechaza `UNKNOWN` en una cuenta de tarjeta
de crédito, y como `saveMany` valida el lote completo antes de escribir, una
sola fila sin clasificar costó los cinco movimientos. Ningún test unitario podía
verlo, porque el doble de test no modelaba la regla. Corregido y reverificado;
ver [UPSTREAM.md](UPSTREAM.md) § *Tipos de actividad permitidos por tipo de
cuenta*.

Los datos sintéticos de esta validación se eliminaron del host al terminar.

---

## Madurez por institución

| Institución / perfil | Parser | Fixture sintético | Test que lo parsea | Validado en host | Cartola real |
| --- | --- | --- | --- | --- | --- |
| Genérico — cuenta | ✅ | n/a | ✅ | ✅ (indirecto) | n/a |
| Genérico — tarjeta | ✅ | n/a | ✅ | ⬜ | n/a |
| Banco de Chile — cuenta corriente | ✅ | ✅ | ✅ | ✅ | ⬜ |
| Banco de Chile — tarjeta | ✅ | ✅ | ✅ | ⬜ | ⬜ |
| BancoEstado — CuentaRUT | ✅ | ✅ | ✅ | ✅ | ⬜ |
| Falabella / CMR — tarjeta | ✅ | ✅ | ✅ | ✅ | ⬜ |
| Falabella — cuenta corriente | ✅ | ✅ | ✅ | ⬜ | ⬜ |

`samples/private/` está vacío. **Ninguna institución tiene validación con
cartola real**, y los cinco perfiles bancarios siguen `pending-real-sample`: el
wizard lo advierte y el historial lo registra. Ver
[BANK_FORMATS.md](BANK_FORMATS.md).

---

## Qué decide el import antes de escribir

Tres gates independientes, y los tres se acumulan en vez de reportarse de a uno:

1. **La cartola se leyó entera.** Una fila que debía ser un movimiento y no se
   pudo leer bloquea la importación. Importar el subconjunto legible deja un
   hueco que después parece completo. `rowStats` cuenta filas de datos,
   mapeadas, omitidas y fallidas por separado, y el resumen las reporta tal
   cual.
2. **Se pudo comprobar si hay duplicados.** Si la lectura de los movimientos ya
   registrados falla o queda truncada, importar queda deshabilitado: «no se pudo
   comprobar» y «no hay duplicados» son respuestas distintas.
3. **La cartola corresponde a la cuenta.** Moneda distinta, número de cuenta
   distinto o una cuenta de instrumentos bloquean. Una cuenta sin número
   registrado no bloquea: se informa que no se pudo verificar.

El recorrido de saldos es evidencia, no dogma. Un desajuste aislado es error
sólo en un perfil que declara su columna de saldo `authoritative` —hoy ninguno
de los bancarios, porque nadie ha visto una exportación real—. Un desajuste
**sistemático** (≥50 % de los pasos, con un mínimo de 4) es error en cualquier
perfil: a esa proporción no es una rareza del banco, es que el archivo se está
leyendo mal.

---

## Wealthfolio es la fuente de verdad

El addon escribe metadata en cada actividad que crea. Desde el esquema 3 esa
metadata incluye `proj`, un hash de la actividad tal como se escribió, así que
una relectura puede distinguir «esto sigue siendo lo que creamos» de «el usuario
lo cambió y nuestra huella describe algo que ya no está».

- Un duplicado exacto contra una actividad editada baja a **probable**, con el
  motivo escrito en la fila. Saltarla en silencio perdería el movimiento
  original; importarla pondría una copia al lado de la editada.
- Al releer, el **tipo de actividad del host manda**. La clasificación cacheada
  sobrevive sólo mientras siga correspondiendo al tipo que el host realmente
  tiene, lo que conserva las distinciones que nuestro modelo hace y el tipo del
  host no puede expresar, y descarta sólo el desacuerdo real.
- Las filas escritas por 0.1.x no traen `proj`; para ellas la pregunta cae en
  `isUserModified`, que es el propio registro del host.

---

## Semántica del panel

Flujo de caja y gasto son preguntas distintas y se reportan por separado:

```
compra 100.000, devolución 20.000

caja    → entró 20.000, salió 100.000, neto −80.000
gasto   → bruto 100.000, devoluciones 20.000, neto 80.000
```

`income` significa dinero externo que entra; una devolución **no** es ingreso.
La tasa de ahorro es `(income − netSpending) / income`. Las categorías reportan
bruto, devoluciones y neto, y una devolución sin categoría no se atribuye a
ninguna.

Con más de una moneda en el mes el panel muestra un bloque por moneda y dice por
qué no las suma: `ExchangeRatesAPI` no publica tipos históricos, y convertir un
movimiento de hace ocho meses al tipo de hoy sería un número inventado más
difícil de detectar que el error que reemplaza.

---

## Conciliación

El motor empareja transferencias entre cuentas propias y pagos de tarjeta. Un
par se acepta sólo cuando la elección es **mutua** y las rondas se repiten hasta
que una no resuelve nada nuevo, porque las preferencias cambian a medida que se
consumen tramos. Lo que queda es un nudo genuino y se reporta una vez, con todos
sus tramos y sin proponer ninguno.

Hay una pantalla de revisión (`/addons/wealthfolio-chile/conciliacion`) que
distingue confirmados, sugeridos y sin decidir, con la evidencia de cada uno.
**Es de sólo lectura**: Wealthfolio no expone todavía a los addons una forma de
enlazar los dos tramos, y construir un ledger de pares propio es justo lo que
[ADR 0005](adr/0005-transferencias-y-tarjeta-en-el-host.md) descarta.

---

## No funciona / no está hecho

| Qué | Por qué |
| --- | --- |
| **Perfiles bancarios validados** | No hay cartolas reales. Los cinco perfiles bancarios siguen `pending-real-sample` |
| **Aplicar una conciliación** | El SDK 3.7.0 no expone `link`/`transfer-pair`. Ver ADR 0005 |
| **Editor de reglas y de categorías** | El motor y las 24 reglas predefinidas se aplican; no hay UI |
| **Pantalla de ajustes** | `verboseLogging`, `transferWindowDays` y las reglas desactivadas se leen de `storage`; no hay dónde editarlas |
| **Conversión de moneda** | El SDK no publica tipos de cambio históricos |
| **Servicio importador, IA/MCP propio, Fintoc** | Decisiones D10-D12; ver [DECISIONS.md](DECISIONS.md) |
| **Licencia** | Decisión pendiente del propietario. Todo declara `UNLICENSED` |

---

## Siguiente paso recomendado

Calibrar los perfiles con cartolas reales privadas, siguiendo
[BANK_FORMATS.md](BANK_FORMATS.md) § *Cómo calibrar un perfil*. Es lo único que
separa este release candidate de un `0.2.0`.

Para CMR sigue abierta la pregunta que decide todo el cálculo de deuda
comprometida: si una columna `Monto` sin etiquetar es el valor de la cuota o el
total de la compra. Mientras no haya evidencia, la fila se marca
`ambiguous-installment-amount` y el plan no deriva el total de la compra.
