const express = require('express');
const multer = require('multer');
const mongoose = require('mongoose');
const Upload = require('../models/Upload');
const Record = require('../models/Record');
const config = require('../config');
const { requireAdmin } = require('../auth');
const { parseMicroSdCsv } = require('../../public/js/roverlib');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 1 } });

// Sensores que escribe logSensorRecord() en /rover.csv
function classify(sensor) {
  if (sensor === 'LINE_FOLLOW') return { sensor, category: 'evento' };
  if (sensor.startsWith('RADAR_')) return { sensor: 'RADAR', category: 'telemetria' };
  if (sensor === 'HCSR04' || sensor.startsWith('AUTO_')) return { sensor: 'DIST', category: 'telemetria' };
  return { sensor, category: ['ENV', 'GPS', 'IR', 'RTC'].includes(sensor) ? 'telemetria' : 'estado' };
}

// POST /api/uploads  (multipart, campo "file") -> importa /rover.csv a MongoDB
router.post('/', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Adjunta el archivo rover.csv' });
  const text = req.file.buffer.toString('utf8');
  const parsed = parseMicroSdCsv(text);
  if (!parsed.rows.length) return res.status(400).json({ error: 'El archivo no contiene filas millis,sensor,valor válidas' });

  const doc = await Upload.create({
    filename: req.file.originalname.slice(0, 120), size: req.file.size, rows: parsed.rows.length,
    gpsPoints: parsed.rows.filter(r => r.location).length, segments: parsed.segments,
    hasAbsoluteTime: parsed.hasAbsoluteTime, lineErrors: parsed.errors.slice(0, 100), uploadedBy: req.user.name
  });

  const records = parsed.rows.map(r => {
    const { sensor, category } = classify(r.sensor);
    const data = { ...r.data, originalSensor: r.sensor };
    if (r.sensor === 'ENV') { data.T = r.data.T_C; data.H = r.data.H_PCT; data.P = r.data.P_HPA; } // mismo formato que LoRa
    const rec = {
      deviceId: config.deviceId, source: 'microsd', category, sensor,
      raw: `${r.sensor},${r.value}`, data, ts: r.time ? new Date(r.time) : null,
      millis: r.millis, segment: r.segment, uploadId: doc._id, createdBy: req.user.name
    };
    if (r.location) rec.location = { type: 'Point', coordinates: [r.location.lon, r.location.lat] };
    return rec;
  });
  for (let i = 0; i < records.length; i += 1000) await Record.insertMany(records.slice(i, i + 1000), { ordered: false });
  res.status(201).json(doc);
});

router.get('/', async (req, res) => {
  res.json(await Upload.find().sort({ createdAt: -1 }).limit(100).lean());
});

// DELETE /api/uploads/:id (Administrador) -> elimina el archivo y sus registros
router.delete('/:id', requireAdmin, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'ID no válido' });
  const doc = await Upload.findByIdAndDelete(req.params.id);
  if (!doc) return res.status(404).json({ error: 'No encontrado' });
  const { deletedCount } = await Record.deleteMany({ uploadId: doc._id });
  res.json({ ok: true, deletedRecords: deletedCount });
});

module.exports = router;
