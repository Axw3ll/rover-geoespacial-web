# Contrato gateway ↔ nube (MQTT)

Este documento describe lo que el **gateway** (ESP32 + SX1278 + SIM800L) debe hacer para que
el sitio funcione con el firmware `Carrito_ESP32_Linea_Pivote.ino`.

## Tópicos

Con `MQTT_TOPIC_PREFIX=udec/telematica/equipoX`, `DEVICE_ID=CAR01` y `GATEWAY_ID=GW01`, la base es
`udec/telematica/equipoX/CAR01`. Los tópicos `rx` y `status` se pueden cambiar con `MQTT_TOPIC_RX` y
`MQTT_TOPIC_STATUS` en el `.env` si el gateway publica en otro lugar.

| Tópico | Quién publica | Quién se suscribe | Contenido |
|---|---|---|---|
| `<base>/rx` | Gateway | Backend y navegador | Mensaje del rover **ya verificado** (sin la trama HMAC). JSON `{"device":"CAR01","seq":4460,"rssi":-83,"snr":3.0,"ms":16221843,"payload":"GPS,LAT=..."}` (también se acepta texto plano o `{"msg":"..."}`) |
| `<base>/cmd` | Backend | Gateway | Comando en texto plano (`FWD`, `AUTO TARGET 19.24 -103.72`, `ROUTE BATCH 12 MORE 2\|TURN:PIVOT:LEFT:45\|FWD:5.00`) |
| `<prefijo>/GW01/status` | Gateway | Backend y navegador | Estado del gateway, p. ej. `{"type":"connection","gateway":"GW01","online":true,"mode":"SIM","ms":16236758}` |
| `<base>/web/cmd` | Navegador | Backend | `{"id","command","token"}` — el backend valida rol y reenvía a `<base>/cmd` |
| `<base>/web/ack` | Backend | Navegador | `{"id","ok","error"}` |
| `<base>/planner` | Backend (retenido) | Navegador | Estado del planificador del modo automático |

> El gateway **solo** debe suscribirse a `<base>/cmd`. Si el broker lo permite, configura ACL para
> que las credenciales del navegador no puedan publicar en `<base>/cmd` (solo en `<base>/web/cmd`).

## Del rover a la nube (LoRa → MQTT)

Trama recibida por LoRa: `V1|CAR01|GW01|SEQ|MENSAJE|HMAC`

1. Separar por el **último** `|`: `firmado = V1|CAR01|GW01|SEQ|MENSAJE`, `mac = HMAC` (64 hex).
2. Calcular `HMAC-SHA256(clave, firmado)` con la **misma** clave de 32 bytes que `LORA_HMAC_KEY_HEX`.
3. Comparar en tiempo constante y exigir `SEQ > último SEQ del rover aceptado` (guardarlo en NVS).
4. Publicar en `<base>/rx` el JSON con `payload` = `MENSAJE`, `seq`, y `rssi`/`snr` de `LoRa.packetRssi()`/`packetSnr()`.

## De la nube al rover (MQTT → LoRa)

1. Recibir el comando de `<base>/cmd` (máximo 150 caracteres; el backend ya lo limita).
2. `SEQ = último SEQ enviado + 1` → **guardar en NVS antes de transmitir** (el rover rechaza secuencias repetidas).
3. `firmado = "V1|GW01|CAR01|" + SEQ + "|" + COMANDO` y transmitir `firmado + "|" + hex(HMAC-SHA256(clave, firmado))`.
4. Encolar los comandos: el SX1278 es semidúplex; respetar una ventana de recepción entre envíos
   (el rover espera 80 ms tras cada transmisión propia).

`ROUTE BATCH` contiene `|` dentro del comando. No hay ambigüedad: el rover separa la firma por el
**último** `|` y los campos de cabecera por los cuatro primeros.

## Modo automático (planificador en el backend)

```
rover → REQUEST,ROUTE,ID=5,LAT=..,LON=..,AGE_MS=..,TARGET_LAT=..,TARGET_LON=..
rover → ROUTE_CONFIG,ID=5,FWD_MS_M=3000,REV_MS_M=3000,FWD_PWM=..,REV_PWM=..
nube  → ROUTE BATCH 5 MORE 2|TURN:PIVOT:LEFT:45|FWD:5.00
rover → OK,BATCH_ACCEPTED ... EVENT,BATCH_STEP_DONE ... EVENT,BATCH_DONE → nueva REQUEST
...
nube  → ROUTE BATCH 9 FINAL 1|FWD:2.40      → rover: EVENT,ARRIVED
        (o AUTO OFF si ya está dentro del radio de llegada)
```

El rover repite `REQUEST,ROUTE` cada 5 s con un ID nuevo; si la respuesta tarda más (LoRa + 2G +
broker), el lote llega con un ID viejo y se rechaza (`ERROR,BATCH_STALE_ID`). Mantén baja la latencia
del gateway (no bloquear el `loop()` mientras el SIM800L espera respuestas AT).
