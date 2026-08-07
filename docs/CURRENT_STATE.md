# Estado actual

Qué funciona **hoy**, verificado, y qué no.

Actualizado: 2026-08-07 · Wealthfolio v3.6.2 · addon v0.1.1

---

## Cómo leer los estados

Cuatro niveles distintos, que esta documentación no mezcla:

| Nivel | Qué significa |
| --- | --- |
| **implementado** | El código existe y sus tests unitarios pasan |
| **integrado** | Está enganchado al flujo real del addon, no sólo disponible |
| **validado en host** | Se ejecutó contra un Wealthfolio v3.6.2 corriendo |
| **validado con banco real** | Se ejecutó contra una cartola real de ese banco |

**El proyecto llegó a *validado en host* el 2026-08-07.** Falta el último nivel:
ninguna cartola real ha tocado este código.

---

## Verificación automática

```
typecheck   ✅  tsc --noEmit, strict + noUncheckedIndexedAccess
lint        ✅  eslint, 0 errores, 0 warnings, sin `any`
tests       ✅  318 pasando (17 archivos)
build       ✅  dist/addon.js — 749 KB (195 KB gzip), un solo archivo
```

`./scripts/test.sh` corre las cuatro.

---

## Matriz de validación

`Unit` = tests automatizados. `Host` = ejecutado contra un Wealthfolio real.
`Restart` = sobrevive a reiniciar el contenedor.

Sesión completa, con la evidencia de cada celda:
[HOST_VALIDATION.md](HOST_VALIDATION.md).

| Componente | Unit | Host | Restart | Estado |
| --- | --- | --- | --- | --- |
| Parser (core) | PASS | PASS | n/a | Sintético; sin cartolas reales |
| Money | PASS | n/a | n/a | Integrado |
| Fechas | PASS | PASS | n/a | Corregido el desfase de zona horaria del host |
| Perfil bancario sintético | PASS | PASS | n/a | 3 bancos `pending-real-sample` |
| Stack Docker | n/a | PASS | PASS | `wealthfolio/wealthfolio:3.6.2`, healthy |
| Carga del addon | n/a | PASS | PASS | Detectado, habilitado, sidebar «Chile» |
| Enable / disable | n/a | PASS | PASS | Requirió arreglar la propiedad de los archivos |
| Rutas / navegación | n/a | PASS | PASS | Las tres, en ambos sentidos, con recarga |
| API `accounts` | PASS | PASS | n/a | 3 cuentas, campos verificados uno a uno |
| `activities.search` | PASS | PASS | n/a | Firma posicional, paginación 0-indexada |
| Filtros de fecha | PASS | PASS | n/a | **Venían corridos un día**; corregido y reverificado |
| `activities.saveMany` | PASS | PASS | n/a | **`metadata` debe ser string**; corregido |
| Round-trip de metadata | PASS | PASS | PASS | 11 casos, campo por campo |
| Metadata `dir` v2 | PASS | PASS | PASS | `UNKNOWN` en ambas direcciones |
| Deduplicación exacta | PASS | PASS | PASS | 12/12 en la reimportación, también tras reiniciar |
| Deduplicación probable | PASS | PASS | PASS | 11 exactos + 1 probable |
| Importación end-to-end | PASS | PASS | n/a | 12 detectados, 12 creados, 0 fallidos |
| Historial de importaciones | PASS | PASS | PASS | Sobrevive reinicio y restauración |
| Storage del addon | PASS | PASS | PASS | Esquema particionado aceptado por el host real |
| Panel | PASS | PASS | PASS | **Se caía por la moneda base del host**; corregido |
| Semántica de caja | PASS | PASS | n/a | 1.000.000 / 150.000 / 850.000 |
| Semántica de transferencia | PASS | PASS | n/a | Netea a 0. Hallazgo: ver ADR 0005 |
| Semántica de tarjeta de crédito | PASS | PASS | n/a | Aparece como *liability*; la hipótesis se sostuvo |
| Semántica de devolución | PASS | PASS | n/a | `CREDIT/REFUND` sube caja, no mueve contribución |
| Backup | NOT TESTED | PASS | n/a | 282 K, contenedor detenido durante la copia |
| Restore | NOT TESTED | PASS | PASS | 9 actividades y una cuenta recuperadas |
| Privacidad en runtime | PASS | PASS | n/a | 0 filtraciones, 0 peticiones a otro origen |
| **Cartolas reales** | n/a | **NOT TESTED** | n/a | Fase siguiente |

