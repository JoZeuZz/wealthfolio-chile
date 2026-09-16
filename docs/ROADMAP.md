# Roadmap — dirección de producto post-rc.6

Roadmap canónico. Reemplaza toda versión anterior de este documento. Git
conserva el historial de lo que decía antes; no se preserva aquí "por si
sirve" nada que la evidencia actual contradiga.

Base de esta revisión: **v0.2.0-rc.6**, commit
`1df6122aa9e4d80df449176adea0760c36f1e7c9` (== `main` publicado). Investigación
detallada, fuentes y desviaciones respecto de la propuesta inicial:
`.ai/research/post-rc6-product-research.md` (research de trabajo, no oficial).

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

División conceptual, reafirmada tras esta investigación (`.ai/research/
post-rc6-product-research.md` §2, §4): no se encontró evidencia de que
Wealthfolio genérico, ningún addon comunitario, ni ningún competidor chileno
(Kuanto incluido) resuelva "¿qué significa económicamente este movimiento
en Chile?" con la profundidad que ya tiene este proyecto. Es el hueco mejor
evidenciado y menos disputado del mercado a 2026-09-16.

```
Wealthfolio Chile:  "¿qué significa económicamente este movimiento en Chile?"
Wealthfolio:        "¿cómo administra, presenta y agrega el ledger completo?"
```

**No** queremos que el addon se convierta en otra aplicación financiera
completa, otro motor de presupuestos genérico, otro ledger, otro sistema de
inversiones, ni en un fork de Wealthfolio. Ver §19.

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
  de clasificación: de 130 filas reales calibradas, 13 confirmaron
  `credit_card_payment` vía el marcador anclado `PAGO TARJETA` y 2
  confirmaron `refund` con los marcadores de reversa existentes
  (`docs/BANK_FORMATS.md`, D23). No es evidencia exhaustiva — es la única
  evidencia de `kind` contra cartola real que existe hoy, y no se descarta.
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

## 5. Objetivo inmediato

Convertir rc.6 en evidencia de estabilidad real y cerrar `0.2.0`. No hay
features grandes nuevas hasta que ese cierre ocurra. Plan de implementación
concreto: `.ai/plans/phase-0.2.0-stable-evidence.md`.

## 6. Gates de 0.2.0

Gate por evidencia, no por "sensación de completitud". `0.2.0` se promueve
cuando **todos** los siguientes son verdad, con verificación observada:

1. **0 P0/P1** derivados del dogfood del ZIP publicado de rc.6 (no un build
   arbitrario de `main`).
2. Import inicial, reimport exacto, host edit, siguiente ciclo de cuota,
   pago de tarjeta, transferencias, fail-closed de Internacional,
   **reimport cross-`parserVersion` de CMR contra Activities escritas por un
   parser anterior** (debe bloquear con `legacy-source-conflict`, D23
   addendum, no reproducido contra host real todavía) y **el gate de
   "no se pudo comprobar duplicados" bloqueando la importación** (nunca
   "no hay duplicados" por defecto) — comprobados contra el artefacto
   publicado. Un dogfood que no ejercita estos dos últimos casos no puede
   contar "0 P0/P1" como evidencia de que no los tiene.
3. Perfiles anunciados como soportados tienen evidencia estructural real
   (no sólo fixture sintético) donde ya existe (Banco de Chile, BancoEstado,
   Falabella/CMR).
4. Validación semántica suficiente obtenida vía el workflow human-in-the-loop
   privacy-safe (§7) — no exhaustiva, pero con evidencia real de que `kind`
   coincide con lo que el usuario etiquetó, para al menos un banco.
5. Política de `unknown` (D14) decidida explícitamente por el propietario.
6. Frontera de privacidad intacta — sin relajar `pnpm calibrate`.
7. Docs coherentes (test count, SDK/host version, estado de Falabella cuenta
   corriente, estado PDF, estado Internacional).
8. Licencia decidida si el objetivo es distribución amplia (D13); si se
   mantiene `UNLICENSED` a propósito, se documenta la decisión, no el
   silencio.
9. Falabella cuenta corriente: obtiene muestra real, **o** queda declarado
   explícitamente experimental/fuera del claim de estable — nunca "soportado"
   sin evidencia.

