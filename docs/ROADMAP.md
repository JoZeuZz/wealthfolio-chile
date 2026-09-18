# Roadmap — dirección de producto post-rc.6

Roadmap canónico. Reemplaza toda versión anterior de este documento. Git
conserva el historial de lo que decía antes; no se preserva aquí "por si
sirve" nada que la evidencia actual contradiga.

Base de esta revisión: **v0.2.0-rc.6**, commit
`1df6122aa9e4d80df449176adea0760c36f1e7c9` (== `main` publicado). Investigación
detallada, fuentes y desviaciones respecto de la propuesta inicial:
`.ai/research/post-rc6-product-research.md` (research de trabajo, no oficial).
Revisión independiente y correcciones de evidencia:
`.ai/research/post-rc6-independent-product-review.md` (research de trabajo,
no oficial).

---

## 1. Visión

Wealthfolio Chile ayuda a una persona en Chile a entender, sin adivinar, en
qué se le va el sueldo: importa sus cartolas, evita contar dos veces una
transferencia o un pago de tarjeta, reconstruye qué cuotas lleva, y explica
los costos de tener y usar sus tarjetas — todo local, sin conexión a ningún
servidor, apoyado en lo que Wealthfolio ya hace bien.

## 2. Identidad del producto

**Wealthfolio Chile es la capa de interpretación financiera chilena de
Wealthfolio.**

Su trabajo:

- interpretar documentos y movimientos financieros chilenos;
- transformar esa información en Activities financieramente correctas;
- entender semántica bancaria chilena que Wealthfolio genérico no puede
  conocer (Transbank, CMR, Redcompra, avances en efectivo, PAC/PAT, NCG 537);
- distinguir consumo, deuda, transferencias, pagos, devoluciones, intereses,
  comisiones, impuestos, avances y cuotas;
- explicar merchants/procesadores/glosas chilenas;
- aprovechar las capacidades nativas de Wealthfolio en vez de duplicarlas.

La diferenciación defendible no es exclusividad frente a competidores. Es
semántica chilena auditable, privacidad local y separación explícita entre
compra, pago, devolución, avance en efectivo y costo financiero. Los claims
publicados de Kuanto y Kane se solapan parcialmente; su calidad real no fue
auditada.

```
Wealthfolio Chile:  "¿qué significa económicamente este movimiento en Chile?"
Wealthfolio:        "¿cómo administra, presenta y agrega el ledger completo?"
```

**No** queremos que el addon se convierta en otra aplicación financiera
completa, otro motor de presupuestos genérico, otro ledger, otro sistema de
inversiones, ni en un fork de Wealthfolio. Ver §20.

## 3. Principios

1. El host es la fuente de verdad. El addon propone; el host decide.
2. Dinero entero (`Money`), nunca float. Fechas civiles (`YYYY-MM-DD`), nunca
   `Date`/timestamp para lógica bancaria.
3. Vista previa antes de escribir, siempre.
4. Nada infla ingresos ni gastos: transferencias y pagos de tarjeta netean a
   cero **cuando ambos lados están clasificados correctamente**. Esto no es
   una garantía estructural del host: el emparejamiento de las dos patas se
   propone pero no se aplica (D17, ADR 0005), y si un lado se clasifica mal
   o se importa sin su contraparte, nada lo detecta automáticamente hoy. El
   informe de gasto nativo de Wealthfolio, además, puede contar distinto una
   fila degradada por sustitución de tipo (D19).
5. Un avance en efectivo no es una compra. Un pago de tarjeta no es un gasto.
   Un procesador no es un comercio. Un abono de tarjeta no es
   automáticamente `credit_card_payment` — puede ser un `refund`.
6. Determinista primero, IA nunca en el runtime financiero.
7. Ausente no es cero. Un hecho declarado por el documento se lee; nunca se
   calcula un pago mínimo, un CAE ni una CTC.
8. Si Wealthfolio ya resuelve algo bien, integrarlo es mejor que duplicarlo
   — y antes de duplicar, se propone la API que falta aguas arriba (ADR 0001).
9. "Implementado", "integrado", "validado en host" y "validado con banco
   real" son estados distintos y no se confunden en commits ni en docs.
10. Cambios sobre dinero, clasificación, dedupe, importación, transferencias,
    cuotas o FX requieren tests de regresión.

## 4. Estado de partida (v0.2.0-rc.6)

Verificado con `pnpm verify` sobre el commit publicado el 2026-09-16:
**1627 tests, 88 archivos, exit 0**; build `dist/addon.js` 935,15 KB
(247,03 KB gzip). Coincide con `README.md` y `docs/CURRENT_STATE.md`.
`addon/README.md` tenía un conteo desactualizado (1301) — corregido como
parte de la higiene documental de esta fase.

Arquitectura real (`core/` → `services/` → `ui/`), verificada sin cambios
respecto de lo documentado en `docs/ARCHITECTURE.md`.

Lo que existe y funciona hoy, con su nivel de evidencia real (no de
intención): ver `docs/CURRENT_STATE.md` y `docs/BANK_FORMATS.md`, que se
mantienen como fuente de verdad operativa y no se repiten aquí. Resumen:

- Banco de Chile (cuenta corriente + tarjeta nacional, Internacional
  fail-closed), BancoEstado CuentaRUT, Falabella/CMR tarjeta, Falabella
  cuenta corriente (sin calibrar) — **calibración estructural real** para
  los primeros tres. Ningún perfil tiene `kind` confirmado exhaustivamente
  contra cartola real, pero Falabella/CMR **sí** tiene evidencia parcial real
  de clasificación: de 130 filas reales calibradas, 13 tenían glosa que el
  banco emite como línea propia de pago, ancladas al inicio con el marcador
  `PAGO TARJETA` (agregado a `CARD_SIDE_PAYMENT_MARKERS` a partir de esas
  mismas filas — no es una confirmación independiente, es la evidencia que
  originó la regla), y 2 con los marcadores de reversa existentes coinciden
  con `refund` (`docs/BANK_FORMATS.md`, D23). No es evidencia exhaustiva ni
  independiente — es la única evidencia de `kind` contra cartola real que
  existe hoy, y el gate §6.4 sigue dependiendo del workflow humano (§7) para
  una confirmación real, no de esta cifra.
