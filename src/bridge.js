/*
 * Middleware MQTT -> MongoDB (corre siempre, aunque nadie tenga abierto el sitio).
 *  - Guarda cada mensaje del rover que el gateway publica en <base>/tx.
 *  - Recibe comandos del navegador por MQTT sobre WebSockets (<base>/web/cmd),
 *    valida el token y el rol, los registra y los reenvía al gateway (<base>/cmd).
 *  - Ejecuta el planificador de rutas del modo automático.
 */
const mqtt = require('mqtt');
const mongoose = require('mongoose');
const config = require('./config');
const Record = require('./models/Record');
const RoutePlanner = require('./planner');
const { parseRoverMessage } = require('../public/js/roverlib');
const { checkCommand } = require('./policy');
const { verify } = require('./auth');

let client = null;
let planner = null;
const state = { connected: false, lastRoverAt: null, lastGatewayStatus: null };

function toRecord(parsed, extra) {
  const doc = {
    deviceId: config.deviceId,
    source: 'lora',
    category: parsed.category,
    sensor: parsed.sensor || 'DESCONOCIDO',
    raw: parsed.raw,
    data: parsed.data,
    ts: new Date(),
    ...extra
  };
  if (parsed.location) doc.location = { type: 'Point', coordinates: [parsed.location.lon, parsed.location.lat] };
  return doc;
}

async function save(doc) {
  if (mongoose.connection.readyState !== 1) return; // sin BD: el sistema sigue funcionando en vivo
  try { await Record.create(doc); } catch (e) { console.error('[bridge] Error al guardar:', e.message); }
}

function publish(topic, payload, opts) {
  if (!client) return;
  client.publish(topic, typeof payload === 'string' ? payload : JSON.stringify(payload), opts || { qos: 1 });
}

/** Envía un comando al gateway después de validar permisos. */
function dispatchCommand(command, user, origin) {
  const role = user ? user.role : 'planner';
  const check = checkCommand(command, role);
  if (!check.ok) return check;
  if (!client || !state.connected) return { ok: false, error: 'Backend sin conexión al broker MQTT' };
  publish(config.topics.cmd, check.command);
  save({
    deviceId: config.deviceId, source: 'web', category: 'comando', sensor: 'CMD',
    raw: check.command, data: { user: user ? user.name : 'planificador', role, origin }, ts: new Date(),
    createdBy: user ? user.name : 'planificador'
  });
  return { ok: true, command: check.command };
}

// Acepta texto plano (una o varias líneas) o JSON {msg|raw|text, rssi, snr}
function splitPayload(buffer) {
  const text = buffer.toString('utf8').trim();
  if (text.startsWith('{')) {
    try {
      const j = JSON.parse(text);
      const msg = j.msg || j.raw || j.text || j.message || '';
      return String(msg).split(/\r?\n/).map(line => ({ line, radio: { rssi: j.rssi, snr: j.snr } }));
    } catch { /* se trata como texto */ }
  }
  return text.split(/\r?\n/).map(line => ({ line, radio: null }));
}

function onRoverPayload(buffer) {
  state.lastRoverAt = new Date();
  for (const { line, radio } of splitPayload(buffer)) {
    if (!line.trim()) continue;
    const parsed = parseRoverMessage(line);
    if (radio && (radio.rssi !== undefined || radio.snr !== undefined)) {
      parsed.data.rssi = radio.rssi; parsed.data.snr = radio.snr;
    }
    save(toRecord(parsed));
    if (planner) planner.onMessage(parsed);
  }
}

function onWebCommand(buffer) {
  let msg;
  try { msg = JSON.parse(buffer.toString('utf8')); } catch { return; }
  const id = msg && msg.id;
  const user = verify(msg && msg.token, 'cmd');
  if (!user) return publish(config.topics.webAck, { id, ok: false, error: 'Sesión inválida o vencida: recarga la página' }, { qos: 0 });
  const result = dispatchCommand(msg.command, user, 'mqtt-ws');
  publish(config.topics.webAck, { id, ok: result.ok, command: result.command, error: result.error }, { qos: 0 });
}

function start() {
  client = mqtt.connect(config.mqtt.url, {
    username: config.mqtt.username,
    password: config.mqtt.password,
    clientId: `rover-backend-${config.deviceId}-${Math.random().toString(16).slice(2, 8)}`,
    reconnectPeriod: 3000,
    clean: true
  });

  planner = new RoutePlanner(config.planner,
    command => dispatchCommand(command, null, 'planificador'),
    status => publish(config.topics.planner, status, { qos: 0, retain: true }));

  client.on('connect', () => {
    state.connected = true;
    console.log(`[bridge] MQTT conectado: ${config.mqtt.url}`);
    client.subscribe([config.topics.tx, config.topics.webCmd, config.topics.status], { qos: 1 });
  });
  client.on('reconnect', () => console.log('[bridge] Reintentando MQTT...'));
  client.on('close', () => { state.connected = false; });
  client.on('error', e => console.error('[bridge] MQTT:', e.message));
  client.on('message', (topic, payload) => {
    if (topic === config.topics.tx) onRoverPayload(payload);
    else if (topic === config.topics.webCmd) onWebCommand(payload);
    else if (topic === config.topics.status) {
      try { state.lastGatewayStatus = JSON.parse(payload.toString()); } catch { state.lastGatewayStatus = payload.toString(); }
    }
  });
  return client;
}

function getState() {
  return { ...state, planner: planner ? planner.status : null, topics: config.topics };
}

module.exports = { start, dispatchCommand, getState };