---

## Errores encontrados en la validación en host (0.2)

Seis, todos en la frontera con el host, y **ninguno detectable por los 301 tests
que ya existían**. Cinco de los seis habrían impedido usar el addon.

| # | Error | Consecuencia real |
| --- | --- | --- |
| 1 | `WF_VERSION=v3.6.2` no resuelve en Docker Hub | El stack no levantaba: `manifest unknown` |
| 2 | `WF_ADDONS_DIR` apuntaba un nivel de más | El addon era invisible, **sin error en ninguna parte** |
| 3 | Los archivos del addon quedaban con el propietario equivocado | Activarlo o desactivarlo devolvía `Permission denied` para siempre |
| 4 | `metadata` se enviaba como objeto | **Toda importación fallaba** con 422 sin escribir una fila |
| 5 | Los filtros de fecha del host vienen corridos un día | El índice de duplicados perdía el primer día de la ventana; el usuario terminaba con movimientos repetidos |
| 6 | El panel sumaba CLP sobre un acumulador en USD | `MoneyError` no capturado: **panel en blanco, sin mensaje**, tras la primera importación |

Los seis están corregidos, cubiertos por tests de regresión donde era posible, y
**reverificados contra el host después del arreglo**.

Lo que estos seis tienen en común vale más que los seis por separado: eran fallos
de la frontera, y el doble de test estaba construido sobre las mismas
suposiciones que el código que probaba. Un mock que le da la razón al código no
prueba nada. Los tests nuevos parten de lo que el host hizo, no de lo que
creíamos que hacía —incluido un doble que sabe reproducir el desfase de fechas.

---

## Errores encontrados en la auditoría 0.1.1

Cinco, en la misma frontera, todos corregidos y con test de regresión:

| # | Error | Consecuencia real |
| --- | --- | --- |
| 1 | El signo se perdía al releer una actividad | **Ningún duplicado probable se detectaba jamás** |
| 2 | `startDate`/`endDate` no existen en v3.6.2 | Los filtros de fecha se ignoraban; toda consulta escaneaba la cuenta completa |
| 3 | El wizard quedaba en blanco si fallaba leer duplicados | Estado inconsistente |
| 4 | Una importación parcial mostraba el toast verde | El usuario creía que se guardó todo |
| 5 | Un fallo al guardar el historial anulaba la importación | Los movimientos ya estaban escritos |

---

## Hallazgos de arquitectura

**Un addon no puede marcar una transferencia como interna.** El host sólo trata
un par `TRANSFER_OUT`/`TRANSFER_IN` como interno cuando los dos tramos están
enlazados, y `link`/`transfer-pair` no están expuestos en el SDK. Nuestras
métricas no dependen de eso —netean desde nuestra propia metadata—, pero la
atribución de rendimiento de *Wealthfolio* queda `partial` en las cuentas con
transferencias importadas. Ver
[ADR 0005](adr/0005-transferencias-y-tarjeta-en-el-host.md).

**El panel Chile y Wealthfolio cuentan cosas distintas, y ambos tienen razón.**
El panel responde «cuánto entró y salió este mes», en pesos y por mes,
excluyendo transferencias y pagos de tarjeta. Wealthfolio responde «cuánto tengo
y cuánto aporté», acumulado a hoy y convertido a la moneda base. No cambiamos el
modelo por esto; sí lo documentamos, en
[HOST_VALIDATION.md](HOST_VALIDATION.md) § 11.

**El *Spending Tracker* nativo mostró $0** con nuestras actividades cargadas.
Entender por qué es trabajo aparte y no bloquea nada.

---

## Funciona (verificado por tests y contra el host)

### Motor (`core/`)

| Área | Estado |
| --- | --- |
| Aritmética exacta de dinero | ✅ 26 tests |
| Fechas civiles sin zona horaria | ✅ 25 tests |
| Lectura CSV / TXT / XLSX / XLS | ✅ 21 tests |
| Detección de delimitador y codificación | ✅ incl. Windows-1252 |
| Detección de cabecera y mapeo de columnas | ✅ |
| Selección de parser por evidencia estructural | ✅ 23 tests, con regresión |
| Modelo canónico | ✅ |
| Huellas e idempotencia | ✅ 14 tests |
| Traducción a actividades de Wealthfolio (ida y vuelta) | ✅ 35 tests, verificada contra el host |
| Conciliación de transferencias internas | ✅ 11 tests |
| Conciliación de pagos de tarjeta | ✅ |
| Normalización de comercios | ✅ |
| Motor de reglas + reglas predefinidas | ✅ |
| Detección de cuotas y planes | ✅ 20 tests |
| Métricas mensuales, categorías, comercios, recurrentes | ✅ 28 tests |
| Insights deterministas | ✅ |
| Redacción y enmascarado | ✅ 15 tests |