No inventar evidencia para cumplir el gate. Si algo no se puede probar, se
declara pendiente.

## 7. Validación semántica privacy-safe (crítico)

`pnpm calibrate` protege privacidad deliberadamente no exponiendo glosas —
eso es correcto y no se relaja. Pero eso también impide comprobar `kind`
contra la realidad. Se diseña (no se implementa aún; ver plan de fase 0) un
workflow **human-in-the-loop** local:

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
   detectarla. El vocabulario final tiene que ser una función total y
   verificada contra `TransactionKind` (cada etiqueta humana mapea a
   exactamente un `TransactionKind`, y todo `TransactionKind` clasificable
   es alcanzable por alguna etiqueta) — con test de esa propiedad. Esa
   reconciliación es tarea de diseño de la Tarea 2 del plan de Fase 0, no
   una decisión ya tomada aquí.
2. El agente **nunca** ve: glosa, RUT, número de cuenta, tarjeta, titular,
   monto real, nombre de archivo privado.
3. Reporte sanitizado exportable, similar en espíritu al de `pnpm calibrate`:

   ```
   provider, parserVersion, expectedKind (etiqueta del usuario),
   actualKind (lo que el parser decidió), matchedRuleId, match/mismatch
   ```

4. El agregado de varios usuarios (si se comparte) sigue sin exponer nada
   identificable — sólo tasas de acierto por banco/regla.

Diseño detallado, decisión de dónde vive el etiquetador (¿UI del addon?
¿script local aparte?) y tareas concretas: `.ai/plans/phase-0.2.0-stable-
evidence.md`. No se implementa en esta fase — se especifica.

## 8. Fases y releases

Cada fase distingue, cuando corresponde: RESEARCH · DESIGN · IMPLEMENT · HOST
VALIDATION · REAL SAMPLE VALIDATION · RELEASE. Ningún banco se declara
"soportado" antes de tener evidencia estructural real.

### Fase 0 — `0.2.0`: estabilidad + evidencia semántica real

**Objetivo.** Convertir rc.6 en un release estable con evidencia, no una
promesa de features nuevas.
**Por qué.** El código ya es correcto según 1627 tests y validación de host;
lo que falta es la única clase de evidencia que ningún test puede sustituir.
**Dependencias.** Ninguna externa — todo el trabajo es interno al proyecto.
**Evidencia necesaria.** Ver gate §6.
**Gate de inicio.** rc.6 publicado y dogfood-eable (cumplido).
**Gate de cierre.** §6 completo.
**Riesgos.** Ninguna cartola real disponible aún para varios pasos — mitigado
por el workflow de §7, que no depende de tener una cartola de cada banco.
**Qué no hacer.** No bump de versión, no features nuevas, no relajar
privacidad, no declarar `validated` sin evidencia.

Trabajo concreto: `.ai/plans/phase-0.2.0-stable-evidence.md`.

### Fase 1 — `0.3.x`: plataforma de importación chilena

**Objetivo.** Escalar la importación sin escalar sólo "más parsers sueltos".
**Por qué.** Los tres perfiles que hoy existen se hicieron uno por uno; el
siguiente lote de bancos necesita diagnóstico de formato desconocido, import
batch y selector manual antes de que agregar un banco más sea barato.
**Dependencias.** Cierre de Fase 0 (gate de estabilidad).
**Evidencia necesaria.** Muestra real por banco nuevo, o el diagnóstico de
formato desconocido documentado en su lugar.
**Gate de inicio.** `0.2.0` publicado.
**Gate de cierre.** Diagnóstico de formato desconocido implementado y
probado; al menos un banco nuevo con evidencia estructural real (BCI,
según §8.1) o explícitamente diferido por falta de muestra.
**Riesgos.** Sin muestra real, cualquier parser nuevo repite el patrón
`pending-real-sample` indefinidamente — aceptable si se declara así.
**Qué no hacer.** No implementar un banco sin evidencia de formato (ni
oficial ni de muestra real).

Trabajo:

**A. Diagnóstico de formato desconocido.** Cuando el pipeline no reconoce una
cartola, generar un reporte privacy-safe (tipo de archivo, hojas, forma de
headers, cantidad de filas, tipos de celda, patrones de fecha, formatos
numéricos, señales estructurales) para poder pedir/priorizar soporte — nunca
datos financieros reales. RESEARCH: ya cubierto por el diseño de
`pnpm calibrate` existente, que ya no expone contenido; extender su output a
"formato no reconocido" es DESIGN + IMPLEMENT.

