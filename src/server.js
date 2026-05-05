const express  = require('express');
const session  = require('express-session');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');

const { initDb, usuarios, resoluciones, dotacion, liquidaciones } = require('./db');
const { parseLiquidaciones, parseDotacion } = require('./parser');
const { requireAuth, requireAdmin, apiError, apiOk } = require('./middleware');

const app  = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, '..', 'data');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// -------- MIDDLEWARES --------
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// Sesiones en memoria (simples, se pierden al reiniciar — OK para uso local)
app.use(session({
  secret: 'urse-secret-key-2026-gcaba',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 }
}));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }
});

app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  next();
});

// -------- AUTH --------
app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.sendFile(path.join(__dirname, '..', 'public', 'login.html'));
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  const user = usuarios.verify(username, password);
  if (!user) return res.status(401).json({ ok: false, error: 'Usuario o contraseña incorrectos' });
  req.session.user = { id: user.id, username: user.username, nombre: user.nombre, rol: user.rol };
  res.json({ ok: true, rol: user.rol });
});

app.post('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ ok: true, user: req.session.user });
});

// -------- MAIN APP --------
app.get('/', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'app.html'));
});

// -------- API: USUARIOS --------
app.get('/api/usuarios', requireAuth, requireAdmin, (req, res) => {
  res.json({ ok: true, data: usuarios.findAll() });
});

app.post('/api/usuarios', requireAuth, requireAdmin, (req, res) => {
  const { username, password, nombre, rol } = req.body;
  if (!username || !password || !nombre || !['admin','consulta'].includes(rol))
    return apiError(res, 'Datos incompletos o rol inválido');
  try {
    usuarios.create({ username, password, nombre, rol });
    apiOk(res, { mensaje: 'Usuario creado' });
  } catch (e) {
    if (e.message && e.message.includes('UNIQUE')) return apiError(res, 'El nombre de usuario ya existe');
    apiError(res, e.message);
  }
});

app.patch('/api/usuarios/:id/toggle', requireAuth, requireAdmin, (req, res) => {
  usuarios.toggleActivo(req.params.id);
  apiOk(res);
});

app.patch('/api/usuarios/:id/password', requireAuth, requireAdmin, (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 6) return apiError(res, 'Contraseña mínima de 6 caracteres');
  usuarios.changePassword(req.params.id, password);
  apiOk(res);
});

// -------- API: RESOLUCIONES --------
app.get('/api/resoluciones', requireAuth, (req, res) => {
  const { anio, concepto } = req.query;
  const data = resoluciones.findAll({ anio, concepto });
  const anios = resoluciones.getAnios();
  res.json({ ok: true, data, anios });
});

app.post('/api/resoluciones', requireAuth, requireAdmin, (req, res) => {
  const { nro, anio, cod_rep, desc_rep, concepto, autorizadas } = req.body;
  if (!nro || !anio || !cod_rep || !desc_rep || !concepto || autorizadas === undefined)
    return apiError(res, 'Todos los campos son obligatorios');
  if (!['6183004','6183003'].includes(concepto))
    return apiError(res, 'Concepto inválido');
  try {
    resoluciones.create({
      nro, anio: parseInt(anio), cod_rep, desc_rep, concepto,
      autorizadas: parseFloat(autorizadas), creado_por: req.session.user.id
    });
    apiOk(res, { mensaje: 'Resolución cargada' });
  } catch (e) {
    if (e.message && e.message.includes('UNIQUE'))
      return apiError(res, 'Ya existe una resolución para ese año, repartición y concepto');
    apiError(res, e.message);
  }
});

app.delete('/api/resoluciones/:id', requireAuth, requireAdmin, (req, res) => {
  resoluciones.delete(req.params.id);
  apiOk(res);
});

// -------- API: DOTACIÓN --------
app.get('/api/dotacion/info', requireAuth, (req, res) => {
  res.json({ ok: true, total: dotacion.count(), ultimaActualizacion: dotacion.lastUpdate() });
});

app.get('/api/dotacion/buscar', requireAuth, (req, res) => {
  const q = req.query.q || '';
  res.json({ ok: true, data: dotacion.search(q) });
});

app.post('/api/dotacion/importar', requireAuth, requireAdmin, upload.single('archivo'), (req, res) => {
  if (!req.file) return apiError(res, 'No se recibió archivo');
  try {
    const agentes = parseDotacion(req.file.buffer);
    if (!agentes.length) return apiError(res, 'No se encontraron agentes válidos en el archivo');
    dotacion.upsertBatch(agentes);
    // Re-emparejar liquidaciones existentes
    const liqs = liquidaciones.findAll({});
    if (liqs.length) {
      const actualizadas = liqs.map(l => {
        const d = dotacion.findByCuil(l.cuil);
        return { ...l, cod_rep: d ? d.cod_rep : '', desc_rep: d ? d.desc_rep : '', matched: !!d };
      });
      liquidaciones.upsertBatch(actualizadas);
    }
    apiOk(res, { total: agentes.length, mensaje: `${agentes.length.toLocaleString('es-AR')} agentes únicos importados` });
  } catch (e) {
    apiError(res, e.message);
  }
});

