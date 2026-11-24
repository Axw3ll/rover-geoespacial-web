const jwt = require('jsonwebtoken');
const config = require('./config');

const COOKIE = 'rover_token';
const SESSION_HOURS = 8;

function signSession(user) {
  return jwt.sign({ sub: String(user._id), name: user.name, role: user.role, scope: 'session' },
    config.jwtSecret, { expiresIn: `${SESSION_HOURS}h` });
}

// Token corto que el navegador adjunta a cada comando MQTT (no da acceso a la API).
function signCommandToken(user) {
  return jwt.sign({ sub: String(user.sub), name: user.name, role: user.role, scope: 'cmd' },
    config.jwtSecret, { expiresIn: `${SESSION_HOURS}h` });
}

function verify(token, scope) {
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    return payload.scope === scope ? payload : null;
  } catch { return null; }
}

function setSessionCookie(res, token) {
  res.cookie(COOKIE, token, {
    httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_HOURS * 3600 * 1000
  });
}

function requireAuth(req, res, next) {
  const user = verify(req.cookies[COOKIE], 'session');
  if (!user) return res.status(401).json({ error: 'No autenticado' });
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Requiere cuenta de Administrador' });
  next();
}

// Protege las páginas HTML: sin sesión se redirige al inicio de sesión.
const PUBLIC_PAGES = ['/login.html'];
function pageGuard(req, res, next) {
  const isPage = req.path === '/' || req.path.endsWith('.html');
  if (!isPage || PUBLIC_PAGES.includes(req.path)) return next();
  if (verify(req.cookies[COOKIE], 'session')) return next();
  res.redirect('/login.html');
}

module.exports = { COOKIE, signSession, signCommandToken, verify, setSessionCookie, requireAuth, requireAdmin, pageGuard };
