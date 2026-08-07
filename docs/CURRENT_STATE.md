# Estado actual

Qué funciona **hoy**, verificado, y qué no.

Actualizado: 2026-08-06 · Wealthfolio v3.6.2 · addon v0.1.1

---

## Cómo leer los estados

Cuatro niveles distintos, que esta documentación no mezcla:

| Nivel | Qué significa |
| --- | --- |
| **implementado** | El código existe y sus tests unitarios pasan |
| **integrado** | Está enganchado al flujo real del addon, no sólo disponible |
| **validado en host** | Se ejecutó contra un Wealthfolio v3.6.2 corriendo |
| **validado con banco real** | Se ejecutó contra una cartola real de ese banco |

**Hoy nada del proyecto pasa de *integrado*.** No existe una sola línea de
evidencia obtenida de un Wealthfolio en ejecución.

---

## Verificación automática

```
typecheck   ✅  tsc --noEmit, strict + noUncheckedIndexedAccess
lint        ✅  eslint, 0 errores, 0 warnings, sin `any`
tests       ✅  301 pasando (16 archivos)
build       ✅  dist/addon.js — 747 KB (194 KB gzip), un solo archivo
```

`./scripts/test.sh` corre las cuatro.

---

## Matriz de validación

`Unit` = tests automatizados. `Host` = ejecutado contra Wealthfolio real.
`Restart` = sobrevive a reiniciar el contenedor.

| Componente | Unit | Host | Restart | Estado |
| --- | --- | --- | --- | --- |
| Parser (core) | PASS | NOT TESTED | n/a | Integrado; sin cartolas reales |
| Money | PASS | n/a | n/a | Integrado |
| Fechas | PASS | n/a | n/a | Integrado |
| Perfil bancario sintético | PASS | NOT TESTED | n/a | 3 bancos `pending-real-sample` |
| Carga del addon | n/a | BLOCKED | BLOCKED | Sin Docker en esta máquina |
| Rutas / navegación | n/a | BLOCKED | BLOCKED | Sin Docker |
| API `accounts` | PASS (doble) | BLOCKED | n/a | Contrato leído del SDK |
| `activities.search` | PASS (doble) | BLOCKED | n/a | Nombres de filtro corregidos, sin verificar en runtime |
| `activities.saveMany` | PASS (doble) | BLOCKED | n/a | Forma `{ creates }` confirmada por contrato |
| Round-trip de metadata | PASS (doble) | BLOCKED | BLOCKED | El blob JSON existe en el modelo Rust |
| Deduplicación exacta | PASS | BLOCKED | BLOCKED | 24 tests |
| Deduplicación probable | PASS | BLOCKED | BLOCKED | **Estaba rota**; corregida y cubierta |
| Historial de importaciones | PASS | BLOCKED | BLOCKED | Incl. 2.000 registros sin superar el límite |
| Storage del addon | PASS | BLOCKED | BLOCKED | Particionado verificado por bytes |
| Panel | PASS (agregados) | BLOCKED | BLOCKED | Ventana temporal, avisa si trunca |
| Semántica de transferencia interna | PASS | BLOCKED | n/a | Mapeo `TRANSFER_IN`/`OUT` sin verificar en runtime |
| Semántica de tarjeta de crédito | PASS | BLOCKED | n/a | **Hipótesis razonada**, no un hecho |
| Backup / restore | NOT TESTED | BLOCKED | BLOCKED | Scripts escritos, nunca ejecutados |

`BLOCKED` significa una sola cosa en toda esta tabla: **Docker no está instalado
en esta máquina**, así que no hay ninguna instancia de Wealthfolio contra la cual
ejecutar nada. No es un fallo del código y tampoco es un aprobado.

---

## Bloqueo de la Parte B

```
$ docker --version
zsh: command not found: docker
$ docker compose version
zsh: command not found: docker
```

Ni `docker` ni `podman`. Todo lo que exige un host corriendo queda **BLOCKED**:
carga del addon, contrato real de las APIs, importación end-to-end, idempotencia
tras reinicio, semántica de caja / transferencia / tarjeta, y backup/restore.

### Para desbloquearlo

```bash
# 1 · Instalar Docker Engine + plugin compose (Debian/Ubuntu)
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER"    # cerrar y reabrir sesión

# 2 · Comprobar
docker --version && docker compose version

# 3 · Levantar el Wealthfolio fijado
cd /home/proyectos/wealthfolio-chile
cp infra/.env.example infra/.env   # revisar WF_VERSION=3.6.2
./scripts/stack.sh start
./scripts/stack.sh status          # healthcheck en verde

# 4 · Desplegar el addon
./scripts/deploy-addon.sh

# 5 · Recién entonces, el guion de validación de docs/HOST_VALIDATION.md
```

Ver [HOST_VALIDATION.md](HOST_VALIDATION.md) para el guion completo: qué crear,
qué observar y qué anotar en cada paso.

