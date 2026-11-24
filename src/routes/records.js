const express = require('express');
const mongoose = require('mongoose');
const Record = require('../models/Record');
const { requireAdmin } = require('../auth');
const { categoryOf } = require('../../public/js/roverlib');

const router = express.Router();
const EARTH_RADIUS_M = 6378100;
const escapeRx = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/*
 * Filtros (query string) comunes a listado, exportación y gráficas:
 *  sensor=ENV,GPS  category=telemetria  source=lora|microsd|web|manual
 *  from=ISO  to=ISO  q=texto  uploadId=id  hasLocation=1
 *  near=lat,lon  radius=metros   (consulta geográfica con índice 2dsphere)
 */
function buildFilter(q) {
  const f = {};
  if (q.sensor) f.sensor = { $in: String(q.sensor).toUpperCase().split(',').map(s => s.trim()).filter(Boolean) };
  if (q.category) f.category = { $in: String(q.category).split(',') };
  if (q.source) f.source = { $in: String(q.source).split(',') };
  if (q.uploadId && mongoose.isValidObjectId(q.uploadId)) f.uploadId = q.uploadId;
  if (q.from || q.to) {
    f.ts = {};
    if (q.from && !isNaN(Date.parse(q.from))) f.ts.$gte = new Date(q.from);
    if (q.to && !isNaN(Date.parse(q.to))) f.ts.$lte = new Date(q.to);
  }
  if (q.q) f.raw = { $regex: escapeRx(String(q.q).slice(0, 80)), $options: 'i' };
  if (q.hasLocation === '1') f.location = { $exists: true };
  if (q.near) {
    const [lat, lon] = String(q.near).split(',').map(Number);
    const radius = Math.min(Math.max(Number(q.radius) || 100, 1), 1e6);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      f.location = { $geoWithin: { $centerSphere: [[lon, lat], radius / EARTH_RADIUS_M] } };
    }
  }
  return f;
}

const SORT = { ts: -1, _id: -1 };

// GET /api/records  -> listado paginado
router.get('/', async (req, res) => {
  const filter = buildFilter(req.query);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 500);
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const [items, total] = await Promise.all([
    Record.find(filter).sort(SORT).skip((page - 1) * limit).limit(limit).lean(),
    Record.countDocuments(filter)
  ]);
  res.json({ items, total, page, pages: Math.max(1, Math.ceil(total / limit)), limit });
});

// GET /api/records/stats -> resumen para Inicio
router.get('/stats', async (req, res) => {
  const [total, byCategory, lastEnv, lastGps, lastAny] = await Promise.all([
    Record.estimatedDocumentCount(),
    Record.aggregate([{ $group: { _id: '$category', n: { $sum: 1 } } }]),
    Record.findOne({ sensor: 'ENV' }).sort(SORT).lean(),
    Record.findOne({ location: { $exists: true } }).sort(SORT).lean(),
    Record.findOne({ source: 'lora' }).sort(SORT).lean()
  ]);
  res.json({ total, byCategory, lastEnv, lastGps, lastRoverMessageAt: lastAny ? lastAny.ts : null });
});

// GET /api/records/series?sensor=ENV -> serie temporal ascendente (gráficas)
router.get('/series', async (req, res) => {
  const filter = buildFilter({ sensor: 'ENV', ...req.query });
  filter.ts = { ...(filter.ts || {}), $ne: null };
  const limit = Math.min(parseInt(req.query.limit, 10) || 2000, 10000);
  const items = await Record.find(filter, { ts: 1, data: 1, source: 1 }).sort({ ts: -1 }).limit(limit).lean();
  res.json(items.reverse());
});

// GET /api/records/trail -> puntos GPS ascendentes (rastro en el mapa)
router.get('/trail', async (req, res) => {
  const filter = buildFilter(req.query);
  filter.location = filter.location || { $exists: true };
  const limit = Math.min(parseInt(req.query.limit, 10) || 5000, 20000);
  const items = await Record.find(filter, { ts: 1, location: 1, source: 1, sensor: 1, millis: 1 })
    .sort({ ts: -1, millis: -1 }).limit(limit).lean();
  res.json(items.reverse().map(r => ({
    id: r._id, ts: r.ts, sensor: r.sensor, source: r.source, millis: r.millis,
    lat: r.location.coordinates[1], lon: r.location.coordinates[0]
  })));
});