### Servicios (`services/`)

| Área | Estado |
| --- | --- |
| Índice de duplicados desde el host | ✅ 16 tests, verificado contra el host |
| Escritura por `saveMany` y desglose del resultado | ✅ 17 tests |
| Preparación del preview y bloqueo de importación | ✅ 11 tests |
| Relectura de movimientos importados | ✅ 11 tests |
| Storage particionado e historial a volumen | ✅ 17 tests |

### Flujo de importación

De punta a punta contra un Wealthfolio real, con fixtures sintéticos:

1. Archivo por drag & drop o selector, dentro del sandbox.
2. Detección de banco con puntaje y razones visibles.
3. Selección manual de banco si hace falta.
4. Lectura de los movimientos ya registrados en la cuenta, acotada al período de
   la cartola. **Si esa lectura falla, importar queda bloqueado.**
5. Vista previa con totales, advertencias y por-fila.
6. Marcado/desmarcado por fila, con totales recalculados.
7. Escritura por `activities.saveMany({ creates })`.
8. Resumen que distingue creados, fallidos, duplicados, ignorados y desmarcados.
9. Registro en el historial de importaciones.

**Reimportar el mismo archivo produce cero movimientos nuevos**, también después
de reiniciar el contenedor. Verificado contra el host.

---

## No funciona / no está hecho

| Qué | Por qué |
| --- | --- |
| **Perfiles bancarios validados** | No hay cartolas reales. Los tres bancos tienen adaptador completo, marcado `pending-real-sample`. Ver [BANK_FORMATS.md](BANK_FORMATS.md) |
| **Enlazado de transferencias en el host** | El SDK no lo expone. Ver [ADR 0005](adr/0005-transferencias-y-tarjeta-en-el-host.md) |
| **Conciliación multi-cuenta integrada** | El motor y la fachada están listos y testeados; falta la pantalla de revisión |
| **UI de reglas** | Las reglas predefinidas se aplican; no hay editor |
| **Editor de categorías** | Mismo caso |
| **Servicio importador** | Decisión D11: no aporta hasta que los perfiles estén validados |
| **IA / MCP propio** | Decisiones D10 y D12 |
| **Fintoc** | Sin credenciales; sólo existe la abstracción conceptual |
| **Licencia** | Decisión pendiente del propietario. Todo declara `UNLICENSED`. Ver D13 |

---

## MVP: 15 de 15

| # | Criterio | Estado |
| --- | --- | --- |
| 1 | Wealthfolio se levanta localmente | ✅ ejecutado, healthy |
| 2 | El addon se carga | ✅ detectado, habilitado, sidebar |
| 3 | Se puede seleccionar un archivo | ✅ |
| 4 | Se detecta o elige el banco | ✅ 100 % en el fixture |
| 5 | Se transforma al modelo canónico | ✅ |
| 6 | Existe vista previa | ✅ |
| 7 | Se calculan ingresos y egresos | ✅ verificado contra el host |
| 8 | Se detectan duplicados | ✅ exactos y probables |
| 9 | El usuario confirma | ✅ |
| 10 | Llega por APIs soportadas | ✅ `saveMany({ creates })` |
| 11 | Reimportar no duplica | ✅ también tras reiniciar |
| 12 | Hay historial | ✅ sobrevive restart y restore |
| 13 | Hay tests | ✅ 318 |
| 14 | Hay documentación | ✅ |
| 15 | No se filtran datos en logs | ✅ verificado sobre 4.416 líneas reales |

---

## Siguiente paso recomendado

Calibrar BancoEstado, Banco de Chile y Falabella/CMR con cartolas reales
privadas, siguiendo [BANK_FORMATS.md](BANK_FORMATS.md) § *Cómo calibrar un
perfil*. Los tres perfiles siguen `pending-real-sample`, y hasta que dejen de
estarlo ninguno puede marcarse como verificado.

Con esas cartolas a la vista se resuelve también **D14** —si un movimiento
`unknown` debe venir marcado o no—, que se pospuso por no tener con qué
decidirla.