**B. Import batch/histórico.** Múltiples cartolas a la vez, detección por
archivo, agrupación banco/cuenta, cuenta de destino sugerida, dedupe global,
preview individual, confirmación explícita. Nunca auto-write.

**C. Selector de parser manual.** Cuando la detección es ambigua, mostrar
confianza/evidencia de cada candidato y dejar elegir explícitamente — el
mecanismo de puntaje ya existe en `core/providers/profile-parser.ts`, falta
la UI que lo exponga en el caso ambiguo.

### 8.1 Bancos priorizados (Fase 1 en adelante)

Orden por evidencia real disponible a 2026-09-16 (`.ai/research/
post-rc6-product-research.md` §5), no por intuición de tamaño de mercado:

| Prioridad | Banco / producto | Evidencia de formato | Nota |
| --- | --- | --- | --- |
| 0 | Falabella cuenta corriente | Sin muestra real | Ya implementado, cerrando en Fase 0 |
| 1 | BCI cuenta corriente | Excel OFFICIAL confirmado (ayuda oficial), límite 2 meses/consulta | Banco grande, mejor evidencia disponible hoy |
| 2 | Santander cuenta corriente | PDF OFFICIAL; CSV sólo PLAUSIBLE (fuentes de terceros) | Requiere muestra real antes de comprometerse a un parser tabular |
| 2 | Mercado Pago | CSV/XLSX OFFICIAL (doc. developers, genérica) | Es procesador/billetera, no banco — decisión de alcance propia, ver abajo |
| 3 | Scotiabank, Cencosud Scotiabank, Banco Ripley, Coopeuch, Tenpo | PDF OFFICIAL para todos; ningún tabular confirmado | Todos requieren muestra real antes de cualquier trabajo |
| 4 | MACHBANK, Líder BCI, Banco Security, Banco Consorcio, Banco BICE | Evidencia insuficiente incluso para decidir si investigar más | Bajo ROI hasta que un usuario real aporte muestra |

Disponibilidad de una muestra real puede reordenar esta lista en cualquier
momento — es una prioridad de evidencia, no un compromiso.

**Mercado Pago — decisión de alcance pendiente.** No es un banco con cuenta
corriente ni tarjeta de crédito tradicional; su "cartola" es un reporte de
transacciones de plataforma. `StatementProduct` (`core/model/statement.ts`)
ya tiene cinco valores (`checking`, `savings`, `credit_card`, `credit_line`,
`unknown`), no dos — la pregunta real no es "¿hace falta un segundo valor?"
sino si Mercado Pago encaja en `unknown`/`checking` o si merece un valor
propio, dado que once módulos de `core/` ramifican sobre `StatementProduct`
(convención de signo, clasificación por defecto, `classify/card-semantics.ts`,
`reconcile/credit-card.ts`). Pregunta de diseño abierta, no resuelta aquí.

### Fase 2 — `0.4.x`: PDF de primera clase

**Objetivo.** PDF es el techo real de cobertura bancaria en Chile — casi
ningún banco de banca de personas ofrece export tabular más allá de los tres
ya calibrados.
**Por qué.** Confirmado tanto por la investigación de dominio previa como
por la actualización 2026-09-16: PDF es OFFICIAL para prácticamente todos
los bancos investigados; tabular (CSV/Excel) es la excepción, no la regla.
**Dependencias.** Ninguna externa. Depende de tener PDFs reales calibrados
(ya hay 3 de CMR calibrados sólo como evidencia, no importables — ver
`docs/BANK_FORMATS.md`).
**Evidencia necesaria.** PDF con capa de texto (ya confirmado en los 3
calibrados); layout suficientemente estructurado por banco.
**Gate de inicio.** Fase 1 con al menos un flujo de diagnóstico de formato
funcionando.
**Gate de cierre.** Un banco con import PDF real, no sólo calibración.
**Riesgos.** PDF sin capa de texto (imagen escaneada) requeriría OCR — fuera
de alcance a propósito.
**Qué no hacer.** Parser PDF universal heurístico, OCR, IA, red.

