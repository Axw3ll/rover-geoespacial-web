/*
 * Simulador de gateway + rover para probar el sitio SIN hardware.
 * Imita las respuestas del firmware Carrito_ESP32 (formato de texto) y un modelo
 * de movimiento sencillo con ruido GPS. Uso: npm run simulador
 *
 * NO usar al mismo tiempo que el gateway real con el mismo prefijo de tópicos.
 */
require('dotenv').config();
const mqtt = require('mqtt');

const prefix = (process.env.MQTT_TOPIC_PREFIX || 'udec/telematica/rover').replace(/\/+$/, '');
const device = process.env.DEVICE_ID || 'CAR01';
const TX = process.env.MQTT_TOPIC_RX || `${prefix}/${device}/rx`;
let seq = 0;
const CMD = `${prefix}/${device}/cmd`;
const LATENCY_MS = Number(process.env.SIM_LATENCY_MS || 400);   // LoRa + 2G aproximado
const GPS_NOISE_M = Number(process.env.SIM_GPS_NOISE_M || 1.0);
const OBSTACLE_PROB = Number(process.env.SIM_OBSTACLE_PROB || 0.1);

const R = 6371008.8;
const rover = {
  lat: Number(process.env.SIM_LAT || 19.2433), lon: Number(process.env.SIM_LON || -103.7250),
  heading: Math.random() * 360, // desconocido para el planificador (no hay brújula)
  msPerMeter: 3000, autoState: 'OFF', target: null, requestId: 0, requestAt: 0, outstanding: false,
  batch: null, line: false, motion: null, polls: { ENV: 0, GPS: 0, IR: 0, RTC: 0 }, pollAt: {},
  T: 26 + Math.random() * 3, H: 55, P: 1013 - 70 // Colima ~500 m s.n.m.
};

const client = mqtt.connect(process.env.MQTT_URL || 'mqtt://broker.hivemq.com:1883', {
  username: process.env.MQTT_USERNAME || undefined, password: process.env.MQTT_PASSWORD || undefined,
  clientId: `sim-${device}-${Math.random().toString(16).slice(2, 8)}`
});

function send(text) {
  setTimeout(() => {
    client.publish(TX, JSON.stringify({ device, seq: ++seq, rssi: -60 - Math.round(Math.random() * 40), snr: +(5 + Math.random() * 5).toFixed(1), ms: Math.round(process.uptime() * 1000), payload: text }));
    console.log('<<', text);
  }, LATENCY_MS);
}

// ---------- Modelo de movimiento ----------
function move(meters) {
  const h = rover.heading * Math.PI / 180;
  rover.lat += (meters * Math.cos(h)) / R * 180 / Math.PI;
  rover.lon += (meters * Math.sin(h)) / (R * Math.cos(rover.lat * Math.PI / 180)) * 180 / Math.PI;
}
function noisyPos() {
  const n = () => (Math.random() * 2 - 1) * GPS_NOISE_M;
  return {
    lat: rover.lat + n() / R * 180 / Math.PI,
    lon: rover.lon + n() / (R * Math.cos(rover.lat * Math.PI / 180)) * 180 / Math.PI
  };
}
// motion: { kind: 'drive'|'turn', speed (m/s) or rate (°/s), until, onDone }
function startMotion(m) { rover.motion = { ...m, last: Date.now() }; }
function stopMotion() { rover.motion = null; }

setInterval(() => {
  const now = Date.now();
  const m = rover.motion;
  if (m) {
    const dt = (Math.min(now, m.until) - m.last) / 1000;
    m.last = now;
    if (m.kind === 'drive') move(m.speed * dt);
    else rover.heading = (rover.heading + m.rate * dt + 360) % 360;
    if (now >= m.until) { rover.motion = null; if (m.onDone) m.onDone(); }
  }
  // Petición de ruta periódica (requestAutoRoute cada 5 s mientras espera)
  if (rover.autoState === 'WAIT_ROUTE' && now >= rover.requestAt && !rover.batch) requestRoute();
  // Sondeos
  for (const [k, sec] of Object.entries(rover.polls)) {
    if (!sec) continue;
    if (!rover.pollAt[k] || now >= rover.pollAt[k]) { rover.pollAt[k] = now + sec * 1000; read(k); }
  }
}, 100);

