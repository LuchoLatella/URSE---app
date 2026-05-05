const initSqlJs = require('sql.js');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '..', 'data', 'urse.db');

let db = null;
let sqlJs = null;

// Guardar la DB en disco
function persistDb() {
  if (!db) return;
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

// Guardar cada 30 segundos y al cerrar
setInterval(persistDb, 30000);
process.on('exit', persistDb);
process.on('SIGINT', () => { persistDb(); process.exit(0); });
process.on('SIGTERM', () => { persistDb(); process.exit(0); });

async function initDb() {
  if (db) return db;
  sqlJs = await initSqlJs();
  
  const dataDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new sqlJs.Database(fileBuffer);
  } else {
    db = new sqlJs.Database();
  }

  // Esquema
  db.run(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      username  TEXT    NOT NULL UNIQUE,
      password  TEXT    NOT NULL,
      nombre    TEXT    NOT NULL,
      rol       TEXT    NOT NULL,
      activo    INTEGER NOT NULL DEFAULT 1,
      creado_en TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS resoluciones (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      nro          TEXT    NOT NULL,
      anio         INTEGER NOT NULL,
      cod_rep      TEXT    NOT NULL,
      desc_rep     TEXT    NOT NULL,
      concepto     TEXT    NOT NULL,
      autorizadas  REAL    NOT NULL,
      creado_por   INTEGER,
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

  // Admin por defecto
  const res = db.exec("SELECT id FROM usuarios WHERE username = 'admin'");
  if (!res.length || !res[0].values.length) {
    const hash = bcrypt.hashSync('admin1234', 10);
    db.run('INSERT INTO usuarios (username, password, nombre, rol) VALUES (?,?,?,?)',
      ['admin', hash, 'Administrador', 'admin']);
    console.log('✓ Usuario admin creado: admin / admin1234');
    persistDb();
  }

  return db;
}

// Helper: ejecutar query y devolver filas como objetos
function queryAll(sql, params = []) {
  const res = db.exec(sql, params);
  if (!res.length) return [];
  const { columns, values } = res[0];
  return values.map(row => {
    const obj = {};
    columns.forEach((col, i) => obj[col] = row[i]);
    return obj;
  });
}

function queryOne(sql, params = []) {
  const rows = queryAll(sql, params);
  return rows[0] || null;
}

function run(sql, params = []) {
  db.run(sql, params);
  persistDb();
}

// ---- USUARIOS ----
const usuarios = {
  findByUsername(username) {
    return queryOne('SELECT * FROM usuarios WHERE username = ? AND activo = 1', [username]);
  },
  findAll() {
    return queryAll('SELECT id, username, nombre, rol, activo, creado_en FROM usuarios ORDER BY id');
  },
  create({ username, password, nombre, rol }) {
    const hash = bcrypt.hashSync(password, 10);
    run('INSERT INTO usuarios (username, password, nombre, rol) VALUES (?,?,?,?)', [username, hash, nombre, rol]);
  },
  toggleActivo(id) {
    const u = queryOne('SELECT activo FROM usuarios WHERE id = ?', [id]);
    if (!u) return;
    run('UPDATE usuarios SET activo = ? WHERE id = ?', [u.activo ? 0 : 1, id]);
  },
  changePassword(id, newPassword) {
    const hash = bcrypt.hashSync(newPassword, 10);
    run('UPDATE usuarios SET password = ? WHERE id = ?', [hash, id]);
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
    let q = `SELECT r.*, u.nombre as creado_por_nombre 
             FROM resoluciones r 
             LEFT JOIN usuarios u ON r.creado_por = u.id 
             WHERE 1=1`;
    const params = [];
    if (filtros.anio)    { q += ' AND r.anio = ?';     params.push(parseInt(filtros.anio)); }
    if (filtros.concepto){ q += ' AND r.concepto = ?'; params.push(filtros.concepto); }
    q += ' ORDER BY r.anio DESC, r.desc_rep, r.concepto';
    return queryAll(q, params);
  },
  create({ nro, anio, cod_rep, desc_rep, concepto, autorizadas, creado_por }) {
    run('INSERT INTO resoluciones (nro,anio,cod_rep,desc_rep,concepto,autorizadas,creado_por) VALUES (?,?,?,?,?,?,?)',
      [nro, anio, cod_rep, desc_rep, concepto, autorizadas, creado_por]);
  },
  delete(id) { run('DELETE FROM resoluciones WHERE id = ?', [id]); },
  getAnios() {
    return queryAll('SELECT DISTINCT anio FROM resoluciones ORDER BY anio DESC').map(r => r.anio);
  }
};

// ---- DOTACION ----
const dotacion = {
  upsertBatch(agentes) {
    db.run('BEGIN TRANSACTION');
    try {
      for (const a of agentes) {
        db.run(`INSERT INTO dotacion (cuil, cod_rep, desc_rep)
                VALUES (?,?,?)
                ON CONFLICT(cuil) DO UPDATE SET cod_rep=excluded.cod_rep, desc_rep=excluded.desc_rep, cargado_en=datetime('now')`,
          [a.cuil, a.cod_rep, a.desc_rep]);
      }
      db.run('COMMIT');
    } catch(e) { db.run('ROLLBACK'); throw e; }
    persistDb();
  },
  findByCuil(cuil) {
    return queryOne('SELECT * FROM dotacion WHERE cuil = ?', [cuil]);
  },
  count() {
    const r = queryOne('SELECT COUNT(*) as n FROM dotacion');
    return r ? r.n : 0;
  },
  search(q) {
    const like = `%${q}%`;
    return queryAll('SELECT * FROM dotacion WHERE cuil LIKE ? OR desc_rep LIKE ? OR cod_rep LIKE ? LIMIT 200', [like, like, like]);
  },
  lastUpdate() {
    const r = queryOne('SELECT MAX(cargado_en) as t FROM dotacion');
    return r ? r.t : null;
  }
};

// ---- LIQUIDACIONES ----
const liquidaciones = {
  upsertBatch(items) {
    db.run('BEGIN TRANSACTION');
    try {
      for (const r of items) {
        db.run(`INSERT INTO liquidaciones (cuil,concepto,anio,inc_total,rol_total,periodos,cod_rep,desc_rep,matched)
                VALUES (?,?,?,?,?,?,?,?,?)
                ON CONFLICT(cuil,concepto,anio) DO UPDATE SET
                  inc_total=excluded.inc_total, rol_total=excluded.rol_total,
                  periodos=excluded.periodos, cod_rep=excluded.cod_rep,
                  desc_rep=excluded.desc_rep, matched=excluded.matched,
                  importado_en=datetime('now')`,
          [r.cuil, r.concepto, r.anio, r.inc_total, r.rol_total, r.periodos,
           r.cod_rep, r.desc_rep, r.matched ? 1 : 0]);
      }
      db.run('COMMIT');
    } catch(e) { db.run('ROLLBACK'); throw e; }
    persistDb();
  },
  findAll(filtros = {}) {
    let q = 'SELECT * FROM liquidaciones WHERE 1=1';
    const params = [];
    if (filtros.concepto){ q += ' AND concepto = ?'; params.push(filtros.concepto); }
    if (filtros.anio)    { q += ' AND anio = ?';     params.push(parseInt(filtros.anio)); }
    if (filtros.buscar)  { q += ' AND (cuil LIKE ? OR desc_rep LIKE ?)'; params.push(`%${filtros.buscar}%`, `%${filtros.buscar}%`); }
    q += ' ORDER BY desc_rep, concepto, cuil LIMIT 500';
    return queryAll(q, params);
  },
  getAgrupado(anio) {
    let q = `SELECT cod_rep, desc_rep, concepto, anio,
                    SUM(inc_total) as inc_total,
                    SUM(rol_total) as rol_total,
                    SUM(inc_total + rol_total) as total,
                    COUNT(*) as agentes
             FROM liquidaciones WHERE matched = 1`;
    const params = [];
    if (anio) { q += ' AND anio = ?'; params.push(parseInt(anio)); }
    q += ' GROUP BY cod_rep, concepto, anio ORDER BY desc_rep, concepto';
    return queryAll(q, params);
  },
  getAnios() {
    return queryAll('SELECT DISTINCT anio FROM liquidaciones ORDER BY anio DESC').map(r => r.anio);
  },
  count() {
    const r = queryOne('SELECT COUNT(*) as n FROM liquidaciones');
    return r ? r.n : 0;
  },
  sinMatch() {
    const r = queryOne('SELECT COUNT(*) as n FROM liquidaciones WHERE matched = 0');
    return r ? r.n : 0;
  }
};

module.exports = { initDb, usuarios, resoluciones, dotacion, liquidaciones };