- Import CSV/TXT/XLS/XLSX; PDF sólo evidencia de calibración, no importable.
- Dedupe exact/probable/legacy; reconciliación implementada pero read-only
  (SDK no expone `link`/`unlink`/`transfer-pair`, ver ADR 0005).
- Costos financieros (D20), atribución de comercio (D21 — procesador ≠
  comercio, no "atribución de pago"), hechos del estado de cuenta (D22) y
  semántica de cuotas facturadas (D23) — modelados con evidencia regulatoria
  OFFICIAL; `StatementFacts` (D22) sin confirmación real de sus diez campos
  declarados, `kind` de cuotas/pagos (D23) con la evidencia parcial descrita
  arriba.
- SDK build 3.8.0, `minWealthfolioVersion` 3.7.0 (deliberado — ninguna
  superficie 3.8-only se usa).

### 4.1 Qué significa el claim de `0.2.0`

`0.2.0` **no** significa "Chile completo". Significa: el conjunto de
productos explícitamente anunciados como soportados tiene importación
financieramente segura, evidencia estructural real suficiente, semántica
validada para las clases observadas (§6.4, §7) y dogfooding del artefacto
publicado (§6.1). Baseline esperado si la evidencia no cambia antes del
cierre, verificado contra `docs/CURRENT_STATE.md` (tabla "Madurez por
institución" y "Calibración estructural") al escribir esta sección:

| Estado | Perfil |
| --- | --- |
| **CANDIDATO A SOPORTE ESTABLE EN 0.2.0** | BancoEstado CuentaRUT |
| **CANDIDATO A SOPORTE ESTABLE EN 0.2.0** | Banco de Chile cuenta corriente |
| **CANDIDATO A SOPORTE ESTABLE EN 0.2.0** | Banco de Chile tarjeta Nacional |
| **CANDIDATO A SOPORTE ESTABLE EN 0.2.0** | Falabella/CMR Movimientos Facturados XLSX |
| **EXPERIMENTAL** | Falabella cuenta corriente |
| **UNSUPPORTED** | Banco de Chile tarjeta Internacional |
| **UNSUPPORTED** | Import PDF (sólo calibrable, no importable) |

"Candidato a soporte estable" es estructural/de formato — los cuatro
candidatos ya calibraron estructura contra cartola real
(`docs/CURRENT_STATE.md`). Ninguno tiene todavía `kind` validado contra
cartola real, ninguno tiene todos los P1/stable blockers de §6.2 cerrados
(`builtin.traspaso-cuenta`, dedupe/provenance uncertainty, tarjeta `unknown`),
y `0.2.0` mismo no existe todavía como release estable. Ninguno de los cuatro
se llama `STABLE` hasta cerrar **todos** los gates de §6 — la calibración
estructural real es necesaria pero no suficiente. No inventar `stable` donde
la evidencia estructural, la semántica o los blockers funcionales no
alcancen.

## 5. Objetivo inmediato

Convertir rc.6 en evidencia de estabilidad real y cerrar `0.2.0`. No hay
features grandes nuevas hasta que ese cierre ocurra. Plan de implementación
concreto: `.ai/plans/phase-0.2.0-stable-evidence.md`.

## 6. Gates de 0.2.0

`0.2.0` es evidencia y dogfood, no features. Se promueve sólo cuando todos los
siguientes gates tienen observación escrita:

1. **Provenance de artefacto final.** `pnpm verify` sobre commit final, luego
   un ZIP construido una vez, SHA-256 y manifest registrados, instalación de
   esos mismos bytes SHA-256 en mínimo 3.7 y baseline 3.8, y escenarios.
   Cualquier fix reinicia commit, ZIP, hash, instalación y escenarios.
2. **Calidad y host.** Cero P0/P1. La matriz completa corre sobre bytes exactos
   del mismo ZIP SHA-256 en 3.7 y 3.8: import inicial y reimport exacto, que
   crea cero Activities; edición del host, que deja la Activity probable y nunca
   la sobreescribe; siguiente ciclo de cuota, que sigue `new`; devolución distinta
   de pago de tarjeta; pago
   de tarjeta distinto de gasto o ingreso; transferencia propia distinta de
   transferencia a tercero — incluida explícitamente una glosa `TRASPASO` de
   cuenta corriente a un tercero, que `builtin.traspaso-cuenta`
   (`core/rules/builtin.ts`) marca hoy `internal_transfer` sin mirar la
   contraparte (P1/stable blocker confirmado por lectura de código, ver D19) —
   o ésta queda fail-safe en revisión; principal de
   avance fuera de consumo y costo financiero; interés, comisión e impuesto con
   signo y mapping correctos; CLP/USD nunca sumados; Internacional fail-closed;
   fila ilegible con cero escrituras; conflicto CMR legacy; una fila de tarjeta
   cuyo significado económico siga `unknown` nunca cruza a `Expense` sin
   revisión explícita o bloqueo (ver D14, principio fail-safe de tarjeta); y
   dedupe unavailable/truncated bloqueando importación. Esto último es más
   amplio que las dos transiciones legacy conocidas: el riesgo real es
   **dedupe uncertainty** — el disparador no es "la metadata de procedencia
   propia no se puede leer" (metadata legible no implica procedencia
   utilizable: `parser`/`parserVersion`/`fileHash` pueden faltar en una
   Activity con `fp` legible, y el guard `legacy-source-conflict` está
   scoped por `sourceFileHash`, así que una misma cartola re-descargada con
   bytes distintos lo deja sin evaluar aunque la metadata existente sea
   perfectamente legible) — el disparador real es que, para un candidato
   dado, **ni la huella fuerte ni el guard de procedencia
   (`legacy-source-conflict`) puedan pronunciarse**, y las señales
   observables que quedan (huella débil por cuenta/fecha/monto + similitud
   de descripción) tampoco alcancen para probar que el movimiento es nuevo.
   Cuando eso ocurre, la fila puede salir `new` y duplicarse en silencio si
   `willImport` queda true (ver D6, adenda 2026-09-17, casos (1) y (2) —
   `legacy-source-conflict` es el caso concreto (1), acotado a dos
   transiciones parser conocidas; el caso (2), sin relación con ellas ni con
   legibilidad de metadata, es más general). La política/algoritmo exacto de
   bloqueo sigue **abierto** para diseño + TDD en Fase 0
   (`.ai/plans/phase-0.2.0-stable-evidence.md`, Tarea 1): tiene que evitar
   duplicación silenciosa sin bloquear masivamente Activities manuales,
   imports nativos del host, Activities de otros addons ni movimientos
   genuinamente distintos.