Arquitectura: `PDF bytes → text extraction → document blocks/tables →
provider signature → StatementFacts → movement tables → NormalizedStatement`.
Sin capa de texto o layout no reconocido → `unsupported-pdf-layout`, fail
closed. CMR sigue siendo primer candidato (ya hay evidencia real de
calibración); después, priorizar según qué muestra real llegue primero.

### Fase 3 — Estado de tarjeta chileno (profundidad)

**Objetivo.** Profundizar `StatementFacts` (ya modelado en D22, diez campos
reales en `core/model/statement-facts.ts`: `statementDate`, `billingPeriod`,
`dueDate`, `billedAmount`, `minimumPayment`, `totalDebt`, `domesticDebt`,
`foreignDebt`, `creditLimit`, `availableCredit`) confirmando esos diez campos
contra cartola real — **no** agregando nuevos campos de totales de
movimiento (compras, cuotas, pagos, avances, interés, comisiones, impuestos)
como si fueran hechos del estado de cuenta: esos totales ya existen como
Activities individuales (una por movimiento), y convertirlos también en un
"hecho declarado" agregado duplicaría el conteo del consumo del mes si
alguna vez se suman ambas fuentes. Un hecho de `StatementFacts` nunca produce
una `ActivityCreate` ni entra en `grossSpending`.
**Por qué.** El modelo ya existe y está probado contra fixtures sintéticos
construidos con la redacción del reglamento (NCG 537, Decreto 75/2026); falta
la confirmación contra cartola real de esos diez campos, incluida la
distinción `domesticDebt`/`foreignDebt` — que **no** se pueden sumar en un
solo `totalDebt` sin tasa de cambio explícita (mismo principio que prohíbe
sumar CLP y USD en cualquier otra parte del modelo).
**Dependencias.** Muestra real de al menos un estado de cuenta de tarjeta —
ya existe evidencia parcial real en los XLSX de CMR calibrados (D23), así que
esta fase no está bloqueada por Fase 2 (PDF); puede avanzar con lo que ya
hay.
**Evidencia necesaria.** Cada campo se lee sólo si el documento lo declaró
— nunca se calcula. La NCG 537 ya está en su primera etapa de vigencia
(2026-06-04), así que cualquier cartola real obtenida ahora refleja el
régimen transicional vigente, no uno futuro.
**Gate de inicio.** Cualquier muestra real de tarjeta disponible — no
depende de que Fase 2 (PDF) cierre primero.
**Gate de cierre.** Los diez campos reales de `StatementFacts` confirmados
contra al menos una cartola real donde el documento los declaró.
**Riesgos.** Ninguno nuevo — el modelo ya evita el riesgo principal
(`ausente ≠ cero`, nunca calcular pago mínimo).
**Qué no hacer.** Calcular CAE, CTC ni pago mínimo. Fabricar un hecho que el
documento no declaró. Agregar campos de totales de movimiento a
`StatementFacts`. Sumar `domesticDebt` y `foreignDebt` sin conversión
explícita.

### Fase 4 — Costos financieros (profundización)

**Objetivo.** Seguir separando consumo y costo financiero con más cobertura
de casos reales, confirmando contra glosa real las familias que
`FinancialCostKind` (`core/model/financial-cost.ts`) ya modela: mantención,
administración, interés rotativo, interés de cuotas, interés de avance,
mora, comisión de avance, comisión de compra internacional, impuesto de
timbres, cobranza.
**Explícitamente fuera de esta fase, por decisión ya tomada en D20** —no se
reintroducen como familia de costo financiero: **seguros** (una prima
confirmada es consumo voluntario del producto, no costo de endeudarse ni de
tener el instrumento) y **el principal de un avance en efectivo** (es
financiamiento — dinero prestado, no un costo; sólo su interés/comisión/
impuesto son costos financieros y viajan como movimientos separados).
Tratar cualquiera de los dos como `financialCostKind` falsea el gasto del
mes en cualquier dirección.
**Por qué.** El modelo (D20) ya está implementado y probado con vocabulario
regulatorio OFFICIAL; falta confirmar contra glosas reales de cada banco.
**Dependencias.** Fase 1/2/3 aportando muestras reales.
**Evidencia necesaria.** Frase completa en la glosa, nunca subcadena corta.
**Gate de inicio.** Cualquier muestra real con un costo financiero visible.
**Gate de cierre.** Al menos un costo financiero de cada familia de
`FinancialCostKind` (listadas arriba) confirmado contra glosa real —
explícitamente sin incluir seguros ni principal de avance en ese conteo.
**Riesgos.** Ninguno nuevo respecto de lo ya mitigado en D20/D21.
**Qué no hacer.** Un avance en efectivo nunca es spending. Una prima de
seguro nunca es `financialCostKind`. El principal de un avance nunca es
`financialCostKind`.

