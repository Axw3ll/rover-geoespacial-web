// Ejecuta solo el middleware MQTT -> MongoDB (sin sitio web): npm run bridge
const mongoose = require('mongoose');
const config = require('./config');
const bridge = require('./bridge');

mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 10000 })
  .then(() => console.log('[db] MongoDB conectado'))
  .catch(e => console.error('[db] No se pudo conectar a MongoDB:', e.message));
bridge.start();
