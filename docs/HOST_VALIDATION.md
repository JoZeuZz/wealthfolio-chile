# Validación contra Wealthfolio real

Guion de la Parte B de la fase 0.1.1. **No se ha ejecutado todavía**: la máquina
donde se escribió no tiene Docker. Ver el bloqueo en
[CURRENT_STATE.md](CURRENT_STATE.md).

Este documento existe para que cuando haya un host disponible no haya que
reinventar qué mirar. Cada sección dice qué hacer, qué observar y dónde anotar el
resultado.

> **Regla.** Nada de esto se marca `PASS` por haber compilado, ni por parecer
> razonable. Un `PASS` en la matriz significa: alguien lo ejecutó y lo vio.
> Cualquier otra cosa es `NOT TESTED`.

---

## 0 · Requisitos

```bash
docker --version          # Docker Engine 24+
docker compose version    # plugin v2
```

Si alguno falla, la Parte B entera está `BLOCKED`. No hay sustituto.

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER"   # cerrar y reabrir sesión
```

---

## 1 · Levantar el host fijado

```bash
cd /home/proyectos/wealthfolio-chile
cp infra/.env.example infra/.env
grep WF_VERSION infra/.env          # debe ser 3.6.2 — no actualizar en esta fase
./scripts/stack.sh start
./scripts/stack.sh status
./scripts/stack.sh logs
```

Comprobar y anotar:

| Qué | Cómo se ve un PASS |
| --- | --- |
| El contenedor arranca | `status` lo lista corriendo |
| Healthcheck | estado `healthy`, no `starting` indefinido |
| Volumen persistente | `docker volume ls` muestra `wealthfolio-data` |
| Reinicio | `./scripts/stack.sh restart` y la app vuelve con los datos |
| Autenticación | anotar si pide credenciales y cuáles al primer arranque |
| Logs | sin errores ni panics de Rust en el arranque limpio |

`compose.dev.yml` desactiva la autenticación. **No usarlo** en esta validación:
lo que interesa es el comportamiento por defecto.

---

## 2 · Instalar el addon de verdad

```bash
./scripts/deploy-addon.sh
```

Abrir Wealthfolio en el navegador y comprobar, uno por uno:

- [ ] La app carga
- [ ] «Chile» aparece en la barra lateral
- [ ] El panel abre (`/addons/wealthfolio-chile`)
- [ ] Importar abre (`…/importar`)
- [ ] Historial abre (`…/importaciones`)
- [ ] La navegación entre las tres funciona en ambos sentidos
- [ ] El addon se puede desactivar y volver a activar sin recargar
- [ ] Consola del navegador: **cero** errores de sandbox
- [ ] Consola: cero errores críticos del addon
- [ ] Los permisos que muestra el host son exactamente `accounts.getAll`,
      `activities.search`, `activities.saveMany`, `settings.get`

Si el sidebar no aparece, el sospechoso es el `id` de `contributes.routes`
contra el que se pasa a `ctx.router.add()`: si difieren, la página queda en
blanco sin error.

---

## 3 · Contrato del host

Crear tres cuentas **de desarrollo** (nada real):

```
BancoChile Test    CASH
BancoEstado Test   CASH
CMR Test           CREDIT_CARD
```

Verificar contra la instancia, no contra los tipos:

| API | Qué comprobar |
| --- | --- |
| `accounts.getAll()` | Devuelve las tres, con `currency` y `isActive` |
| `activities.search()` | `dateFrom`/`dateTo` filtran de verdad; `accountIds` acota; `meta.totalRowCount` es el total filtrado, no el de la página |
| `activities.saveMany()` | `{ creates }` crea; anotar qué devuelve `errors` cuando una fila es inválida |
| `storage.get/set()` | Escribir, leer, y anotar el tamaño exacto al que `set` empieza a rechazar |

**Anotar cualquier divergencia con [UPSTREAM.md](UPSTREAM.md) § Auditoría de
contrato.** El runtime manda sobre el tipo publicado y sobre la documentación.

---

## 4 · Importación sintética end-to-end

Sobre una instancia limpia, con `samples/synthetic/`:

1. Importar `banco-chile-cuenta-corriente.csv` en «BancoChile Test».
2. Comprobar en la vista previa: totales, tipos, categorías, duplicados.
3. Confirmar.
4. En la lista de actividades **de Wealthfolio** (no la del addon), comprobar
   por cada movimiento: monto, `activityType`, fecha y comentario.
5. Comprobar que la metadata sobrevivió: el panel del addon sólo muestra
   movimientos con nuestra metadata, así que si aparecen, sobrevivió.
6. Comprobar el historial de importaciones.

Después:

```bash
./scripts/stack.sh restart
```

7. Reabrir el addon: el panel y el historial siguen ahí.
8. **Reimportar el mismo archivo.** Resultado esperado: todas las filas marcadas
   como duplicado exacto, cero movimientos nuevos.
9. Editar el CSV cambiando *sólo* una descripción (por ejemplo añadir ` 1234`) e
   importar. Resultado esperado: esa fila sale como **posible duplicado**, no
   como nueva.

El paso 9 es el que valida la corrección del signo. Antes de 0.1.1 salía como
nueva, y ese era el bug.

---

## 5 · Semántica financiera

Escenario controlado en «BancoChile Test», partiendo de cero:

```
+1.000.000   sueldo
  -100.000   supermercado
   -50.000   combustible