### Fase 5 — Merchant intelligence Chile

**Objetivo.** Seguir resolviendo `processor != merchant` con más catálogo y
mejor confianza/evidencia.
**Por qué.** Es el dolor mejor evidenciado y peor servido del mercado
chileno (`.ai/research/post-rc6-product-research.md` §4.2, confirmado por
dos investigaciones independientes): ningún competidor local lo resuelve.
**Dependencias.** Ninguna externa.
**Evidencia necesaria.** Documentación oficial del procesador/banco, nunca
sólo un post de foro.
**Gate de inicio.** Cualquier momento — no depende de más bancos.
**Gate de cierre.** Ampliación medible del catálogo con evidencia OFFICIAL o
COMMUNITY OBSERVED para cada entrada nueva.
**Riesgos.** Ninguno — es sólo catálogo, determinista y auditable.
**Qué no hacer.** Convertir un procesador en comercio. Construir una
gramática basada en el asterisco (confirmado no confiable — Falabella
documenta el mismo cargo con y sin asterisco).

### Fase 6 — Integración con Wealthfolio Spending

**Objetivo.** Decidir con evidencia real (no supuesta) si conviene adoptar
`SpendingAPI` (3.8.0, ya disponible — ver §9) para algún subconjunto de
categorización.
**Por qué.** `SpendingAPI` existe desde 3.8.0 (confirmado con código real,
`.upstream/wealthfolio`), pero es genérica: no conoce Transbank, CMR,
Redcompra ni avances en efectivo. Adoptarla hoy no elimina el motor propio,
sólo lo movería de sitio.
**Dependencias.** Decisión de subir `minWealthfolioVersion` a 3.8.0 (pierde
compatibilidad con hosts 3.7.x).
**Evidencia necesaria.** Caso de uso concreto donde `SpendingAPI` aporte algo
que el motor propio no pueda, o señal de que upstream publicó taxonomías
específicas de LatAm/Chile (no ocurrió a la fecha de esta investigación).
**Gate de inicio.** Cierre de Fase 5.
**Gate de cierre.** Decisión documentada en un ADR, con evidencia concreta
en cualquier sentido.
**Riesgos.** Migrar sin necesidad real duplicaría trabajo sin beneficio.
**Qué no hacer.** Mantener dos motores completos de categoría personal para
siempre "por si acaso" — la decisión se toma con evidencia, no se pospone
indefinidamente sin revisarla.

### Fase 7 — Gastos compartidos / reembolsos

**Objetivo.** Modelar atribución (own share / third-party share / expected
reimbursement / matched reimbursement) sin convertir una transferencia en
refund ni alterar la compra original.
**Por qué.** Dolor real (SERNAC: 38,8% de reclamos de tarjeta son cobros
indebidos, aunque no específicamente de gastos compartidos), pero de menor
evidencia de demanda chilena específica que costos financieros o atribución
de comercio; soluciones globales maduras (Splitwise, Tricount) ya existen.
**Dependencias.** Ninguna externa técnica.
**Evidencia necesaria.** Ninguna regulatoria — es modelo de dominio propio.
**Gate de inicio.** Después de Fase 5 (atribución de comercio), porque
comparte vocabulario de "quién pagó qué".
**Gate de cierre.** Modelo probado sin alterar la Activity original.
**Riesgos.** Riesgo de convertirse en "otra app de split bill" sin
diferenciación real frente a Splitwise/Tricount — evaluar si pertenece al
addon o si integrar con una herramienta externa es mejor.
**Qué no hacer.** No priorizar sobre costos financieros/atribución — evidencia
de dolor específico chileno es más débil aquí que en esas dos fases.

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
**Qué no hacer.** Construir un ledger de pares propio para tapar el hueco
(ADR 0005 lo descarta explícitamente). No usar `network` para llamar a la
API HTTP del propio host sin evaluar el costo de convertirse en cliente HTTP
de su anfitrión.

