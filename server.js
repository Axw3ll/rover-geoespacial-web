const path = require('path');
const express = require('express');
const mongoose = require('mongoose');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const config = require('./src/config');
const bridge = require('./src/bridge');
const User = require('./src/models/User');
const { pageGuard, requireAuth } = require('./src/auth');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

// Envuelve rutas async para que los errores lleguen al manejador final
const wrapAsync = router => {
  router.stack.forEach(layer => {
    if (!layer.route) return;
    layer.route.stack.forEach(s => {
      const fn = s.handle;
      if (fn.length <= 3) s.handle = (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
    });
  });
  return router;
};

// La API necesita MongoDB (salvo /api/status y /api/commands, que funcionan en vivo)
const needDb = (req, res, next) => mongoose.connection.readyState === 1 ? next()
  : res.status(503).json({ error: 'Base de datos no disponible' });

app.use('/api/auth', needDb, wrapAsync(require('./src/routes/auth')));
app.use('/api/records', requireAuth, needDb, wrapAsync(require('./src/routes/records')));
app.use('/api/uploads', requireAuth, needDb, wrapAsync(require('./src/routes/uploads')));
app.use('/api', requireAuth, wrapAsync(require('./src/routes/system')));
app.use('/api', (req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));

// Sitio: todas las páginas, excepto login, requieren sesión
app.use(pageGuard);
// Cliente MQTT para el navegador servido desde node_modules (MQTT sobre WebSockets)
app.use('/vendor/mqtt', express.static(path.join(__dirname, 'node_modules', 'mqtt', 'dist')));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.use((err, req, res, next) => {
  console.error('[api]', err);
  if (res.headersSent) return next(err);
  const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : (err.status || 500);
  res.status(status).json({ error: status === 500 ? 'Error interno del servidor' : err.message });
});

async function ensureAdmin() {
  if (!config.adminPassword) return console.warn('[auth] ADMIN_PASSWORD vacío: no se creó cuenta administradora.');
  const exists = await User.findOne({ email: config.adminEmail });
  if (exists) return;
  await User.create({
    name: 'Administrador', email: config.adminEmail, role: 'admin',
    passwordHash: await bcrypt.hash(config.adminPassword, 10)
  });
  console.log(`[auth] Cuenta administradora creada: ${config.adminEmail}`);
}

async function main() {
  mongoose.set('strictQuery', true);
  mongoose.connection.on('connected', () => { console.log('[db] MongoDB conectado'); ensureAdmin().catch(e => console.error(e)); });
  mongoose.connection.on('disconnected', () => console.warn('[db] MongoDB desconectado'));
  mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 10000 })
    .catch(e => console.error('[db] No se pudo conectar a MongoDB:', e.message));

  bridge.start(); // middleware MQTT -> MongoDB, independiente de que haya visitantes
  app.listen(config.port, () => console.log(`[web] http://localhost:${config.port}`));
}

main();
