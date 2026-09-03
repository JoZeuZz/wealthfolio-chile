# ADR 0006 — Flujo de caja y gasto son métricas distintas

Fecha: 2026-09-03 · Estado: aceptado

## Contexto

`MonthlySummary` reportaba `income`, `expenses` y `net`. `income` se calculaba
con `isIncome()`, que responde «¿esto sube la caja?» — y una devolución la sube.

Con una compra de $100.000 y una devolución de $20.000 el mes salía así:

```
income   20.000     (la devolución)
expenses 100.000
net      −80.000
savings  −80.000 / 20.000 = −400 %
```

Verificado antes de arreglarlo, no deducido. Un mes en que a alguien le
devolvieron dinero se presentaba como un mes catastrófico, y la cifra que más
lo delataba —la tasa de ahorro— era la más visible del panel.

El problema no es un signo mal puesto. Son dos preguntas distintas bajo un
mismo nombre:

- **caja**: cuánto dinero entró y salió de las cuentas;
- **gasto**: cuánto se consumió.

Las dos son ciertas y no coinciden. Una devolución sube la caja *y* reduce el
gasto; un pago de tarjeta baja la caja y no es gasto ninguno.

## Decisión

`MonthlySummary` lleva las dos vistas, con nombres que no se pueden confundir:

```
cashInflows   cashOutflows   netCashFlow
grossSpending refunds        netSpending
income        savingsRate
```

- `income` significa **dinero externo que entra**. Una devolución no lo es.
- `savingsRate` es `(income − netSpending) / income`.
- Invariantes fijadas por test:
  `fixedExpenses + variableExpenses === grossSpending`,
  `netSpending === grossSpending − refunds`,
  `netCashFlow === cashInflows − cashOutflows`.

`expenses` y `net` **se eliminan**, no se dejan como alias. Los dos nombres
tenían dos significados, y dejar cualquiera de ellos habría permitido que el
siguiente llamador eligiera el equivocado sin enterarse.

Las categorías heredan la distinción: cada una reporta `gross`, `refunds` y un
`amount` neto. Una devolución se atribuye a la categoría que trae y a ninguna
otra —adivinar qué compra deshace movería el total de supermercado de alguien
por una corazonada— y una categoría puede quedar negativa, porque el mes
realmente terminó con dinero de vuelta y esconderlo rompería la suma.

## Consecuencias

- El panel muestra «Gasto neto» y «Flujo de caja» como cifras separadas, y
  cuando hubo devoluciones dice el bruto del que sale el neto.
- Los insights hablan de gasto neto cuando hablan de gasto, y de flujo de caja
  cuando hablan de caja.
- Un mes con devoluciones grandes puede tener gasto neto negativo en una
  categoría. Es correcto y se muestra así.

## Alternativas descartadas

**Dejar `expenses` como alias de `grossSpending`.** Habría mantenido compilando
todo lo existente y conservado exactamente la ambigüedad que causó el defecto.

**Restar las devoluciones de los ingresos.** Habría arreglado la tasa de ahorro
y roto la caja: el dinero de una devolución sí entró a la cuenta.