3. **Claims por perfil.** Cada perfil publicado tiene matriz de
   `synthetic-tested`, `host-validated`, `real-structure-calibrated` y
   `real-semantics-validated`. Falabella cuenta corriente obtiene evidencia
   estructural o queda visible como experimental, fuera del claim estable.
4. **Semántica.** Workflow de §7 con conteos, dirección y evidencia real. No
   se usa un porcentaje global. El gate exige cero mismatches semánticos **no
   explicados** en las filas etiquetadas por el propietario, con severidad
   especial para `internal_transfer` vs. transferencia a tercero, `credit_card_
   payment`, `credit_card_purchase`, `refund`, `cash_advance`, `fee`,
   `interest`, `tax` y dirección. Una clase que no aparece en la muestra real
   no se fabrica ni bloquea por su mera ausencia, pero tampoco se declara
   validada — queda sin evidencia para esa clase. Todo mismatch observado
   termina como corregido, limitación explícita documentada, o blocker. `k=5`
   y la supresión complementaria son del reporte agregado compartible (§7.4),
   no del gate local — la validación local trabaja sobre las filas propias del
   propietario sin exportar su detalle. **Decisión explícita del propietario,
   tomada en la sesión de reconciliación post-rc6 (2026-09-17)** — no una
   inferencia de este documento; ya no queda **OPEN** la forma del gate. Sigue
   **OPEN**, si el propietario quiere fijarlo, sólo un tamaño mínimo de
   muestra total por perfil al ejecutar §7 — no bloquea la forma del gate ya
   decidida arriba.
5. **D14.** El principio fail-safe de tarjeta (una fila `unknown` nunca cruza
   a `Expense`/`Income` sin revisión o bloqueo explícito) ya está decidido —
   ver adenda D14 — y su implementación con test de regresión es blocker de
   Fase 0 independiente del resto. Lo que el propietario decide explícitamente
   es sólo si una fila `unknown` llega marcada o desmarcada por defecto en la
   vista previa; falta de evidencia real mantiene ese eje **OPEN**, y no cierra
   este gate hasta que el principio fail-safe esté implementado, con o sin esa
   decisión de default.
6. **Privacidad.** Sin datos reales en Git, `.ai/`, logs o reportes; sin relajar
   `pnpm calibrate`.
7. **Distribución y licencia.** Licencia decidida, repositorio público, manifest
   raíz legible y SDK 3.6+ si se busca publicación comunitaria. Un listado es
   descubrimiento, no auditoría, respaldo ni distribución por Wealthfolio.

No inventar evidencia ni convertir un bloqueo de evidencia en cierre de gate.

## 7. Validación semántica privacy-safe (crítico)

`pnpm calibrate` protege privacidad deliberadamente no exponiendo glosas —
eso es correcto y no se relaja. Pero eso también impide comprobar `kind`
contra la realidad. Esta sesión documental no implementa el workflow. Fase 0
debe implementarlo y el propietario debe ejecutarlo localmente contra una
muestra privada real; tests sintéticos no cierran `real-semantics-validated`.
Sólo el reporte agregado con supresión sale de esa máquina. Workflow
**human-in-the-loop** local:

1. El usuario, en su propia máquina, etiqueta filas reales de su propia
   cartola con un vocabulario cerrado. **No cerrado todavía en este
   documento**: `core/model/kinds.ts` tiene doce `TransactionKind` reales
   (`income`, `expense`, `internal_transfer`, `credit_card_payment`,
   `credit_card_purchase`, `cash_advance`, `refund`, `fee`, `interest`,
   `tax`, `investment`, `unknown`), y un vocabulario de etiquetado humano
   más corto para no abrumar al usuario tendría que decidir explícitamente
   cómo colapsar `expense`/`credit_card_purchase` (consumo con cash vs. deuda
   de tarjeta — semánticas distintas, no da igual fusionarlos) y si
   `investment` entra o se excluye a propósito. **Un colapso ingenuo es
   peligroso, no sólo impreciso**: si el vocabulario junta `internal_transfer`
   (transferencia entre cuentas propias, netea a cero) con una transferencia
   a un tercero (sí es gasto real) bajo una sola etiqueta `transfer`, la
   clase de error que más corrompe el patrimonio —contar de más o de menos
   una transferencia— queda invisible en el propio reporte que existe para
   detectarla. Esta etiqueta es, además, **obligatoria, no opcional**: hoy
   `builtin.traspaso-cuenta` (`core/rules/builtin.ts`) marca
   `internal_transfer` cualquier glosa de cuenta corriente que contenga
   `TRASPASO`, sin condición sobre la contraparte, así que una transferencia
   a un tercero puede salir hoy del total de gasto por esa vía sin que nada
   lo detecte — es el caso que este workflow existe para exponer.
   **La función no puede ser ciega a la dirección**: dirección (`in`/`out`)
   no es un monto, así que incluirla no toca la frontera de privacidad, y es
   necesaria porque el mismo `TransactionKind` cambia de sentido económico
   según la dirección (`fee`/`interest` son income o spending según entren o
   salgan, `core/model/kinds.ts`; un `credit_card_payment` es `in` en la
   tarjeta y `out` en la cuenta que paga) y porque "transferencia a un
   tercero" no es un solo `TransactionKind` — es `expense` si sale e `income`
   si entra. El vocabulario final tiene que ser una función total y
   verificada contra el par (`TransactionKind`, dirección) — no contra
   `TransactionKind` solo: cada (etiqueta humana, dirección) mapea a
   exactamente un `TransactionKind`, y todo (`TransactionKind`, dirección)
   clasificable es alcanzable por alguna etiqueta — con test de esa
   propiedad **y** un test de que la misma etiqueta con dirección opuesta se
   reporta como mismatch, nunca como match. Esa reconciliación es tarea de
   diseño de la Tarea 2 del plan de Fase 0, no una decisión ya tomada aquí.
