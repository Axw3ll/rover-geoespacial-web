const mongoose = require('mongoose');

// Archivo /rover.csv de la microSD importado desde la sección Base de datos.
const uploadSchema = new mongoose.Schema({
  filename: { type: String, required: true },
  size: Number,
  rows: Number,
  gpsPoints: Number,
  segments: Number,
  hasAbsoluteTime: Boolean,
  lineErrors: [Number],
  uploadedBy: String
}, { timestamps: true });

module.exports = mongoose.model('Upload', uploadSchema);
