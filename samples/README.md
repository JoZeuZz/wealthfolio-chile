# samples

```
samples/
├── synthetic/   ← versionado. Datos inventados. De aquí salen los fixtures.
└── private/     ← IGNORADO por Git. Cartolas reales. Nunca se sube nada.
```

## synthetic/

Cartolas inventadas con la estructura que esperamos de cada banco. Números de
cuenta, montos, comercios y personas son ficticios.

Todos los tests leen de aquí. `addon/tests/fixtures.ts` solo apunta a este
directorio, y hay un test que verifica que siga siendo así.

| Archivo | Simula |
| --- | --- |
| `banco-chile-cuenta-corriente.csv` | Cartola de cuenta corriente con cargo/abono/saldo |
| `banco-estado-cuentarut.csv` | CuentaRUT con canal y saldo anterior |
| `falabella-cmr.csv` | Estado de cuenta CMR con cuotas, pago recibido y anulación |

Los saldos de los fixtures cuadran a propósito: eso ejercita la validación del
recorrido de saldos, que es la comprobación más fuerte de que un archivo se
interpretó bien.

## private/

Aquí van tus cartolas reales cuando calibras un perfil bancario.

**Nada de este directorio se sube nunca.** Está en `.gitignore`, y CI falla si
aparece algo versionado bajo esta ruta.

Al calibrar con un archivo real, el resultado que queda en el repositorio es un
**fixture sintético equivalente** —misma estructura, mismos encabezados, datos
inventados— más los tests que lo cubren. El archivo real se queda en tu máquina.

Ver [docs/PRIVACY.md](../docs/PRIVACY.md) y
[docs/BANK_FORMATS.md](../docs/BANK_FORMATS.md) § *Cómo calibrar un perfil*.
