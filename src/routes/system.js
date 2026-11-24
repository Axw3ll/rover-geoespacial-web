const express = require('express');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const config = require('../config');
const User = require('../models/User');
const bridge = require('../bridge');
const { requireAdmin, signCommandToken } = require('../auth');

const router = express.Router();

// GET /api/config -> datos para conectar el navegador al broker por WebSockets
router.get('/config', (req, res) => {
  res.json({
    deviceId: config.deviceId,
    user: { name: req.user.name, role: req.user.role },
    mqtt: {
      url: config.mqtt.wsUrl,
      username: config.mqtt.wsUsername,
      password: config.mqtt.wsPassword,
      topics: config.topics
    },
    commandToken: signCommandToken(req.user),
    planner: config.planner
  });
});

// GET /api/status -> estado del backend, MQTT, MongoDB y planificador
router.get('/status', (req, res) => {
  res.json({ mongo: mongoose.connection.readyState === 1, ...bridge.getState() });
});

// POST /api/commands { command } -> alternativa REST (Postman) al envío por MQTT-WebSockets
router.post('/commands', (req, res) => {
  const result = bridge.dispatchCommand((req.body || {}).command, req.user, 'rest');
  res.status(result.ok ? 202 : 400).json(result);
});

// ---------- Gestión de usuarios (Administrador) ----------
router.get('/users', requireAdmin, async (req, res) => {
  const users = await User.find().sort({ createdAt: 1 });
  res.json(users.map(u => u.toPublic()));
});

router.patch('/users/:id', requireAdmin, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'ID no válido' });
  const { role, password, name } = req.body || {};
  const user = await User.findById(req.params.id);
  if (!user) return res.status(404).json({ error: 'No encontrado' });
  if (role !== undefined) {
    if (!['admin', 'usuario'].includes(role)) return res.status(400).json({ error: 'Rol no válido' });
    if (String(user._id) === req.user.sub && role !== 'admin') return res.status(400).json({ error: 'No puedes quitarte tu propio rol de Administrador' });
    user.role = role;
  }
  if (name !== undefined && String(name).trim()) user.name = String(name).trim().slice(0, 80);
  if (password !== undefined) {
    if (String(password).length < 8) return res.status(400).json({ error: 'Contraseña mínima de 8 caracteres' });
    user.passwordHash = await bcrypt.hash(String(password), 10);
  }
  await user.save();
  res.json(user.toPublic());
});

router.delete('/users/:id', requireAdmin, async (req, res) => {
  if (req.params.id === req.user.sub) return res.status(400).json({ error: 'No puedes eliminar tu propia cuenta' });
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'ID no válido' });
  const doc = await User.findByIdAndDelete(req.params.id);
  if (!doc) return res.status(404).json({ error: 'No encontrado' });
  res.json({ ok: true });
});

module.exports = router;