2. El usuario etiqueta local e independientemente `expectedKind` y
   `expectedDirection`. El comparador enfrenta
   (`expectedKind`, `expectedDirection`) contra (`actualKind`,
   `actualDirection`).
3. El agente nunca ve ni el reporte compartido contiene glosa, monto, RUT,
   cuenta, tarjeta, titular, archivo, hash, fila, orden o id.
4. La comparación detallada queda local. Exportar o compartir sólo permite
   conteos agregados por `provider`, `parserVersion`, `expectedKind`,
   `expectedDirection`, `actualKind`, `actualDirection` y regla. Los rule IDs
   salen de una allowlist fija; cualquier otro valor es `other`. Compartir aplica
   supresión mínima `k=5` y supresión complementaria para que los marginales no
   revelen celdas ocultas.
5. El gate usa conteos y denominadores, no porcentajes solos: cero mismatches
   semánticos no explicados en las filas etiquetadas, con severidad especial
   para `internal_transfer` vs. transferencia a tercero, pago de tarjeta,
   compra, devolución, avance, comisión, interés, impuesto y dirección — ver
   §6.4 para la forma exacta, decidida explícitamente por el propietario en
   la sesión de reconciliación post-rc6 (2026-09-17). El único eje que puede
   seguir **OPEN** es un tamaño mínimo de muestra total por perfil, a
   criterio del propietario al ejecutar el workflow.

Diseño detallado, decisión de dónde vive el etiquetador (¿UI del addon?
¿script local aparte?) y tareas concretas: `.ai/plans/phase-0.2.0-stable-
evidence.md`. No se implementa en esta sesión documental. Fase 0 debe
implementarlo y el propietario ejecutarlo localmente contra evidencia real.

## 8. Fases y releases

Cada fase distingue, cuando corresponde: RESEARCH · DESIGN · IMPLEMENT · HOST
VALIDATION · REAL SAMPLE VALIDATION · RELEASE. Ningún banco se declara
"soportado" antes de tener evidencia estructural real.

### Fase 0 — `0.2.0`: estabilidad + evidencia semántica real

**Objetivo.** Convertir rc.6 en un release estable con evidencia, no una
promesa de features nuevas.
**Por qué.** rc.6 es el baseline publicado que se dogfoodea primero; Fase 0 ya
contiene blockers concretos que deben reproducirse, diseñarse y corregirse
antes de stable — `builtin.traspaso-cuenta` marcando `internal_transfer` una
transferencia a tercero (D19), dedupe/provenance uncertainty que puede dejar
pasar duplicados en escenarios concretos (D6, §6.2), y una fila de tarjeta
`unknown` que puede acabar sustituida por un `ActivityType` que el host cuenta
como gasto (D14/D18/D19). 1627 tests y la validación de host existente
respaldan lo que ya se probó; no cubren estos tres blockers, que son
correctitud pendiente, no evidencia pendiente.
**Dependencias.** Ninguna externa — todo el trabajo es interno al proyecto.
**Evidencia necesaria.** Ver gate §6.
**Gate de inicio.** rc.6 publicado y dogfood-eable (cumplido).
**Gate de cierre.** §6 completo.
**Riesgos.** Ninguna cartola real disponible aún para varios pasos — mitigado
por el workflow de §7, que no depende de tener una cartola de cada banco.
**Qué no hacer.** No bump de versión, no features nuevas, no relajar
privacidad, no declarar `validated` sin evidencia.

**Secuencia aproximada.**

1. Dogfood del artefacto publicado rc.6 — establece evidencia sobre el
   artefacto actual.
2. Reproducir los blockers conocidos: `TRASPASO` de cuenta corriente a
   tercero (D19), dedupe uncertainty (D6, §6.2, no sólo las dos transiciones
   legacy), tarjeta `unknown` sustituida (D14/D18/D19).
3. Diseñar e implementar los fixes vía TDD.
4. `pnpm verify` / validación de host sobre el commit con los fixes.
5. Si hubo **cualquier** cambio funcional: crear un nuevo release candidate
   (previsiblemente rc.7; el número exacto se decide al publicar).
6. Construir una vez el artifact de ese RC; registrar SHA-256 y manifest
   — obligatorio, no condicional (ver §6.1: bloquea release).
7. Instalar y dogfood-ear exactamente esos bytes.
8. Implementar la herramienta mínima de validación semántica privacy-safe
   (§7) y que el propietario la ejecute localmente sobre muestra real. Si
   esta implementación toca código embarcado en el addon (bundle, `src/
   addon.tsx`), el ZIP de los pasos 6-7 deja de ser el artefacto final:
   volver al paso 4.
