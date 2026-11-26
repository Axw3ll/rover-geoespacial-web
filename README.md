# Estación Geoespacial de Reconocimiento — sitio web

Back-end (Node.js + Express + MongoDB + MQTT) y front-end para el rover del archivo
`Carrito_ESP32_Linea_Pivote.ino`, según la **Práctica II (Folio 8)** de Entornos Inteligentes y
Tecnologías Disruptivas.

```
Robot ESP32 ──LoRa 433 MHz (HMAC)──► Gateway ESP32 ──2G──► Broker MQTT ◄──WSS──► Navegador
                                                              ▲
                                                              │ TCP
                                                   Back-end Node.js ──► MongoDB Atlas
                                                   (API REST + middleware + planificador)
```

## Requisitos del PDF y dónde se cumplen

| Requisito | Implementación |
|---|---|
| Autenticación, cuentas Administrador y Usuario | `login.html`, JWT en cookie httpOnly, `src/routes/auth.js`. Todas las páginas exigen sesión. |
| Navegación: Inicio, Base de datos, Monitoreo, Gestión | Barra superior en todas las páginas (`public/js/common.js`). |
| Inicio (portada del equipo) | `index.html` — editar el bloque `TEAM` con nombre del equipo e integrantes. |
| Análisis: CRUD, tablas, gráficas, búsqueda y filtros | `datos.html` + `GET/POST/PATCH/DELETE /api/records`. Filtros por sensor, apartado, origen, fechas, texto y **radio geográfico** (índice `2dsphere`). |
| Exportar CSV y JSON | `GET /api/records/export?format=csv|json` (respeta los filtros). Extra: `format=kml` para Google Earth Pro. |
| Subir archivo de la microSD, graficar recorrido, temperatura y presión | `datos.html` → sección microSD. Lee `/rover.csv` (`millis,sensor,"valor"`), detecta reinicios del ESP32, calcula fecha/hora con las lecturas RTC, dibuja trayectoria, T/P y distancia-tiempo; opcionalmente lo importa a MongoDB. |
| Monitoreo en tiempo real (BMP280, ubicación, mapa) | `monitoreo.html` — MQTT sobre WebSockets, Leaflet, Chart.js, radar, bitácora. |
| Datalogger: rastro en mapa interactivo | Monitoreo (en vivo) y Base de datos (histórico / por archivo). |
| Gestión manual (botones / joystick) | `gestion.html` → Manual: cruceta con repetición mientras se sostiene, teclado WASD/flechas, maniobras calibradas. |
| Gestión automática (destino en mapa + planificación) | `gestion.html` → Automático + `src/planner.js` (responde `REQUEST,ROUTE` con `ROUTE BATCH`). |
| Back-end: API RESTful + middleware MQTT-MongoDB que corre aunque nadie abra el sitio | `server.js` inicia `src/bridge.js`; también `npm run bridge` lo ejecuta solo. |
| Control por *websockets* por MQTT | El navegador usa MQTT.js por `wss://`; publica en `<base>/web/cmd` y recibe `<base>/rx`. |

## Instalación

1. Node.js 18 o superior (LTS recomendado).
2. `npm install`
3. Copia `.env.example` a `.env` y completa:
   - `JWT_SECRET`: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
   - `MONGODB_URI`: cadena de MongoDB Atlas (en Atlas, agrega tu IP en *Network Access*).
   - `MQTT_URL` (TCP para el backend) y `MQTT_WS_URL` (WebSockets para el navegador) del **mismo** broker.
   - `ADMIN_EMAIL` / `ADMIN_PASSWORD`: se crea esa cuenta Administrador al arrancar si no existe.
4. `npm start` y abre `http://localhost:3000`.

### Probar sin el robot (simulador)

```bash
npm start            # terminal 1
npm run simulador    # terminal 2: imita gateway + rover (GPS con ruido, obstáculos aleatorios)
```