### Fase 9 — Multimoneda / FX

**Objetivo.** Si se justifica el costo de subir `minWealthfolioVersion` a
3.8.0, diseñar conversión usando `ExchangeRatesAPI.getRatesForDates` (ya
disponible, confirmado con código real) — manteniendo montos originales,
convirtiendo sólo para métricas, sin reescribir Activities históricas.
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
**Qué no hacer.** Motor FX privado. Tratar UTM/CLF como moneda sin
fundamento — investigar primero si el host las soporta correctamente.
Rotular una tasa de fallback como si fuera la tasa exacta de la fecha.

Banco de Chile Internacional sigue fail-closed hasta evidencia real
suficiente — sin cambio.

### Fase 10 — Open Finance Chile (SFA)

**Objetivo.** No construir nada todavía; mantener la posibilidad
arquitectónica (`file → NormalizedStatement`, `SFA → NormalizedStatement`,
mismo pipeline financiero) sin implementarla.
**Por qué.** SFA confirmado (tres fuentes independientes) pospuesto a julio
de 2027, con calendario por fases de 5-30 meses adicionales. Además —
hallazgo nuevo de esta investigación — es un modelo B2B/B2B2C bajo
consentimiento que exige que un consumidor de la API se **registre ante la
CMF como proveedor de servicios de información de cuentas**. No es "el
usuario descarga su CSV estandarizado".
**Dependencias.** Publicación efectiva del SFA (julio 2027 en adelante,
por fases) y decisión humana explícita de registrarse como entidad regulada.
**Evidencia necesaria.** Calendario de fases efectivamente cumplido, no sólo
anunciado.
**Gate de inicio.** No antes de 2027-2028, y sólo con decisión explícita del
propietario de asumir el costo regulatorio de registrarse.
**Gate de cierre.** N/A en este horizonte de roadmap.
**Riesgos.** Convertirse en entidad regulada es una decisión de gran alcance,
no una tarea de ingeniería — no se estima esfuerzo aquí a propósito.
**Qué no hacer, hasta que haya necesidad real.** Scraping, browser automation
bancaria en runtime, passwords, tokens bancarios, permiso de red, Fintoc
automático.

## 9. Bancos priorizados

Ver §8.1.

## 10. Estrategia PDF

Ver Fase 2. Resumen: PDF es el techo real de cobertura bancaria en Chile;
sin OCR, sin IA, sin red; fail-closed ante layout no estructurado; CMR
primer candidato por evidencia real ya calibrada.

## 11. Estrategia de StatementFacts / tarjeta

Ver Fase 3. Resumen: modelo ya implementado (D22 — diez campos de
`StatementFacts`; D23 cubre cuotas facturadas y fingerprint, no
`StatementFacts`), evidencia regulatoria OFFICIAL suficiente para el
vocabulario, falta confirmación real exhaustiva (hay evidencia parcial de
`kind` en CMR, ver §4). `minimumPayment` y demás hechos financieros se leen,
nunca se calculan.

## 12. Estrategia de costo financiero

Ver Fase 4. Resumen: modelo ya implementado (D20), separación estricta entre
consumo / costo de endeudarse / costo de tener el instrumento / principal de
avance, con gramática de reconocimiento conservadora (frase completa, nunca
subcadena).

## 13. Atribución de merchant

Ver Fase 5. Resumen: catálogo de procesadores con propiedad `hidden` /
`self` / `passthrough`, nunca gramática de asterisco, procesador nombrado
cuando el comercio no se puede determinar.

## 14. Spending / integración upstream

Ver Fase 6. `SpendingAPI` (3.8.0) confirmada disponible pero genérica —
DEFER hasta evidencia de necesidad real o taxonomía específica de LatAm.

## 15. Reconciliación / upstream

Ver Fase 8. Bloqueado por SDK; motor propio testeado, pantalla read-only por
diseño (ADR 0005), no por pereza.

## 16. FX

Ver Fase 9. `ExchangeRatesAPI.getRatesForDates` (3.8.0) confirmada
disponible; bloqueo técnico resuelto, queda decisión de diseño y de costo de
compatibilidad — incluida la de marcar cuando la tasa devuelta no es
acreditable a la fecha exacta pedida (la API no lo distingue por sí sola).