9. Decidir el claim de soporte de Falabella cuenta corriente; decisión de
   licencia (D13, sigue OPEN). Ninguna de las dos cambia código embarcado.
10. Cerrar los gates de estable de §6 **sobre ese RC** — nunca antes de
    haberlo construido y dogfood-eado si hubo cambio funcional.
11. Sólo entonces evaluar/promover `0.2.0`.

No debe leerse como "fix → cerrar gates de estable → publicar RC": el RC
corregido se prueba **antes** de cerrar la evaluación estable, nunca después.
Como ya existen blockers que previsiblemente requieren código, rc.6 no puede
promoverse directamente a `0.2.0` si esos blockers se confirman y corrigen
mediante cambios funcionales.

Trabajo concreto: `.ai/plans/phase-0.2.0-stable-evidence.md`.

### Fase 1 — `0.3.x`: plataforma de importación chilena

**Objetivo.** Diagnóstico de formato, generalización de la evidencia semántica
que Fase 0 ya implementó y ejecutó en su versión mínima, import batch y
selector manual antes de ampliar parsers. La validación semántica **no** se
implementa por primera vez aquí — eso es gate de cierre de `0.2.0` (§6.4,
§7) — esta fase la extiende e integra con diagnóstico de formato, onboarding
de bancos nuevos, batch y selector manual. **Gate.** `0.2.0` con evidencia
cerrada. **Cierre.** Diagnóstico probado, flujo batch/manual y al menos un
perfil nuevo con evidencia estructural real, o diferido explícitamente.
**Qué no hacer.** No implementar un perfil sin muestra de consumidor o fuente
del producto correcto que pruebe formato y convención de signo.

Trabajo:

**A. Diagnóstico de formato desconocido.** Cuando el pipeline no reconoce una
cartola, generar un reporte privacy-safe (tipo de archivo, hojas, forma de
headers, cantidad de filas, tipos de celda, patrones de fecha, formatos
numéricos, señales estructurales) para poder pedir/priorizar soporte — nunca
datos financieros reales. RESEARCH: ya cubierto por el diseño de
`pnpm calibrate` existente, que ya no expone contenido; extender su output a
"formato no reconocido" es DESIGN + IMPLEMENT.

**B. Import batch/histórico.** Múltiples cartolas a la vez, detección por
archivo, agrupación banco/cuenta, cuenta de destino sugerida, dedupe entre
archivos siempre scoped por `accountId`, preview individual y confirmación
explícita. Índice unavailable/truncated de cualquier cuenta destino bloquea esa
cuenta/importación; nunca se asume que no hay duplicados. Nunca auto-write.

**C. Selector de parser manual.** Cuando la detección es ambigua, mostrar
confianza/evidencia de cada candidato y dejar elegir explícitamente — el
mecanismo de puntaje ya existe en `core/providers/profile-parser.ts`, falta
la UI que lo exponga en el caso ambiguo.

**D. Generalización del tooling de validación semántica.** La herramienta
mínima de §7 ya existe desde Fase 0. Aquí se integra con el diagnóstico de
formato desconocido (A), con el onboarding sample-first de bancos nuevos
(§8.1) y con el flujo batch (B) — mismo comparador y mismo reporte agregado
con supresión, aplicado a más proveedores y a más volumen, no una
herramienta nueva.

### 8.1 Cola de perfiles, sample-first

Falabella cuenta corriente queda **EXPERIMENTAL/sin calibrar** hasta
conseguir muestra real (§4.1): el parser se mantiene, no se retira, pero no
forma parte del claim de soporte estable de `0.2.0`. Si aparece evidencia
real antes del release, se evalúa promoción con los mismos nueve pasos de
`docs/REAL_SAMPLE_WORKFLOW.md` que ya usan los otros perfiles. Después, entra
primero la muestra de consumidor disponible. Si
llegan varias, desempatar por demanda observada, coincidencia con producto de
personas, formato reutilizable, calidad de evidencia y costo de mantenimiento.
No hay ranking fijo por banco.

BCI 360Connect y Banco de Chile Banconexión aportan evidencia empresarial, no
prueba de Mi BCI o Banco de Chile personas. Mercado Pago documenta conciliación
de vendedores/plataforma, no prueba de export de cuenta personal. Ninguno entra
como parser comprometido sin evidencia del producto objetivo.

**Mercado Pago: decisión de alcance pendiente.** No es un banco con cuenta
corriente ni tarjeta de crédito tradicional; su "cartola" es un reporte de
transacciones de plataforma. `StatementProduct` (`core/model/statement.ts`)
ya tiene cinco valores (`checking`, `savings`, `credit_card`, `credit_line`,
`unknown`), no dos — la pregunta real no es "¿hace falta un segundo valor?"
sino si Mercado Pago encaja en `unknown`/`checking` o si merece un valor
propio, dado que catorce módulos de `core/` ramifican sobre `StatementProduct`
(convención de signo, clasificación por defecto, `classify/card-semantics.ts`,
`reconcile/credit-card.ts`). Pregunta de diseño abierta, no resuelta aquí.

### Fase 2 — `0.4.x`: PDF de primera clase

**Objetivo.** Vertical slice PDF CMR con capa de texto. PDF es multiplicador
plausible, no techo probado de cobertura chilena. **Prerequisito duro antes de
escribir:** identidad de estado account-scoped con `accountId`, proveedor,
producto y período de facturación declarado o evidencia de layout. XLSX→PDF y
PDF→XLSX crean el ciclo una vez; reimports del mismo formato deduplican; cuentas
distintas siguen aisladas; identidad ambigua bloquea. La identidad vive en
metadata de Activities del host, nunca en ledger paralelo. Métricas por
proveedor, producto y layout; ningún claim agregado de Chile sin denominador.
Sin OCR, IA ni red.

