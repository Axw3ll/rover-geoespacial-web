/*
 * roverlib.js — Biblioteca compartida (navegador y Node.js)
 * Interpreta los mensajes de texto que emite el firmware Carrito_ESP32
 * (por LoRa -> gateway -> MQTT) y el archivo /rover.csv de la microSD.
 * También incluye utilidades geográficas (distancia y rumbo).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RoverLib = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- Conversión de valores ----------
  function toValue(raw) {
    if (raw === undefined || raw === null) return null;
    const text = String(raw).trim();
    if (text === '') return '';
    if (/^(nan|-?inf|ovf)/i.test(text)) return null;
    // Números con unidad pegada (ej. "1013.2hPa", "5s", "700ms")
    const m = text.match(/^(-?\d+(?:\.\d+)?)([a-zA-Z%]*)$/);
    if (m && (m[2] === '' || /^(hPa|kPa|s|ms|cm|m|C|%)$/.test(m[2]))) return Number(m[1]);
    return text;
  }

  // Categorías para la base de datos (apartados separados del datalogger)
  const TELEMETRY = ['ENV', 'GPS', 'IR', 'RTC', 'RADAR'];
  const EVENTS = ['EVENT', 'REQUEST', 'ROUTE_CONFIG', 'LINE_FOLLOW', 'AUTO', 'TARGET'];
  const REPLIES = ['OK', 'ERROR'];
  function categoryOf(sensor) {
    if (TELEMETRY.includes(sensor)) return 'telemetria';
    if (EVENTS.includes(sensor)) return 'evento';
    if (REPLIES.includes(sensor)) return 'respuesta';
    return 'estado';
  }

  /**
   * Convierte una línea del firmware en un objeto estructurado.
   * Ejemplos: "ENV,T=24.1,H=55.0,P=1012.8hPa"  "GPS,LAT=19.24,LON=-103.72,AGE_MS=120"
   *           "RADAR,SCAN,SCAN_ID=3,PART=1/3,MAX_CM=200,0:45,10:-1"  "RTC,2026-10-29 11:00:00"
   */
  function parseRoverMessage(text) {
    const raw = String(text || '').trim();
    const tokens = raw.split(',');
    const sensor = (tokens.shift() || '').trim().toUpperCase();
    const data = {};
    const tags = [];
    const points = [];
    for (const token of tokens) {
      const t = token.trim();
      if (!t) continue;
      const eq = t.indexOf('=');
      if (eq > 0) { data[t.slice(0, eq)] = toValue(t.slice(eq + 1)); continue; }
      const pair = t.match(/^(\d{1,3}):(-?\d+)$/); // RADAR,SCAN -> ángulo:distancia
      if (pair) { points.push({ angle: Number(pair[1]), dist: Number(pair[2]) }); continue; }
      tags.push(t);
    }
    if (points.length) data.points = points;
    if (tags.length) data.tags = tags;

    // Casos particulares
    if (sensor === 'RTC' && tags[0] && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(tags[0])) {
      data.stamp = tags[0];
    }
    if (sensor === 'EVENT' && tags[0]) data.event = tags[0];
    if (sensor === 'GPS' && tags.includes('NO_FIX')) data.fix = false;

    let location = null;
    const lat = typeof data.LAT === 'number' ? data.LAT : null;
    const lon = typeof data.LON === 'number' ? data.LON : null;
    if (lat !== null && lon !== null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0)) {
      location = { lat, lon };
      if (sensor === 'GPS') data.fix = true;
    }
    return { raw, sensor, category: categoryOf(sensor), data, location };
  }

  // ---------- microSD: /rover.csv (millis,sensor,"valor") ----------
  function parseKv(value) {
    const out = {};
    String(value).split(';').forEach(part => {
      const eq = part.indexOf('=');
      if (eq > 0) out[part.slice(0, eq).trim()] = toValue(part.slice(eq + 1));
    });
    return out;
  }

  function parseRtcStamp(stamp) {
    const m = String(stamp).match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
    if (!m) return null;
    // Hora de pared del DS3231 interpretada en la zona horaria local de quien procesa.
    const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    return isNaN(d.getTime()) ? null : d.getTime();
  }

  /**
   * Interpreta el CSV generado por logSensorRecord().
   * - Un reinicio del ESP32 reinicia millis(): se detecta y se abre un "segmento" nuevo.
   * - Si el segmento contiene lecturas RTC, se calcula fecha/hora absoluta de cada fila.
   */
  function parseMicroSdCsv(text) {
    const rows = [];
    const errors = [];
    let segment = 0;
    let lastMillis = -1;
    String(text).split(/\r?\n/).forEach((line, i) => {
      const l = line.trim();
      if (!l || /^millis\s*,/i.test(l)) return;
      const c1 = l.indexOf(',');
      const c2 = c1 < 0 ? -1 : l.indexOf(',', c1 + 1);
      if (c1 < 0 || c2 < 0) { errors.push(i + 1); return; }
      const millis = Number(l.slice(0, c1));
      if (!Number.isFinite(millis)) { errors.push(i + 1); return; }
      const sensor = l.slice(c1 + 1, c2).trim();
      let value = l.slice(c2 + 1).trim();
      if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
      if (millis < lastMillis) segment++;
      lastMillis = millis;

      const row = { line: i + 1, millis, sensor, value, segment, data: {}, location: null, time: null };
      if (sensor === 'RTC') row.data.stamp = value;
      else if (value.includes('=')) row.data = parseKv(value);
      else row.data.status = value;

      if (sensor === 'GPS' && typeof row.data.LAT === 'number' && typeof row.data.LON === 'number' &&
          !(row.data.LAT === 0 && row.data.LON === 0)) {
        row.location = { lat: row.data.LAT, lon: row.data.LON };
      }
      if (sensor.startsWith('RADAR_')) row.data.angle = Number(sensor.slice(6));
      rows.push(row);
    });

    // Anclaje temporal por segmento usando las lecturas RTC
    const anchors = {};
    rows.forEach(r => {
      if (r.sensor !== 'RTC') return;
      const t = parseRtcStamp(r.data.stamp);
      if (t === null) return;
      (anchors[r.segment] = anchors[r.segment] || []).push({ millis: r.millis, time: t });
    });
    rows.forEach(r => {
      const list = anchors[r.segment];
      if (!list) return;
      let anchor = list[0];
      for (const a of list) if (a.millis <= r.millis) anchor = a;
      r.time = anchor.time + (r.millis - anchor.millis);
    });

    return { rows, segments: segment + 1, errors, hasAbsoluteTime: rows.some(r => r.time !== null) };
  }

  // ---------- Geografía ----------
  const R = 6371008.8; // radio medio terrestre (m)
  const rad = d => d * Math.PI / 180;
  const deg = r => r * 180 / Math.PI;

  function distanceM(lat1, lon1, lat2, lon2) {
    const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  // Rumbo inicial 0..360 (0 = norte, 90 = este)
  function bearingDeg(lat1, lon1, lat2, lon2) {
    const y = Math.sin(rad(lon2 - lon1)) * Math.cos(rad(lat2));
    const x = Math.cos(rad(lat1)) * Math.sin(rad(lat2)) -
              Math.sin(rad(lat1)) * Math.cos(rad(lat2)) * Math.cos(rad(lon2 - lon1));
    return (deg(Math.atan2(y, x)) + 360) % 360;
  }

  function normalize180(a) {
    let x = ((a + 180) % 360 + 360) % 360 - 180;
    return x === -180 ? 180 : x;
  }

  // Distancia acumulada de una lista de puntos {lat, lon}
  function pathLengthM(points) {
    let total = 0;
    for (let i = 1; i < points.length; i++) {
      total += distanceM(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon);
    }
    return total;
  }

  return { parseRoverMessage, parseMicroSdCsv, parseKv, parseRtcStamp, categoryOf,
           distanceM, bearingDeg, normalize180, pathLengthM };
});