// -------- API: LIQUIDACIONES --------
app.get('/api/liquidaciones', requireAuth, (req, res) => {
  const { concepto, anio, buscar } = req.query;
  const data = liquidaciones.findAll({ concepto, anio, buscar });
  const anios = liquidaciones.getAnios();
  const total = liquidaciones.count();
  const sinMatch = liquidaciones.sinMatch();
  res.json({ ok: true, data, anios, total, sinMatch });
});

app.post('/api/liquidaciones/importar', requireAuth, requireAdmin, upload.single('archivo'), (req, res) => {
  if (!req.file) return apiError(res, 'No se recibió archivo');
  try {
    const { registros, anio, skipped } = parseLiquidaciones(req.file.buffer);
    if (!registros.length) return apiError(res, 'No se encontraron registros URSE en el archivo');
    registros.forEach(r => {
      const d = dotacion.findByCuil(r.cuil);
      if (d) { r.cod_rep = d.cod_rep; r.desc_rep = d.desc_rep; r.matched = true; }
    });
    liquidaciones.upsertBatch(registros);
    const matched = registros.filter(r => r.matched).length;
    apiOk(res, {
      total: registros.length, matched, sinMatch: registros.length - matched, anio, skipped,
      mensaje: `${registros.length} registros importados (año ${anio}). ${matched} emparejados con dotación.`
    });
  } catch (e) {
    apiError(res, e.message);
  }
});

// -------- API: CONTROL --------
app.get('/api/control', requireAuth, (req, res) => {
  const { anio, concepto, estado } = req.query;
  const ress = resoluciones.findAll({ anio, concepto });
  const liqs = liquidaciones.getAgrupado(anio);

  const liqMap = {};
  liqs.forEach(l => { liqMap[`${l.cod_rep}||${l.concepto}||${l.anio}`] = l; });

  const resCubiertas = new Set(ress.map(r => `${r.cod_rep}||${r.concepto}||${r.anio}`));
  const sinResolucion = liqs.filter(l => !resCubiertas.has(`${l.cod_rep}||${l.concepto}||${l.anio}`));

  let filas = ress.map(r => {
    const key = `${r.cod_rep}||${r.concepto}||${r.anio}`;
    const liq = liqMap[key] || { inc_total: 0, rol_total: 0, total: 0, agentes: 0 };
    const total_liq = liq.total || 0;
    const saldo = r.autorizadas - total_liq;
    const pct = r.autorizadas > 0 ? (total_liq / r.autorizadas) * 100 : 0;
    return {
      id: r.id, nro: r.nro, anio: r.anio, cod_rep: r.cod_rep, desc_rep: r.desc_rep,
      concepto: r.concepto, autorizadas: r.autorizadas,
      inc_total: liq.inc_total || 0, rol_total: liq.rol_total || 0, total_liq,
      saldo, pct: Math.round(pct * 10) / 10, agentes: liq.agentes || 0,
      estado: saldo < 0 ? 'danger' : pct >= 80 ? 'warn' : 'ok',
    };
  });

  if (estado && ['ok','warn','danger'].includes(estado)) {
    filas = filas.filter(f => f.estado === estado);
  }

  const todasFilas = ress.map(r => {
    const liq = liqMap[`${r.cod_rep}||${r.concepto}||${r.anio}`] || { total: 0 };
    return { autorizadas: r.autorizadas, total_liq: liq.total || 0 };
  });
  const totAut = todasFilas.reduce((s, f) => s + f.autorizadas, 0);
  const totLiq = todasFilas.reduce((s, f) => s + f.total_liq, 0);

  res.json({
    ok: true, filas, sinResolucion,
    metricas: {
      totAut, totLiq, totSaldo: totAut - totLiq,
      pctGlobal: totAut > 0 ? Math.round((totLiq / totAut) * 100) : 0,
      excedidos: todasFilas.filter(f => (f.autorizadas - f.total_liq) < 0).length,
      sinResolucion: sinResolucion.length,
    }
  });
});

// -------- START --------
initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`\n✓ Sistema Control URSE corriendo en http://localhost:${PORT}`);
    console.log(`  Usuario por defecto: admin / admin1234\n`);
  });
}).catch(err => {
  console.error('Error iniciando la base de datos:', err);
  process.exit(1);
});