Arquitectura: `PDF bytes → text extraction → document blocks/tables →
provider signature → StatementFacts → movement tables → NormalizedStatement`.
PDF v1 fija límites de tamaño, páginas y tiempo; reconstruye con coordenadas y
labels, no texto lineal solo; no registra texto derivado del PDF; y preview lista
secciones excluidas o no parseadas. Sin capa de texto, orden ambiguo o layout no
reconocido: fail-closed, cero escrituras. CMR sigue siendo primer candidato (ya
hay evidencia real de calibración); después, priorizar según qué muestra real
llegue primero.

### Fase 3 — Estado de tarjeta chileno y `StatementFacts`

`StatementFacts` acompaña trabajo PDF/tarjeta. Gate por
`(provider, layoutVersion, field)`: `present-and-correct`, `absent`,
`unsupported` o `unobserved`. No exige diez campos en un estado ni inventa
evidencia para campos no observados. Un hecho declarado nunca crea Activities
ni calcula campos faltantes. Resultado útil: vista local de obligaciones con
monto facturado, vencimiento, mínimo, moneda y provenance declarados; sin
promesa de alertas en background.

### Fase 4 — Costos financieros (profundización)

Modelo económico en cuatro vistas: caja, consumo, costos financieros y
deuda/financiamiento. Las nueve familias nombradas en D20 siguen modeladas. La
madurez por proveedor distingue `modelled`, `synthetic-tested` y
`real-semantics-validated`. No observar una familia significa que aún no tiene
validación semántica real: queda `unobserved`. Cada familia afirmada requiere
ejemplos positivos y near-negative. Un avance no es consumo; su principal no es
costo financiero. Impuesto de timbres vigente: 0,066% mensual o fracción, tope
0,8%. Se conserva `credit_tax`, sin cálculo ni tasa hardcodeada.

### Fase 5 — Merchant intelligence Chile

`processor != merchant` se mantiene. Prioridad: provenance, candidato y
corrección/alias local confirmado por usuario, no catálogo masivo. Nunca
sobrescribir descriptor original. Destino de reglas queda **OPEN** entre addon
y `SpendingAPI`; no crear dos motores de categorías. No se afirma que ningún
competidor resuelva merchant UX.

### Fase 6 — Integración con Wealthfolio Spending

`SpendingAPI` no absorbe semántica de clase transaccional chilena. Puede poseer
categorías y reglas personales nativas cuando se adopte una feature 3.8-only.
Elevar mínimo a 3.8 depende de esa feature y costo de soporte observado, no de
preferencia por número de release. No mantener dos motores de categoría
personal.

### Diferido, no-goal — gastos compartidos y reembolsos

Fuera de fases versionadas y fuera de gate 1.0. Kuanto se solapa en esta
capacidad. Sólo reconsiderar con demanda específica del addon y resolución de
propiedad entre host y upstream; no convertir una transferencia en refund ni
crear modelo financiero profundo sin revisión separada.

### Fase 8 — Conciliación nativa

**Objetivo.** Si el SDK expone `link`/`unlink`/`transfer-pair`, usar la API
nativa y retirar el motor propio de conciliación aplicada.
**Por qué.** ADR 0005 sigue vigente: el motor existe y está testeado, pero
la pantalla es read-only porque el SDK 3.8.0 sigue sin exponer esas
operaciones (confirmado con código real).
**Dependencias.** 100% de upstream. No se puede forzar.
**Evidencia necesaria.** Confirmación en un release publicado del SDK, no en
un PR o issue sin verificar directamente.
**Gate de inicio.** Ninguno — se puede seguir el SDK release a release desde
ahora.
**Gate de cierre.** API nativa disponible y usada; motor propio retirado.
**Riesgos.** Si nunca se publica, la pantalla sigue read-only
indefinidamente — aceptable, documentado.
**Qué no hacer.** Construir ledger de pares propio, HTTP interno del host o
conciliación aplicada paralela. Sigue sólo lectura hasta API nativa del SDK.

### Fase 9 — Multimoneda / FX

**Objetivo.** Sólo vía `ExchangeRatesAPI.getRatesForDates`, manteniendo monto
original y sin reescribir Activities históricas. La tasa `number` del SDK se
convierte en frontera explícita decimal/racional; aritmética monetaria sigue
entera, con un redondeo documentado. `null` o tasa sin provenance producen total
parcial/aproximado o ninguna conversión.
**Advertencia de diseño, no resuelta por la API.** `getRatesForDates`
**no** distingue en su respuesta una tasa exacta de la fecha pedida de un
fallback a "última cotización disponible" — `ExchangeRateDateResult` sólo
trae `{fromCurrency, toCurrency, date, rate, error}`, y `date` es la fecha
**pedida**, no la fecha real de la cotización usada. Presentar ese `rate`
como "el tipo de cambio de esa fecha" sin poder acreditarlo sería una cifra
tan inventada como calcular un pago mínimo propio. El diseño tiene que
decidir cómo marcar una conversión no acreditable como aproximada (o no
convertir), y cómo reportar un total con pares sin resolver como parcial,
nunca como total cerrado.
**Por qué.** El bloqueo técnico ("no hay tasa histórica") ya no existe. Lo
que falta es diseño de producto (pantallas, redondeo, manejo de `rate: null`
y de una tasa no acreditable a la fecha) y decisión de costo de
compatibilidad.
**Dependencias.** Decisión de `minWealthfolioVersion`, compartida con Fase 6.
**Evidencia necesaria.** Ninguna adicional — la API ya está confirmada, con
la limitación de provenance arriba.
**Gate de inicio.** Decisión de subir el mínimo de host tomada.
**Gate de cierre.** Conversión de métricas funcionando sin reescribir
histórico, con manejo explícito de `rate: null` **y** de tasa no acreditable
a la fecha solicitada; ningún total mixto se presenta como cerrado si algún
par quedó sin resolver.
**Riesgos.** Perder compatibilidad con hosts 3.7.x. Presentar una tasa
obsoleta como si fuera la del día del movimiento.
**Qué no hacer.** Motor FX privado, float para dinero, UTM/CLF sin fundamento
ni presentar fallback como tasa exacta de fecha.