Con el simulador puedes usar todo el sitio: sondeos (`POLL ENV 5`), control manual, radar,
seguidor de línea y el modo automático completo. **No** lo ejecutes junto con el gateway real
usando el mismo prefijo de tópicos.

`npm test` corre las pruebas del parser, del lector de microSD, de permisos y del planificador
(con un rover simulado de rumbo inicial desconocido).

## Seguridad — léelo antes de conectar el rover real

- Los brokers públicos (`broker.hivemq.com`, etc.) **sirven solo para pruebas con el simulador**:
  cualquiera que adivine el tópico puede publicar en `<base>/cmd` y el gateway firmaría ese comando.
  Usa un broker con usuario/contraseña (HiveMQ Cloud, EMQX Cloud o Mosquitto propio con TLS) y ACL:
  - credenciales del **gateway**: publicar `<base>/rx`, `<prefijo>/GW01/status`; suscribirse a `<base>/cmd`.
  - credenciales del **backend**: todo `<base>/#`.
  - credenciales del **navegador** (`MQTT_WS_*`, se entregan a usuarios con sesión): suscribirse a
    `<base>/rx`, `<base>/web/ack`, `<base>/planner`, `<prefijo>/GW01/status`; publicar solo `<base>/web/cmd`.
- El backend valida cada comando del navegador (token firmado + rol) antes de reenviarlo
  (`src/policy.js`). La cuenta **Usuario** puede: control manual, automático, seguidor de línea y
  lecturas. **Administrador** además: calibración (`TURNSET`, `DRIVESET`, `MANUALSET`, `LINESET`),
  sondeos, `RTC SET`, GPS, microSD, radar, terminal libre, CRUD y cuentas.
- La clave HMAC del firmware está en el `.ino`. No subas ese archivo a un repositorio público.

## API RESTful (todas requieren sesión salvo login/registro)

| Método | Ruta | Descripción |
|---|---|---|
| POST | `/api/auth/register` | Crea cuenta Usuario `{name,email,password}` |
| POST | `/api/auth/login` | `{email,password}` → cookie de sesión |
| POST | `/api/auth/logout` | Cierra sesión |
| GET | `/api/auth/me` | Usuario actual |
| GET | `/api/records` | Listado paginado. Filtros: `sensor, category, source, from, to, q, near=lat,lon, radius, uploadId, page, limit` |
| GET | `/api/records/:id` | Un registro |
| POST | `/api/records` | Crear (Admin) `{sensor, category, ts, lat, lon, raw, data, notes}` |
| PATCH | `/api/records/:id` | Editar (Admin) |
| DELETE | `/api/records/:id` | Eliminar (Admin) |
| GET | `/api/records/export?format=csv\|json\|kml` | Exportación con los mismos filtros |
| GET | `/api/records/series` | Serie temporal ENV (T, H, P) |
| GET | `/api/records/trail` | Puntos GPS ordenados (rastro) |
| GET | `/api/records/stats` | Resumen para Inicio |
| POST | `/api/uploads` | Importar `rover.csv` (multipart, campo `file`) |
| GET | `/api/uploads` | Archivos importados |
| DELETE | `/api/uploads/:id` | Elimina archivo y sus registros (Admin) |
| POST | `/api/commands` | `{command}` — alternativa REST para enviar comandos (Postman) |
| GET | `/api/status` | Estado de MongoDB, MQTT y planificador |
| GET | `/api/config` | Datos de conexión MQTT-WS del navegador |
| GET/PATCH/DELETE | `/api/users[/:id]` | Gestión de cuentas (Admin) |

`docs/postman_collection.json` trae ejemplos listos para importar en Postman.

## Modelo de datos (MongoDB)

Colección `records` — un documento por mensaje / fila / comando:

```json
{
  "deviceId": "CAR01",
  "source": "lora | microsd | web | manual",
  "category": "telemetria | evento | respuesta | estado | comando",
  "sensor": "ENV | GPS | RADAR | DIST | IR | RTC | LINE_FOLLOW | EVENT | REQUEST | CMD | ...",
  "raw": "ENV,T=24.1,H=55.0,P=943.2hPa",
  "data": { "T": 24.1, "H": 55.0, "P": 943.2 },
  "location": { "type": "Point", "coordinates": [-103.725, 19.2433] },
  "ts": "2026-10-29T17:20:00.000Z",
  "millis": null, "segment": null, "uploadId": null, "notes": ""
}
```

Índices: `ts`, `sensor+ts`, `category+ts`, `uploadId` y `location` (**2dsphere**) para consultas
temporales y geográficas. Colecciones `users` y `uploads`.

## Control automático: cómo planifica

El firmware delega la ruta a la nube: en `AUTO` envía `REQUEST,ROUTE` (posición GPS + destino) y
`ROUTE_CONFIG` (calibración ms/metro). El planificador (`src/planner.js`):

1. El rover **no tiene brújula**: el rumbo se estima con dos posiciones GPS separadas por un tramo
   recto. Si aún no hay rumbo, envía primero un tramo corto (`FWD:3.00`) para medirlo.
2. Calcula el giro hacia el destino y lo redondea al perfil disponible (45°, 90° o 180°, `PIVOT`).
3. Avanza como máximo `PLANNER_MAX_LEG_M` (y nunca más de 10 m ni 30 s, límites del firmware).
4. Marca el lote como `FINAL` cuando el destino está dentro de ese tramo; si ya está a menos de
   `PLANNER_ARRIVE_RADIUS_M`, envía `AUTO OFF`.
5. Los obstáculos los resuelve el rover solo (HC-SR04 + servo) y después pide una ruta nueva.

Limitaciones reales: el GPS NEO-6M tiene varios metros de error, así que la precisión final es del
orden del radio de llegada; para recorridos más precisos convendría añadir un magnetómetro
(p. ej. QMC5883L) y reportar el rumbo en `REQUEST,ROUTE`. Calibra antes `DRIVESET FWD` y los
perfiles `TURNSET P_R45/P_R90/P_R180/P_L45/P_L90/P_L180` con las ruedas levantadas.

## Observaciones sobre el firmware que afectan al sitio

- El rover guarda el contador de secuencia en NVS **por cada mensaje LoRa**. El control manual
  repite `FWD`/`BACK`/`DRIVE` cada 350–650 ms mientras se sostiene el botón; úsalo en ráfagas
  cortas o considera persistir el contador cada N mensajes en el firmware.
- `AUTO,WAITING,GPS_NO_FIX` y las respuestas de `FWD`/`BACK` solo salen por el monitor serie; el
  sitio no las ve. Si quieres verlas, cámbialas a `sendLoRaText()`.
- `/rover.csv` es un único archivo con columna `sensor`; los "apartados separados" se obtienen al
  leerlo (pestaña por sensor en Base de datos y categoría en MongoDB).
- `millis()` reinicia con cada arranque; las fechas absolutas de la microSD dependen de que haya
  lecturas `RTC` registradas en ese arranque (por ejemplo con `POLL RTC 60` mientras graba).

## Estructura

```
server.js                 Express: API, páginas protegidas y arranque del middleware
src/config.js             Variables de entorno y tópicos MQTT
src/bridge.js             Middleware MQTT ↔ MongoDB, validación y reenvío de comandos
src/planner.js            Planificador de rutas del modo AUTO
src/policy.js             Permisos de comandos por rol
src/routes/*.js           API REST (auth, records, uploads, users/config/commands)
src/models/*.js           Esquemas Mongoose (User, Record, Upload)
public/js/roverlib.js     Parser compartido (mensajes del rover, CSV de microSD, geodesia)
public/js/common.js       Sesión, navegación, cliente MQTT-WS, mapas y gráficas
public/*.html             Inicio, Base de datos, Monitoreo, Gestión, Login
tools/simulador.js        Simulador de gateway + rover
tools/tests.js            Pruebas
docs/PROTOCOLO.md         Contrato de tópicos y tramas para programar el gateway
```