## 17. SFA / Open Finance

Ver Fase 10. No ahora; postergado a julio 2027 por normativa, con calendario
de fases adicional; registro ante CMF es requisito, no sólo "esperar".

## 18. Distribución

Sin cambios respecto de `docs/DECISIONS.md` D13: licencia pendiente y
decisión del propietario, no automatizable. No se encontró proceso de
submission de addons comunitarios documentado en upstream — nada que
adoptar todavía. Publicación amplia sigue bloqueada mientras la licencia no
se decida.

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
- ningún cálculo del pago mínimo, CAE o CTC — ni siquiera referencial o
  estimado. Se leen declarados o quedan ausentes; nunca se aproximan;
- web scraping bancario con credenciales;
- OCR genérico en la primera iteración de PDF;
- email forwarding de cartolas;
- conexión remota que rompa local-first sin razón fuerte y decisión
  explícita del propietario.

## 21. Preguntas abiertas que requieren decisión humana

1. **Licencia** (D13) — MIT/Apache-2.0, AGPL-3.0, o propietario/privado.
2. **Política de `unknown`** (D14) — marcado por defecto vs. desmarcado por
   defecto en la vista previa. Requiere datos de proporción real, que sólo
   llegan con cartolas reales o con el workflow de §7.
3. **Registro ante la CMF para consumir el SFA directamente** (Fase 10) — es
   una decisión de convertirse en entidad regulada, no una tarea técnica.
4. **Subir `minWealthfolioVersion` a 3.8.0** — decisión de costo de
   compatibilidad compartida entre Fase 6 (Spending) y Fase 9 (FX): pierde
   soporte de hosts 3.7.x a cambio de dos APIs que hoy están en DEFER por
   falta de necesidad probada, no por falta de disponibilidad técnica.
5. **Alcance de Mercado Pago** (§8.1) — si el modelo `StatementProduct`
   actual alcanza para representar una billetera/procesador, o si necesita
   un tercer valor de producto.
6. **Si Wealthfolio Chile pertenece a la fase de gastos compartidos** (Fase
   7) o si conviene integrar con una herramienta externa madura en vez de
   construir dentro del addon.

## 22. Dependency map

```
Fase 0 (0.2.0 estable)
  └── sin dependencias externas
Fase 1 (0.3.x import platform)
  └── depende de: cierre de Fase 0
      Bancos nuevos dependen de: muestra real por banco (§8.1)
Fase 2 (0.4.x PDF)
  └── depende de: Fase 1 (diagnóstico de formato)
Fase 3 (StatementFacts profundidad)
  └── depende de: Fase 2 (PDF real) — o cualquier muestra real de tarjeta
Fase 4 (costos financieros profundidad)
  └── depende de: cualquier muestra real con costo financiero visible
Fase 5 (merchant intelligence)
  └── sin dependencia de más bancos — puede avanzar en paralelo a 1-4
Fase 6 (Spending upstream)
  └── depende de: decisión de minWealthfolioVersion (compartida con Fase 9)
Fase 7 (gastos compartidos)
  └── depende de: Fase 5 (vocabulario de atribución)
Fase 8 (conciliación nativa)
  └── depende de: upstream publique link/unlink/transfer-pair (fuera de
      nuestro control; sin fecha)
Fase 9 (FX)
  └── depende de: decisión de minWealthfolioVersion (compartida con Fase 6)
Fase 10 (SFA)
  └── depende de: calendario regulatorio (julio 2027+) y decisión de
      registro ante CMF
```

## 23. Version map (no son compromisos)

```
0.2.0   estabilidad + evidencia semántica real + dogfood del rc.6 publicado
0.3.x   plataforma de importación + batch + diagnóstico + primeros bancos nuevos
0.4.x   PDF v1 + profundidad de StatementFacts/tarjeta
0.5.x   integración Spending 3.8 (si se justifica) + UX de merchant
0.6.x   gastos compartidos/reembolsos + conciliación si upstream lo permite
0.7.x   FX de host + multimoneda/internacional
0.8.x   preparación/integración SFA (si el calendario regulatorio avanza)
1.0     release madura para usuario externo
```

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