Banco de Chile Internacional sigue fail-closed hasta evidencia real
suficiente — sin cambio.

### Fase 10 — Open Finance Chile (SFA)

**Objetivo.** No construir nada todavía; mantener la posibilidad
arquitectónica (`file → NormalizedStatement`, `SFA → NormalizedStatement`,
mismo pipeline financiero) sin implementarla.
**Por qué.** CMF comunica entrada gradual desde julio de 2027, no disponibilidad
de mercado. Rol canónico: **PSBI**, Proveedor de Servicios Basados en
Información. Ruta exacta de registro/autorización queda **OPEN** hasta revisar
NCG 514/569 consolidadas y obtener revisión legal. Monitorear trimestralmente
desde 2027-07; no implementar ahora.
**Dependencias.** Producción gradual del SFA y decisión humana explícita sobre
PSBI, alianza o no participar.
**Evidencia necesaria.** Calendario de fases efectivamente cumplido, no sólo
anunciado.
**Gate de inicio.** No antes de 2027-2028. Primero, revisión legal de NCG
514/569 consolidadas. Después el propietario elige PSBI propio, alianza con
PSBI autorizado o no participar.
**Gate de cierre.** N/A en este horizonte de roadmap.
**Riesgos.** Convertirse en entidad regulada es una decisión de gran alcance,
no una tarea de ingeniería — no se estima esfuerzo aquí a propósito.
**Qué no hacer, hasta que haya necesidad real.** Scraping, browser automation
bancaria en runtime, passwords, tokens bancarios, permiso de red, Fintoc
automático.

## 9. Bancos priorizados

Ver §8.1.

## 10. Estrategia PDF

Ver Fase 2. PDF es multiplicador plausible, no techo medido de cobertura
chilena. CMR es vertical slice inicial con source-dual resuelto antes de
escribir; sin OCR, IA ni red y fail-closed ante layout no estructurado.

## 11. Estrategia de StatementFacts / tarjeta

Ver Fase 3. El gate es por `(provider, layoutVersion, field)`, no diez campos
en un documento. `minimumPayment` y hechos financieros declarados se leen,
nunca se calculan ni crean Activities.

## 12. Estrategia de costo financiero

Ver Fase 4. Cuatro vistas: caja, consumo, costos financieros y deuda o
financiamiento. Cada familia afirmada requiere positivo y near-negative;
familias no observadas quedan `unobserved`, sin validación semántica real
independiente.

## 13. Atribución de merchant

Ver Fase 5. Procesador y comercio mantienen provenance separada; corrección o
alias local del usuario es candidata. Descriptor original se conserva.

## 14. Spending / integración upstream

Ver Fase 6. `SpendingAPI` puede poseer categorías y reglas personales del host,
no semántica chilena de clase transaccional. Su adopción y mínimo 3.8 dependen
de una feature real y costo de soporte observado.

## 15. Reconciliación / upstream

Ver Fase 8. Bloqueado por SDK; motor propio testeado, pantalla read-only por
diseño (ADR 0005), no por pereza.

## 16. FX

Ver Fase 9. `ExchangeRatesAPI.getRatesForDates` está disponible. La conversión
usa frontera decimal/racional, dinero entero, un redondeo documentado y total
parcial/aproximado o sin conversión cuando falta tasa o provenance.

## 17. SFA / Open Finance

Ver Fase 10. No ahora. Julio 2027 inicia gradualidad; PSBI es nomenclatura
canónica y ruta de registro/autorización sigue OPEN pendiente de NCG 514/569
consolidadas y revisión legal.

## 18. Distribución

Existe proceso oficial de directorio comunitario. El listing es un enlace de
descubrimiento. Autor mantiene y empaqueta addon comunitario; usuarios lo
descargan desde repositorio e instalan desde archivo. Wealthfolio no construye,
hostea, audita, respalda ni da soporte al addon comunitario. Para listing activo
se requieren licencia detectable, repositorio público, manifest raíz legible y
SDK 3.6+. Licencia sigue siendo decisión del propietario.

## 18.1 Gates objetivos de 1.0

**Estable** exige: cero P0/P1, artefacto exacto validado en mínimo declarado y
host actual, y por cada perfil estable matriz completa de
`synthetic-tested`/`host-validated`/`real-structure-calibrated`/
`real-semantics-validated`, convención de signo real y umbral semántico crítico.
Un flujo cash/cuenta y uno de tarjeta requieren evidencia semántica real e
independiente. Riesgo source-dual, privacidad, distribución/licencia y ausencia
de ledger paralelo también cierran.

**Experimental** queda excluido de cobertura estable, exige preview obligatoria
y se identifica visiblemente como experimental.

El número de bancos y amplitud exacta de 1.0 queda **OPEN** para decisión del
propietario; no se inventa una meta de breadth.

## 19. Calidad / seguridad / privacidad — stream continuo

No se persigue test count como KPI. La calidad mide riesgo financiero real:

- property/fuzz tests para money/date/parsing;
- matriz de detección negativa cross-provider;
- spreadsheets malformadas, layouts PDF adversariales;
- cartolas históricas grandes, límites de tamaño/filas;
- reproducibilidad de build/ZIP, checksum de release;
- smoke contra el host persistente;
- diagnósticos de privacidad (ya cubiertos extensamente por
  `pnpm calibrate`, mantener el mismo estándar en cualquier feature nueva
  que toque contenido real);
- smoke de navegador real para cualquier UI nueva;
- política explícita de auditoría de dependencias;
- branch protection / ruleset sobre `main` — pendiente de decisión y
  ejecución (ver plan de Fase 0).