```

Esperado en el panel Chile:

```
ingresos = 1.000.000
egresos  =   150.000
neto     =   850.000
```

Y anotar qué hace **Wealthfolio nativo** con lo mismo:

| Métrica del host | Valor observado | Coincide con lo esperado |
| --- | --- | --- |
| Cash de la cuenta | | |
| Net contribution | | |
| Valor del portafolio | | |
| Spending del host | | |

Cualquier divergencia se documenta **antes** de tocar el modelo. Que el host
cuente distinto no significa automáticamente que estemos equivocados: significa
que hay dos definiciones y hay que elegir cuál mostramos y por qué.

---

## 6 · Contrato de transferencia

Sin construir todavía la UI de conciliación, crear a mano:

```
BancoChile Test    TRANSFER_OUT  200.000
BancoEstado Test   TRANSFER_IN   200.000
```

Comprobar y anotar:

- [ ] Efecto total en el portafolio = **0**
- [ ] Efecto por cuenta: −200.000 y +200.000
- [ ] Net contribution a nivel de portafolio: sin cambio
- [ ] Net contribution por cuenta: sí cambia (comportamiento documentado)
- [ ] Ninguna de las dos aparece como gasto ni ingreso en el panel Chile

Si el portafolio **no** neteó a cero, revisar `metadata.flow.is_external`: por
defecto una transferencia es interna, y ese default es todo lo que sostiene la
garantía de no-doble-conteo.

---

## 7 · Contrato de tarjeta de crédito

Éste es el que menos sabemos. Determinar **empíricamente**, en «CMR Test»:

| Situación | Qué crear | Qué observar |
| --- | --- | --- |
| Compra | `WITHDRAWAL` 59.990 | ¿Sube el pasivo? ¿Baja el patrimonio? ¿Qué signo muestra el saldo? |
| Pago desde cuenta | `TRANSFER_OUT` en la cuenta + `TRANSFER_IN` en la tarjeta | ¿Baja el pasivo? ¿Neteó a cero? |

Nuestro mapeo actual (compra ⇒ `WITHDRAWAL`, pago ⇒ `TRANSFER_OUT`/`TRANSFER_IN`)
es una hipótesis razonada a partir de la documentación. **No cambiar el modelo
antes de documentar la divergencia**, si la hay.

---

## 8 · Contrato de devolución

Crear un `CREDIT` con subtipo `REFUND` y comprobar:

- [ ] Aumenta la caja
- [ ] **No** altera net contribution (la documentación dice que `BONUS` sí y
      `REFUND` no)
- [ ] El addon lo relee como `refund` con monto positivo

Si constantes, documentación y runtime discrepan, **manda el runtime**, y se
documenta en [UPSTREAM.md](UPSTREAM.md).

---

## 9 · Storage y reinicio

```bash
./scripts/stack.sh restart
```

- [ ] Ajustes del addon: sobreviven
- [ ] Historial de importaciones: sobrevive
- [ ] Metadata de las actividades: sobrevive íntegra (acentos, arrays, anidados)
- [ ] Detección de duplicados: sigue funcionando tras el reinicio

**Volumen sintético.** Escribir el equivalente a varios miles de movimientos e
importaciones (sintéticos, nunca reales) y comprobar que ningún valor supera el
límite por ítem. `tests/storage.test.ts` ya fija 2.000 registros en el doble; lo
que falta aquí es confirmar el límite **real** del host y que la partición lo
respeta.

---

## 10 · Backup y restore

No se marca nada como validado hasta haber restaurado.

```bash
# 1 · datos sintéticos ya cargados
./scripts/backup.sh
ls -la backups/

# 2 · romper algo a propósito: borrar actividades desde la UI

# 3 · restaurar (pide escribir RESTAURAR)
./scripts/restore.sh backups/wealthfolio-<stamp>.tar.gz

# 4 · arrancar y comprobar
./scripts/stack.sh start
```

- [ ] El backup se creó y pesa algo coherente
- [ ] El contenedor se detuvo durante el backup (copiar SQLite en caliente puede
      capturar una transacción a medias)
- [ ] Tras restaurar, los datos borrados vuelven
- [ ] El addon sigue instalado y funcionando

---

## 11 · Cerrar

Actualizar la matriz de [CURRENT_STATE.md](CURRENT_STATE.md) con lo observado —
`PASS`, `FAIL` o `NOT TESTED`, nunca una suposición — y anotar en
[UPSTREAM.md](UPSTREAM.md) cualquier divergencia entre runtime y contrato.
