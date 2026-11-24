const express = require('express');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const { signSession, setSessionCookie, requireAuth, COOKIE } = require('../auth');

const router = express.Router();
const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Limitador simple de intentos de inicio de sesión por IP (memoria)
const attempts = new Map();
function tooManyAttempts(ip) {
  const now = Date.now();
  const entry = attempts.get(ip) || { count: 0, since: now };
  if (now - entry.since > 15 * 60 * 1000) { entry.count = 0; entry.since = now; }
  entry.count++;
  attempts.set(ip, entry);
  return entry.count > 20;
}

// POST /api/auth/register  { name, email, password } -> crea cuenta "usuario"
router.post('/register', async (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'El nombre es obligatorio' });
  if (!EMAIL_RX.test(String(email || ''))) return res.status(400).json({ error: 'Correo no válido' });
  if (!password || String(password).length < 8) return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });
  const exists = await User.findOne({ email: String(email).toLowerCase() });
  if (exists) return res.status(409).json({ error: 'Ese correo ya está registrado' });
  const user = await User.create({
    name: String(name).trim(), email, role: 'usuario',
    passwordHash: await bcrypt.hash(String(password), 10)
  });
  setSessionCookie(res, signSession(user));
  res.status(201).json({ user: user.toPublic() });
});

// POST /api/auth/login  { email, password }
router.post('/login', async (req, res) => {
  if (tooManyAttempts(req.ip)) return res.status(429).json({ error: 'Demasiados intentos. Espera 15 minutos.' });
  const { email, password } = req.body || {};
  const user = await User.findOne({ email: String(email || '').toLowerCase() });
  if (!user || !(await bcrypt.compare(String(password || ''), user.passwordHash))) {
    return res.status(401).json({ error: 'Correo o contraseña incorrectos' });
  }
  attempts.delete(req.ip);
  setSessionCookie(res, signSession(user));
  res.json({ user: user.toPublic() });
});

router.post('/logout', (req, res) => {
  res.clearCookie(COOKIE);
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: { id: req.user.sub, name: req.user.name, role: req.user.role } });
});

module.exports = router;
