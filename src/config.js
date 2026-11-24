require('dotenv').config();

if (!process.env.TZ) process.env.TZ = 'America/Mexico_City';

const num = (v, d) => (v === undefined || v === '' || isNaN(Number(v)) ? d : Number(v));
const prefix = (process.env.MQTT_TOPIC_PREFIX || 'udec/telematica/rover').replace(/\/+$/, '');
const deviceId = process.env.DEVICE_ID || 'CAR01';
const base = `${prefix}/${deviceId}`;

const config = {
  port: num(process.env.PORT, 3000),
  jwtSecret: process.env.JWT_SECRET || '',
  adminEmail: (process.env.ADMIN_EMAIL || 'admin@rover.local').toLowerCase(),
  adminPassword: process.env.ADMIN_PASSWORD || '',
  mongoUri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/rover',
  deviceId,
  mqtt: {
    url: process.env.MQTT_URL || 'mqtt://broker.hivemq.com:1883',
    username: process.env.MQTT_USERNAME || undefined,
    password: process.env.MQTT_PASSWORD || undefined,
    wsUrl: process.env.MQTT_WS_URL || 'wss://broker.hivemq.com:8884/mqtt',
    wsUsername: process.env.MQTT_WS_USERNAME || '',
    wsPassword: process.env.MQTT_WS_PASSWORD || ''
  },
  // Contrato de tópicos con el gateway (ver docs/PROTOCOLO.md)
  topics: {
    tx: `${base}/tx`,           // gateway -> nube: texto del rover ya verificado (HMAC)
    cmd: `${base}/cmd`,         // nube -> gateway: comando en texto plano (el gateway lo firma)
    webCmd: `${base}/web/cmd`,  // navegador -> backend: {id, command, token}
    webAck: `${base}/web/ack`,  // backend -> navegador: {id, ok, error}
    planner: `${base}/planner`, // backend -> navegador: estado del planificador
    status: `${base}/gateway`   // gateway -> nube: estado opcional (batería, RSSI, señal 2G)
  },
  planner: {
    enabled: String(process.env.PLANNER_ENABLED || 'true') !== 'false',
    maxLegM: num(process.env.PLANNER_MAX_LEG_M, 5),
    arriveRadiusM: num(process.env.PLANNER_ARRIVE_RADIUS_M, 3),
    headingMinM: num(process.env.PLANNER_HEADING_MIN_M, 1.5)
  }
};

if (!config.jwtSecret || config.jwtSecret === 'CAMBIAR_POR_UNA_CADENA_ALEATORIA') {
  console.error('[config] Define JWT_SECRET en el archivo .env (cadena aleatoria larga).');
  process.exit(1);
}

module.exports = config;