function read(kind) {
  if (kind === 'ENV') {
    rover.T += (Math.random() - .5) * .1; rover.H += (Math.random() - .5) * .3; rover.P += (Math.random() - .5) * .05;
    send(`ENV,T=${rover.T.toFixed(1)},H=${rover.H.toFixed(1)},P=${rover.P.toFixed(1)}hPa`);
  } else if (kind === 'GPS') {
    const p = noisyPos();
    send(`GPS,LAT=${p.lat.toFixed(6)},LON=${p.lon.toFixed(6)},AGE_MS=${Math.round(Math.random() * 900)}`);
  } else if (kind === 'IR') send(`IR,LEFT=1,CENTER=0,RIGHT=1`);
  else if (kind === 'RTC') {
    const d = new Date(), z = v => String(v).padStart(2, '0');
    send(`RTC,${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}`);
  }
}

function requestRoute() {
  const p = noisyPos();
  rover.requestId++;
  rover.outstanding = true;
  rover.requestAt = Date.now() + 5000;
  let msg = `REQUEST,ROUTE,ID=${rover.requestId},LAT=${p.lat.toFixed(6)},LON=${p.lon.toFixed(6)},AGE_MS=300`;
  if (rover.target) msg += `,TARGET_LAT=${rover.target.lat.toFixed(6)},TARGET_LON=${rover.target.lon.toFixed(6)}`;
  send(msg);
  send(`ROUTE_CONFIG,ID=${rover.requestId},FWD_MS_M=${rover.msPerMeter},REV_MS_M=${rover.msPerMeter},FWD_PWM=60/60/60/60,REV_PWM=-60/-60/-60/-60`);
}

// ---------- Lotes ROUTE BATCH ----------
function runBatchStep() {
  const b = rover.batch;
  if (!b) return;
  if (b.index >= b.steps.length) {
    rover.batch = null;
    if (b.final) { rover.autoState = 'ARRIVED'; send(`EVENT,ARRIVED,ID=${b.id},STEPS=${b.steps.length}`); }
    else { rover.autoState = 'WAIT_ROUTE'; rover.requestAt = Date.now(); send(`EVENT,BATCH_DONE,ID=${b.id},STEPS=${b.steps.length}`); }
    return;
  }
  const f = b.steps[b.index].split(':');
  rover.autoState = 'DRIVING';
  const done = () => { b.index++; send(`EVENT,BATCH_STEP_DONE,ID=${b.id},STEP=${b.index}/${b.steps.length}`); runBatchStep(); };
  if (f[0] === 'TURN') {
    const deg = Number(f[3]) * (f[2] === 'RIGHT' ? 1 : -1) * (0.9 + Math.random() * 0.2); // error de perfil ±10 %
    startMotion({ kind: 'turn', rate: deg / 1.0, until: Date.now() + 1000, onDone: done });
  } else if (f[0] === 'FWD' || f[0] === 'BACK') {
    const meters = Number(f[1]);
    const ms = meters * rover.msPerMeter;
    const sign = f[0] === 'FWD' ? 1 : -1;
    if (sign > 0 && Math.random() < OBSTACLE_PROB) {
      // Obstáculo a mitad del tramo: desvío lateral y nueva petición de ruta
      startMotion({ kind: 'drive', speed: 1000 / rover.msPerMeter, until: Date.now() + ms / 2, onDone: () => {
        send('EVENT,OBSTACLE,ANGLE=90,DIST_CM=20');
        send(`EVENT,BATCH_INTERRUPTED,ID=${b.id},STEP=${b.index + 1}/${b.steps.length},REASON=OBSTACLE`);
        rover.batch = null;
        const side = Math.random() < .5 ? 90 : -90;
        rover.heading += side; move(0.8); rover.heading -= side; move(0.6);
        rover.autoState = 'WAIT_ROUTE'; rover.requestAt = Date.now() + 2500;
        send('EVENT,OBSTACLE_CIRCUMVENTED,REQUEST_ROUTE');
      } });
    } else {
      startMotion({ kind: 'drive', speed: sign * 1000 / rover.msPerMeter * (0.9 + Math.random() * 0.2), until: Date.now() + ms, onDone: done });
    }
  }
}