---

## Funciona (verificado por tests)

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
| Huellas e idempotencia | ✅ 24 tests |
| Traducción a actividades de Wealthfolio (ida y vuelta) | ✅ 24 tests |
| Conciliación de transferencias internas | ✅ 11 tests |
| Conciliación de pagos de tarjeta | ✅ |
| Normalización de comercios | ✅ |
| Motor de reglas + 24 reglas predefinidas | ✅ 24 tests |
| Detección de cuotas y planes | ✅ 20 tests |
| Métricas mensuales, categorías, comercios, recurrentes | ✅ |
| Insights deterministas | ✅ |
| Redacción y enmascarado | ✅ 15 tests |

### Servicios (`services/`)

| Área | Estado |
| --- | --- |
| Índice de duplicados desde el host | ✅ 13 tests, con doble mínimo |
| Escritura por `saveMany` y desglose del resultado | ✅ 17 tests |
| Preparación del preview y bloqueo de importación | ✅ 11 tests |
| Relectura de movimientos importados | ✅ 9 tests |
| Storage particionado e historial a volumen | ✅ 17 tests |

### Flujo de importación

De punta a punta contra fixtures sintéticos:

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

**Reimportar el mismo archivo produce cero movimientos nuevos.** Verificado por
test, incluyendo archivos con períodos solapados.

---

## No funciona / no está hecho

| Qué | Por qué |
| --- | --- |
| **Cualquier validación en host** | Docker no está instalado aquí. Ver arriba |
| **Perfiles bancarios validados** | No hay cartolas reales. Los tres bancos tienen adaptador completo, marcado `pending-real-sample`. Ver [BANK_FORMATS.md](BANK_FORMATS.md) |
| **Conciliación multi-cuenta integrada** | El motor y la fachada de orquestación están listos y testeados; falta la pantalla de revisión. Ver [ARCHITECTURE.md](ARCHITECTURE.md) § Conciliación |
| **UI de reglas** | Las reglas predefinidas se aplican; no hay editor. Se pueden escribir en `storage` a mano |
| **Editor de categorías** | Mismo caso |
| **Servicio importador** | Decisión D11: no aporta hasta que los perfiles estén validados |
| **IA / MCP propio** | Decisión D10 y D12 |
| **Fintoc** | Sin credenciales; solo existe la abstracción conceptual |
| **Licencia** | Decisión pendiente del propietario. Todo declara `UNLICENSED`. Ver D13 |

---

## Errores encontrados en la auditoría 0.1.1

Cinco, todos en la frontera con el host y ninguno detectable por los tests que
existían:

| # | Error | Consecuencia real |
| --- | --- | --- |
| 1 | El signo se perdía al releer una actividad | **Ningún duplicado probable se detectaba jamás.** La huella exacta seguía funcionando, que es por qué nadie lo notó |
| 2 | `startDate`/`endDate` no existen en v3.6.2 | Los filtros de fecha se ignoraban en silencio; toda consulta escaneaba la cuenta completa |
| 3 | El wizard quedaba en blanco si fallaba leer duplicados | Estado inconsistente, y el comentario del código prometía un respaldo que no ocurría |
| 4 | Una importación parcial mostraba el toast verde | El usuario creía que se guardó todo |
| 5 | Un fallo al guardar el historial anulaba la importación | Los movimientos ya estaban escritos; el error hacía pensar lo contrario |

Los cinco están corregidos y cubiertos por tests de regresión.

---

## MVP: 12 de 15

| # | Criterio | Estado |
| --- | --- | --- |
| 1 | Wealthfolio se levanta localmente | ⚠️ escrito, no ejecutado (falta Docker) |
| 2 | El addon se carga | ⚠️ compila; carga no verificada |
| 3 | Se puede seleccionar un archivo | ✅ |
| 4 | Se detecta o elige el banco | ✅ |
| 5 | Se transforma al modelo canónico | ✅ |
| 6 | Existe vista previa | ✅ |
| 7 | Se calculan ingresos y egresos | ✅ |
| 8 | Se detectan duplicados | ✅ exactos y probables |
| 9 | El usuario confirma | ✅ |
| 10 | Llega por APIs soportadas | ✅ `saveMany({ creates })` |
| 11 | Reimportar no duplica | ✅ con test |
| 12 | Hay historial | ✅ |
| 13 | Hay tests | ✅ 301 |
| 14 | Hay documentación | ✅ |
| 15 | No se filtran datos en logs | ✅ con test |

---

## Siguiente paso recomendado

1. Instalar Docker en una máquina y ejecutar
   [HOST_VALIDATION.md](HOST_VALIDATION.md) completo.
2. Recién con esa matriz en verde, calibrar BancoEstado, Banco de Chile y
   Falabella/CMR con cartolas reales privadas, siguiendo
   [BANK_FORMATS.md](BANK_FORMATS.md) § *Cómo calibrar un perfil*.
