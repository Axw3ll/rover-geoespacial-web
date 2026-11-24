const mongoose = require('mongoose');

// Punto GeoJSON: coordinates = [longitud, latitud]
const pointSchema = new mongoose.Schema({
  type: { type: String, enum: ['Point'], default: 'Point' },
  coordinates: { type: [Number], required: true }
}, { _id: false });

/*
 * Registro del datalogger. Cada mensaje del rover, cada fila importada de la
 * microSD y cada comando enviado se guarda como un documento.
 *   category: telemetria | evento | respuesta | estado | comando
 *   source:   lora (en vivo) | microsd (archivo importado) | web (comandos) | manual (CRUD)
 */
const recordSchema = new mongoose.Schema({
  deviceId: { type: String, default: 'CAR01', index: true },
  source: { type: String, enum: ['lora', 'microsd', 'web', 'manual'], required: true },
  category: { type: String, enum: ['telemetria', 'evento', 'respuesta', 'estado', 'comando'], required: true },
  sensor: { type: String, required: true, uppercase: true, trim: true },
  raw: { type: String, default: '' },
  data: { type: mongoose.Schema.Types.Mixed, default: {} },
  location: { type: pointSchema, default: undefined },
  ts: { type: Date, default: null },        // fecha/hora absoluta (recepción o RTC)
  millis: { type: Number, default: null },  // millis() del ESP32 (solo microSD)
  segment: { type: Number, default: null }, // arranque del ESP32 dentro del archivo
  uploadId: { type: mongoose.Schema.Types.ObjectId, ref: 'Upload', default: null, index: true },
  notes: { type: String, default: '', maxlength: 500 },
  createdBy: { type: String, default: '' }
}, { timestamps: true, minimize: false });

recordSchema.index({ ts: -1 });
recordSchema.index({ sensor: 1, ts: -1 });
recordSchema.index({ category: 1, ts: -1 });
recordSchema.index({ location: '2dsphere' });

module.exports = mongoose.model('Record', recordSchema);