// ---------- Comandos ----------
function handle(raw) {
  const c = raw.trim().toUpperCase();
  console.log('>>', c);
  let m;
  if (c === 'STOP') { stopMotion(); rover.batch = null; rover.line = false; if (rover.autoState !== 'OFF') rover.autoState = 'OFF'; return send('OK,STOP'); }
  if (c === 'FWD' || c === 'BACK') { startMotion({ kind: 'drive', speed: (c === 'FWD' ? 1 : -1) * 0.35, until: Date.now() + 700 }); return; }
  if ((m = c.match(/^DRIVE (-?\d+) (-?\d+) (-?\d+) (-?\d+)$/))) {
    const left = (+m[1] + +m[3]) / 2, right = (+m[2] + +m[4]) / 2;
    if (Math.sign(left) !== Math.sign(right)) startMotion({ kind: 'turn', rate: left > right ? 90 : -90, until: Date.now() + 700 });
    else startMotion({ kind: 'drive', speed: Math.sign(left) * 0.35, until: Date.now() + 700 });
    return send('OK,DRIVE_LEASE_700MS');
  }
  if ((m = c.match(/^(FWD|BACK)_SEC ([\d.]+)$/))) {
    const ms = +m[2] * 1000;
    startMotion({ kind: 'drive', speed: (m[1] === 'FWD' ? 1 : -1) * 1000 / rover.msPerMeter, until: Date.now() + ms });
    return send(`OK,STRAIGHT,${ms}ms`);
  }
  if ((m = c.match(/^TURN (PIVOT|NORMAL) (LEFT|RIGHT) (45|90|180)$/))) {
    startMotion({ kind: 'turn', rate: +m[3] * (m[2] === 'RIGHT' ? 1 : -1), until: Date.now() + 1000 });
    return send(`OK,TURN,${m[1] === 'PIVOT' ? 'P_' : 'N_'}${m[2][0]}${m[3]}`);
  }
  if (['ENV', 'GPS', 'IR', 'RTC'].includes(c)) return read(c);
  if (c === 'GPS STATUS') return send('GPS,STATUS,FIX=1,SAT=8,LAST_BYTE_MS=120');
  if ((m = c.match(/^POLL (ENV|GPS|IR|RTC) (\d+)$/))) {
    rover.polls[m[1]] = +m[2]; rover.pollAt[m[1]] = 0;
    return send(+m[2] ? `OK,POLL,${m[1]}=${m[2]}s` : `OK,POLL,${m[1]}=OFF`);
  }
  if (c === 'POLL SHOW') { Object.entries(rover.polls).forEach(([k, v]) => send(`POLL,${k}=${v}s`)); return; }
  if (c === 'MANUAL SHOW') { send('DRIVE_PROFILE,MANUAL_FWD,PWM=60/60/60/60'); return send('DRIVE_PROFILE,MANUAL_REV,PWM=-60/-60/-60/-60'); }
  if (c === 'BEEP') return send('OK,BEEP_PATTERN');
  if ((m = c.match(/^AUTO TARGET (-?[\d.]+) (-?[\d.]+)$/))) {
    rover.target = { lat: +m[1], lon: +m[2] };
    if (rover.autoState !== 'OFF') { rover.batch = null; stopMotion(); rover.autoState = 'WAIT_ROUTE'; rover.requestAt = Date.now(); }
    return send('OK,TARGET_SET');
  }
  if (c === 'AUTO ON') { stopMotion(); rover.batch = null; rover.autoState = 'WAIT_ROUTE'; rover.requestAt = Date.now() + 300; return send('OK,AUTO_ON'); }
  if (c === 'AUTO OFF') { stopMotion(); rover.batch = null; rover.autoState = 'OFF'; return send('OK,AUTO_OFF'); }
  if (c === 'AUTO RESET') { if (['BLOCKED', 'ARRIVED'].includes(rover.autoState)) { rover.autoState = 'WAIT_ROUTE'; rover.requestAt = Date.now(); } return send('OK,AUTO_RESET'); }
  if (c === 'AUTO STATUS') return send(`AUTO,STATE,${rover.autoState === 'WAIT_ROUTE' ? 'WAIT_ROUTE' : rover.autoState}`);
  if (c.startsWith('ROUTE BATCH ')) {
    const parts = raw.trim().toUpperCase().split('|');
    const h = parts[0].match(/^ROUTE BATCH (\d+) (FINAL|MORE) (\d+)$/);
    if (rover.autoState !== 'WAIT_ROUTE' || !rover.outstanding) return send('ERROR,BATCH_NOT_WAITING_FOR_ROUTE');
    if (!h) return send('ERROR,BATCH_HEADER');
    if (+h[1] !== rover.requestId) return send(`ERROR,BATCH_STALE_ID,EXPECTED=${rover.requestId}`);
    if (+h[3] !== parts.length - 1) return send('ERROR,BATCH_COUNT_MISMATCH');
    rover.outstanding = false;
    rover.batch = { id: +h[1], final: h[2] === 'FINAL', steps: parts.slice(1), index: 0 };
    send(`OK,BATCH_ACCEPTED,ID=${h[1]},COUNT=${h[3]}`);
    return runBatchStep();
  }
  if (c === 'LINE FOLLOW ON') {
    rover.line = true; send('OK,LINE_FOLLOW,ON'); send('LINE_FOLLOW,STATE=STRAIGHT,RAW=101');
    setTimeout(() => { if (rover.line) { rover.line = false; send('LINE_FOLLOW,STATE=LOST,RAW=111'); } }, 8000);
    return;
  }
  if (c === 'LINE FOLLOW OFF') { rover.line = false; return send('OK,LINE_FOLLOW,OFF'); }
  if (c === 'LINE FOLLOW STATUS') return send(`LINE_FOLLOW,MODE=${rover.line ? 'ON' : 'OFF'},STATE=${rover.line ? 'STRAIGHT' : 'STOPPED'},RAW=1/0/1`);
  if (c.startsWith('RADAR TEST')) {
    send('OK,RADAR_TEST,ONE_SWEEP');
    const id = Math.floor(Math.random() * 1000);
    for (let part = 0; part < 3; part++) {
      let s = `RADAR,SCAN,SCAN_ID=${id},PART=${part + 1}/3,MAX_CM=200`;
      for (let i = part * 7; i < 19 && i < (part + 1) * 7; i++) s += `,${i * 10}:${Math.random() < .3 ? -1 : Math.round(20 + Math.random() * 150)}`;
      send(s);
    }
    return send('EVENT,RADAR_TEST_DONE');
  }
  if (c.startsWith('RTC SET')) return send('OK,RTC_ACTUALIZADO');
  if (c.startsWith('MICROSD')) return send(c === 'MICROSD STATUS' ? 'MICROSD,READY=1,LOGGING=0' : `OK,MICROSD,LOGGING=${c.endsWith('1') || c.endsWith('ON') ? 'ON,FILE=/rover.csv' : 'OFF'}`);
  if (c === 'HELP') return send('HELP');
  return send('ERROR,UNKNOWN_COMMAND');
}

client.on('connect', () => {
  console.log(`[sim] Conectado. Escuchando ${CMD} y publicando en ${TX}`);
  client.subscribe(CMD);
});
client.on('message', (topic, payload) => setTimeout(() => handle(payload.toString()), LATENCY_MS));
client.on('error', e => console.error('[sim]', e.message));
