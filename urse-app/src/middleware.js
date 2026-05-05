// Middleware: requiere sesión activa
function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  res.redirect('/login');
}

// Middleware: requiere rol admin
function requireAdmin(req, res, next) {
  if (req.session && req.session.user && req.session.user.rol === 'admin') return next();
  res.status(403).send('Acceso denegado. Se requiere rol administrador.');
}

// Respuesta JSON de error uniforme
function apiError(res, msg, status = 400) {
  return res.status(status).json({ ok: false, error: msg });
}

function apiOk(res, data = {}) {
  return res.json({ ok: true, ...data });
}

module.exports = { requireAuth, requireAdmin, apiError, apiOk };
