const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'urse.db');

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema();
  }
  return db;
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      username  TEXT    NOT NULL UNIQUE,
      password  TEXT    NOT NULL,
      nombre    TEXT    NOT NULL,
      rol       TEXT    NOT NULL CHECK(rol IN ('admin','consulta')),
      activo    INTEGER NOT NULL DEFAULT 1,
      creado_en TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS resoluciones (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      nro          TEXT    NOT NULL,
      anio         INTEGER NOT NULL,
      cod_rep      TEXT    NOT NULL,
      desc_rep     TEXT    NOT NULL,
      concepto     TEXT    NOT NULL CHECK(concepto IN ('6183004','6183003')),
      autorizadas  REAL    NOT NULL,
      creado_por   INTEGER REFERENCES usuarios(id),
      creado_en    TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(anio, cod_rep, concepto)
    );

    CREATE TABLE IF NOT EXISTS dotacion (
      cuil      TEXT PRIMARY KEY,
      cod_rep   TEXT NOT NULL,
      desc_rep  TEXT NOT NULL,
      cargado_en TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS liquidaciones (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      cuil       TEXT    NOT NULL,
      concepto   TEXT    NOT NULL,
      anio       INTEGER NOT NULL,
      inc_total  REAL    NOT NULL DEFAULT 0,
      rol_total  REAL    NOT NULL DEFAULT 0,
      periodos   TEXT,
      cod_rep    TEXT,
      desc_rep   TEXT,
      matched    INTEGER NOT NULL DEFAULT 0,
      importado_en TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(cuil, concepto, anio)
    );
  `);

  // Crear usuario admin por defecto si no existe
  const existing = db.prepare('SELECT id FROM usuarios WHERE username = ?').get('admin');
  if (!existing) {
    const hash = bcrypt.hashSync('admin1234', 10);
    db.prepare(`
      INSERT INTO usuarios (username, password, nombre, rol)
      VALUES (?, ?, ?, ?)
    `).run('admin', hash, 'Administrador', 'admin');
    console.log('✓ Usuario admin creado: admin / admin1234 (cambiarlo luego)');
  }
}

// ---- USUARIOS ----
const usuarios = {
  findByUsername(username) {
    return getDb().prepare('SELECT * FROM usuarios WHERE username = ? AND activo = 1').get(username);
  },
  findAll() {
    return getDb().prepare('SELECT id, username, nombre, rol, activo, creado_en FROM usuarios ORDER BY id').all();
  },
  create({ username, password, nombre, rol }) {
    const hash = bcrypt.hashSync(password, 10);
    return getDb().prepare('INSERT INTO usuarios (username, password, nombre, rol) VALUES (?, ?, ?, ?)').run(username, hash, nombre, rol);
  },
  toggleActivo(id) {
    const u = getDb().prepare('SELECT activo FROM usuarios WHERE id = ?').get(id);
    if (!u) return;
    getDb().prepare('UPDATE usuarios SET activo = ? WHERE id = ?').run(u.activo ? 0 : 1, id);
  },
  changePassword(id, newPassword) {
    const hash = bcrypt.hashSync(newPassword, 10);
    getDb().prepare('UPDATE usuarios SET password = ? WHERE id = ?').run(hash, id);
  },
  verify(username, password) {
    const u = this.findByUsername(username);
    if (!u) return null;
    if (!bcrypt.compareSync(password, u.password)) return null;
    return u;
  }
};

// ---- RESOLUCIONES ----
const resoluciones = {
  findAll(filtros = {}) {
    let q = 'SELECT r.*, u.nombre as creado_por_nombre FROM resoluciones r LEFT JOIN usuarios u ON r.creado_por = u.id WHERE 1=1';
    const params = [];
    if (filtros.anio) { q += ' AND r.anio = ?'; params.push(filtros.anio); }
    if (filtros.concepto) { q += ' AND r.concepto = ?'; params.push(filtros.concepto); }
    q += ' ORDER BY r.anio DESC, r.desc_rep, r.concepto';
    return getDb().prepare(q).all(...params);
  },
  create({ nro, anio, cod_rep, desc_rep, concepto, autorizadas, creado_por }) {
    return getDb().prepare(`
      INSERT INTO resoluciones (nro, anio, cod_rep, desc_rep, concepto, autorizadas, creado_por)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(nro, anio, cod_rep, desc_rep, concepto, autorizadas, creado_por);
  },
  delete(id) {
    return getDb().prepare('DELETE FROM resoluciones WHERE id = ?').run(id);
  },
  getAnios() {
    return getDb().prepare('SELECT DISTINCT anio FROM resoluciones ORDER BY anio DESC').all().map(r => r.anio);
  }
};