## 20. Explicit non-goals

A menos que evidencia nueva demuestre lo contrario, no se construye:

- presupuesto genérico ni Spending genérico alternativo;
- CSV exporter genérico;
- portfolio/investment features duplicadas;
- MCP propio (Wealthfolio ya trae uno, D12);
- IA runtime para categorizar montos o clasificar dinero;
- fork de Wealthfolio;
- shadow ledger o registro paralelo de identidad (D6, ADR 0002, ADR 0005);
- motor FX propio (D-implícita, siempre sobre `ExchangeRatesAPI`);
- gastos compartidos y reembolsos hasta resolver demanda propia y propiedad
  host/upstream;
- ningún cálculo del pago mínimo, CAE o CTC — ni siquiera referencial o
  estimado. Se leen declarados o quedan ausentes; nunca se aproximan;
- web scraping bancario con credenciales;
- OCR genérico en la primera iteración de PDF;
- email forwarding de cartolas;
- conexión remota que rompa local-first sin razón fuerte y decisión
  explícita del propietario.

## 21. Preguntas abiertas que requieren decisión humana

1. **Licencia** (D13) — MIT/Apache-2.0, AGPL-3.0, o propietario/privado.
2. **Política de `unknown`** (D14) — sólo el eje de marcado/desmarcado por
   defecto en la vista previa sigue abierto; el principio fail-safe de
   tarjeta (nunca cruza a gasto/ingreso sin revisión o bloqueo) ya está
   decidido, ver adenda D14. Requiere datos de proporción real, que sólo
   llegan con cartolas reales o con el workflow de §7.
3. **Ruta PSBI ante CMF** (Fase 10) — registro, autorización, alianza o no
   participar. Requiere NCG 514/569 consolidadas y revisión legal.
4. **Subir `minWealthfolioVersion` a 3.8.0** — sólo ante feature 3.8-only
   adoptada y costo de soporte observado.
5. **Alcance de Mercado Pago** (§8.1) — si el modelo `StatementProduct`
   actual alcanza para representar una billetera/procesador, o si necesita
   un tercer valor de producto.
6. **Tamaño mínimo de muestra semántica** — la forma del gate (cero
   mismatches no explicados por clase, ver §6.4/§7) ya está decidida; sólo
   sigue abierto, si el propietario quiere fijarlo, un mínimo de filas
   etiquetadas por perfil.
7. **Alcance 1.0** — breadth y banco-count, después de evidencia por perfil.
8. **Falabella cuenta corriente** — decidido como EXPERIMENTAL/sin calibrar,
   fuera del claim estable de `0.2.0` (§4.1, §8.1). El eje que sigue abierto
   es sólo operativo: con qué evidencia mínima se reevalúa la promoción antes
   del release si llega una muestra real a tiempo.
9. **Política source-dual** (identidad y precedencia XLSX/PDF CMR antes de
   escrituras) — gate de Fase 2/`0.4.x`, no bloquea `0.2.0`: PDF todavía no
   es importable, así que la duplicación XLSX+PDF del mismo ciclo no puede
   ocurrir hoy.
10. **Destino de reglas merchant** — addon o `SpendingAPI`, sin dos motores de
    categorías personales.

## 22. Dependency map

```
Fase 0 (0.2.0 estable)
  └── sin dependencias externas
Fase 1 (0.3.x import platform)
   └── depende de: cierre de Fase 0
       Bancos nuevos dependen de: muestra de consumidor o formato del producto correcto
Fase 2 (0.4.x PDF)
   └── depende de: Fase 1 y source identity/precedencia XLSX/PDF CMR
Fase 3 (StatementFacts profundidad)
   └── depende de: trabajo PDF/tarjeta y evidencia por (provider, layout, field)
Fase 4 (costos financieros profundidad)
   └── depende de: muestras observadas; familias no observadas quedan unobserved
Fase 5 (merchant intelligence)
   └── depende de: decisión OPEN sobre destino de reglas
Fase 6 (Spending upstream)
   └── depende de: caso de uso 3.8-only y costo de soporte observado
Fase 8 (conciliación nativa)
   └── depende de: upstream publique link/unlink/transfer-pair (fuera de
       nuestro control; sin fecha)
Fase 9 (FX)
   └── depende de: decisión 3.8, provenance y frontera decimal/racional
Fase 10 (SFA)
   └── depende de: gradualidad regulatoria desde julio 2027 y decisión PSBI
```

## 23. Version map (no son compromisos)

```
0.2.0   evidencia, dogfood y provenance de artefacto
0.3.x   plataforma, diagnóstico, batch, selector manual y cola sample-first
0.4.x   PDF CMR v1, source-dual y obligaciones/StatementFacts
futuro  profundidad económica, merchant, simplificación host, FX y SFA
1.0     gates objetivos cumplidos; breadth exacto OPEN
```

Orden recomendado: 0.2 evidencia; 0.3 plataforma/batch; 0.4 CMR PDF y
source-dual; obligaciones/StatementFacts; profundidad económica y bancos
sample-first; correcciones merchant; simplificación host; FX; SFA. Números de
versión más allá del corto plazo no son vinculantes.

## 24. Requisitos de evidencia, transversales

- Un banco no se declara "soportado" sin evidencia estructural real
  (calibración) o, como mínimo, documentación oficial del formato completo
  (columnas + convención de signo).
- Ningún hecho de estado de cuenta se calcula — se lee o queda ausente.
- Ninguna glosa real entra a un commit, issue o documento.
- Toda validación de host se declara con la versión exacta usada y con datos
  sintéticos, salvo que se indique lo contrario explícitamente.
- "Validado en host" nunca implica "validado con banco real" — son columnas
  distintas en `docs/BANK_FORMATS.md` y así se mantienen.
</content>
