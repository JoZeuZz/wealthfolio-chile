# ADR 0005 — Transferencias internas y tarjetas de crédito en el host

**Fecha:** 2026-08-07
**Estado:** aceptada
**Contexto:** fase 0.2, primera ejecución contra un Wealthfolio v3.6.2 real

---

## Contexto

Hasta 0.1.1 el mapeo de transferencias internas y de tarjetas de crédito era una
hipótesis leída del código de upstream. La fase 0.2 la puso a prueba contra un
contenedor real. Dos de las tres suposiciones se sostuvieron; una se cayó.

### Lo que se sostuvo

**Las tarjetas de crédito funcionan como esperábamos.** Una cuenta
`CREDIT_CARD` aparece en el desglose de *net worth* bajo `liabilities`, con
`assetId` de la forma `CREDIT_CARD:<uuid>`. Una compra escrita como `WITHDRAWAL`
aumenta el pasivo y baja el patrimonio en el monto exacto; un pago escrito como
`TRANSFER_OUT` desde la cuenta más `TRANSFER_IN` en la tarjeta lo reduce, y el
efecto neto del pago sobre el patrimonio es cero.

**El neteo de una transferencia interna funciona a nivel de saldos.** Los dos
tramos mueven el cash de cada cuenta en sentidos opuestos y el total del
portafolio no cambia.

### Lo que se cayó

`docs/HOST_VALIDATION.md` afirmaba que *«por defecto una transferencia es
interna, y ese default es todo lo que sostiene la garantía de no-doble-conteo»*.
No hay tal default.

Una actividad `TRANSFER_IN`/`TRANSFER_OUT` creada por `activities.saveMany` no
lleva `metadata.flow.is_external`, y el host lo registra explícitamente:

```
WARN Unresolved transfer activity <id> on 2026-07-06 has no explicit external
     marker; marking scoped flow as unknown.
```

La consecuencia es medible en la atribución de rendimiento del host. Para la
cuenta que recibe una transferencia de 200.000 CLP:

| | `contributions` | `residual` | Aviso |
| --- | --- | --- | --- |
| Sin enlazar | `0.0` | `217.19` sin atribuir | «attribution is incomplete» |
| Enlazada | `217.19` | `0.0` | — |

`POST /api/v1/activities/link` escribe `metadata.flow.is_external = false` en
ambos tramos —respetando nuestro namespace `wealthfolioChile`, que queda
intacto— y la atribución cuadra.

### La restricción

`link`, `unlink` y `transfer-pair` existen en la API HTTP del servidor pero **no
están expuestos en `ActivitiesAPI` del SDK de addons**. La superficie que
tenemos es:

```
getAll  search  create  update  saveMany  import  checkImport
getImportMapping  saveImportMapping
```

Un addon de v3.6.2 no puede marcar una transferencia como interna.

---

## Decisión

**1 · El mapeo se queda como está.** Compra de tarjeta ⇒ `WITHDRAWAL`, pago ⇒
`TRANSFER_OUT`/`TRANSFER_IN`, transferencia propia ⇒ `TRANSFER_OUT`/`TRANSFER_IN`.
La evidencia lo respalda y no hay alternativa mejor dentro de las APIs
disponibles.

**2 · No perseguimos la atribución del host.** Nuestras métricas netean las
transferencias desde nuestra propia metadata (`kind: internal_transfer`), no
desde `flow.is_external`, y por eso el panel Chile da los números correctos
aunque la atribución de Wealthfolio quede degradada. Lo que está incompleto es
un cálculo del host sobre datos del host.

**3 · No escribimos `metadata.flow` a mano.** Sería tentador incluir
`{"flow":{"is_external":false}}` en el blob que mandamos, ya que `metadata` es un
JSON libre. Se descarta: es una estructura interna de upstream, no documentada
para terceros, y una versión futura puede cambiarla o empezar a validarla. Una
integración que depende de adivinar el formato privado de otro proyecto se rompe
en la actualización que nadie miró.

**4 · El enlazado se pospone a la fase de conciliación.** Cuando exista la UI de
conciliación multi-cuenta —donde el usuario confirma que dos movimientos son los
dos tramos de la misma transferencia— habrá que decidir cómo persistir esa
confirmación en el host. Las opciones, en orden de preferencia:

- Pedir a upstream que exponga `link`/`transfer-pair` en `ActivitiesAPI`. Es la
  única que no depende de nada frágil, y el caso de uso es general.
- Usar `network` con permiso explícito del usuario para llamar a la API HTTP del
  propio host. Funciona, pero convierte un addon en un cliente HTTP de su
  anfitrión, con la sesión del usuario. Feo, y hay que sopesarlo.
- No enlazar, y documentar que la atribución del host queda parcial para quien
  importe cartolas chilenas. Aceptable mientras el producto sea el flujo mensual
  y no el rendimiento.

---

## Consecuencias

- Los números del panel Chile son correctos hoy y no dependen de esta decisión.
- La atribución de rendimiento de Wealthfolio queda `quality: "partial"` en las
  cuentas con transferencias importadas. Hay que decirlo en la documentación de
  usuario, no dejar que lo descubra solo.
- `CREDIT_CARD` no tiene performance en v3.6.2 —`"Performance unavailable for
  this account type."`—, así que la pregunta por el net contribution de una
  tarjeta no tiene respuesta y no hay que inventarla.
- Una tarjeta con saldo cero no aparece en ninguna vista del host. No es un
  error, pero conviene que la documentación lo diga antes de que alguien la
  busque.

---

## Evidencia

`docs/HOST_VALIDATION.md` §§ 12 y 13, ejecutado el 2026-08-07 contra
`wealthfolio/wealthfolio:3.6.2` (digest del commit `633d3a1`, tag `v3.6.2`).