// GET /api/records/export?format=csv|json|kml
router.get('/export', async (req, res) => {
  const format = String(req.query.format || 'json').toLowerCase();
  const filter = buildFilter(req.query);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  if (format === 'kml') filter.location = filter.location || { $exists: true };
  const items = await Record.find(filter).sort(format === 'kml' ? { ts: 1, millis: 1 } : SORT).limit(50000).lean();

  if (format === 'csv') {
    const cell = v => {
      const s = v === null || v === undefined ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = ['id', 'ts', 'deviceId', 'source', 'category', 'sensor', 'lat', 'lon', 'millis', 'raw', 'data', 'notes'];
    const lines = items.map(r => [
      r._id, r.ts ? new Date(r.ts).toISOString() : '', r.deviceId, r.source, r.category, r.sensor,
      r.location ? r.location.coordinates[1] : '', r.location ? r.location.coordinates[0] : '',
      r.millis, r.raw, r.data, r.notes
    ].map(cell).join(','));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="registros-${stamp}.csv"`);
    return res.send('﻿' + [header.join(','), ...lines].join('\n'));
  }

  if (format === 'kml') {
    // Para comparar las posiciones del rover con Google Earth Pro (requisito del póster)
    const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const coords = items.map(r => `${r.location.coordinates[0]},${r.location.coordinates[1]},0`).join(' ');
    const marks = items.map((r, i) => `<Placemark><name>${i + 1}</name><description>${esc(r.ts ? new Date(r.ts).toISOString() : `millis ${r.millis}`)} | ${esc(r.raw)}</description><Point><coordinates>${r.location.coordinates[0]},${r.location.coordinates[1]},0</coordinates></Point></Placemark>`).join('\n');
    const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Recorrido rover ${stamp}</name>
<Style id="ruta"><LineStyle><color>ff00a5ff</color><width>3</width></LineStyle></Style>
<Placemark><name>Trayectoria</name><styleUrl>#ruta</styleUrl><LineString><tessellate>1</tessellate><coordinates>${coords}</coordinates></LineString></Placemark>
<Folder><name>Puntos GPS</name>${marks}</Folder></Document></kml>`;
    res.setHeader('Content-Type', 'application/vnd.google-earth.kml+xml');
    res.setHeader('Content-Disposition', `attachment; filename="recorrido-${stamp}.kml"`);
    return res.send(kml);
  }

  res.setHeader('Content-Disposition', `attachment; filename="registros-${stamp}.json"`);
  res.json(items);
});

router.get('/:id', async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'ID no válido' });
  const r = await Record.findById(req.params.id).lean();
  if (!r) return res.status(404).json({ error: 'No encontrado' });
  res.json(r);
});

// Validación de cuerpo para crear/editar
function sanitizeBody(body, partial) {
  const out = {};
  const errors = [];
  if (body.sensor !== undefined || !partial) {
    if (!body.sensor || !/^[A-Z0-9_]{1,24}$/i.test(body.sensor)) errors.push('sensor: 1-24 caracteres A-Z, 0-9, _');
    else out.sensor = String(body.sensor).toUpperCase();
  }
  if (body.category !== undefined) {
    if (!['telemetria', 'evento', 'respuesta', 'estado', 'comando'].includes(body.category)) errors.push('category no válida');
    else out.category = body.category;
  } else if (!partial && out.sensor) out.category = categoryOf(out.sensor);
  if (body.raw !== undefined) out.raw = String(body.raw).slice(0, 500);
  if (body.notes !== undefined) out.notes = String(body.notes).slice(0, 500);
  if (body.data !== undefined) {
    if (typeof body.data !== 'object' || body.data === null || Array.isArray(body.data)) errors.push('data debe ser un objeto JSON');
    else out.data = body.data;
  }
  if (body.ts !== undefined) {
    if (body.ts === null || body.ts === '') out.ts = null;
    else if (isNaN(Date.parse(body.ts))) errors.push('ts no es una fecha válida');
    else out.ts = new Date(body.ts);
  } else if (!partial) out.ts = new Date();
  if (body.lat !== undefined || body.lon !== undefined) {
    if (body.lat === '' || body.lat === null) out.location = undefined;
    else {
      const lat = Number(body.lat), lon = Number(body.lon);
      if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) errors.push('lat/lon fuera de rango');
      else out.location = { type: 'Point', coordinates: [lon, lat] };
    }
  }
  return { out, errors };
}

// POST /api/records (Administrador): registro manual
router.post('/', requireAdmin, async (req, res) => {
  const { out, errors } = sanitizeBody(req.body || {}, false);
  if (errors.length) return res.status(400).json({ error: errors.join('; ') });
  const doc = await Record.create({ ...out, source: 'manual', createdBy: req.user.name });
  res.status(201).json(doc);
});

// PATCH /api/records/:id (Administrador)
router.patch('/:id', requireAdmin, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'ID no válido' });
  const { out, errors } = sanitizeBody(req.body || {}, true);
  if (errors.length) return res.status(400).json({ error: errors.join('; ') });
  const update = { $set: { ...out } };
  if ('location' in out && out.location === undefined) { delete update.$set.location; update.$unset = { location: 1 }; }
  const doc = await Record.findByIdAndUpdate(req.params.id, update, { new: true, runValidators: true });
  if (!doc) return res.status(404).json({ error: 'No encontrado' });
  res.json(doc);
});

// DELETE /api/records/:id (Administrador)
router.delete('/:id', requireAdmin, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'ID no válido' });
  const doc = await Record.findByIdAndDelete(req.params.id);
  if (!doc) return res.status(404).json({ error: 'No encontrado' });
  res.json({ ok: true });
});

module.exports = router;