// ---- DOTACION ----
const dotacion = {
  upsertBatch(agentes) {
    const db = getDb();
    const stmt = db.prepare(`
      INSERT INTO dotacion (cuil, cod_rep, desc_rep)
      VALUES (?, ?, ?)
      ON CONFLICT(cuil) DO UPDATE SET cod_rep=excluded.cod_rep, desc_rep=excluded.desc_rep, cargado_en=datetime('now')
    `);
    const tx = db.transaction((items) => {
      for (const a of items) stmt.run(a.cuil, a.cod_rep, a.desc_rep);
    });
    tx(agentes);
  },
  findByCuil(cuil) {
    return getDb().prepare('SELECT * FROM dotacion WHERE cuil = ?').get(cuil);
  },
  count() {
    return getDb().prepare('SELECT COUNT(*) as n FROM dotacion').get().n;
  },
  search(q) {
    const like = `%${q}%`;
    return getDb().prepare('SELECT * FROM dotacion WHERE cuil LIKE ? OR desc_rep LIKE ? OR cod_rep LIKE ? LIMIT 200').all(like, like, like);
  },
  lastUpdate() {
    const r = getDb().prepare('SELECT MAX(cargado_en) as t FROM dotacion').get();
    return r ? r.t : null;
  }
};

// ---- LIQUIDACIONES ----
const liquidaciones = {
  upsertBatch(items) {
    const db = getDb();
    const stmt = db.prepare(`
      INSERT INTO liquidaciones (cuil, concepto, anio, inc_total, rol_total, periodos, cod_rep, desc_rep, matched)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(cuil, concepto, anio) DO UPDATE SET
        inc_total=excluded.inc_total, rol_total=excluded.rol_total,
        periodos=excluded.periodos, cod_rep=excluded.cod_rep,
        desc_rep=excluded.desc_rep, matched=excluded.matched,
        importado_en=datetime('now')
    `);
    const tx = db.transaction((rows) => {
      for (const r of rows) stmt.run(r.cuil, r.concepto, r.anio, r.inc_total, r.rol_total, r.periodos, r.cod_rep, r.desc_rep, r.matched ? 1 : 0);
    });
    tx(items);
  },
  findAll(filtros = {}) {
    let q = 'SELECT * FROM liquidaciones WHERE 1=1';
    const params = [];
    if (filtros.concepto) { q += ' AND concepto = ?'; params.push(filtros.concepto); }
    if (filtros.anio) { q += ' AND anio = ?'; params.push(filtros.anio); }
    if (filtros.buscar) { q += ' AND (cuil LIKE ? OR desc_rep LIKE ?)'; params.push(`%${filtros.buscar}%`, `%${filtros.buscar}%`); }
    q += ' ORDER BY desc_rep, concepto, cuil LIMIT 500';
    return getDb().prepare(q).all(...params);
  },
  // Agrupado por (cod_rep, concepto, anio) para el control
  getAgrupado(anio) {
    let q = `
      SELECT cod_rep, desc_rep, concepto, anio,
             SUM(inc_total) as inc_total,
             SUM(rol_total) as rol_total,
             SUM(inc_total + rol_total) as total,
             COUNT(*) as agentes
      FROM liquidaciones
      WHERE matched = 1
    `;
    const params = [];
    if (anio) { q += ' AND anio = ?'; params.push(anio); }
    q += ' GROUP BY cod_rep, concepto, anio ORDER BY desc_rep, concepto';
    return getDb().prepare(q).all(...params);
  },
  getAnios() {
    return getDb().prepare('SELECT DISTINCT anio FROM liquidaciones ORDER BY anio DESC').all().map(r => r.anio);
  },
  count() {
    return getDb().prepare('SELECT COUNT(*) as n FROM liquidaciones').get().n;
  },
  sinMatch() {
    return getDb().prepare('SELECT COUNT(*) as n FROM liquidaciones WHERE matched = 0').get().n;
  }
};

module.exports = { getDb, usuarios, resoluciones, dotacion, liquidaciones };
