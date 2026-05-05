const XLSX = require('xlsx');

const CONCEPTOS = {
  'CAR_U_URSE_SIM': '6183004',
  'CAR_URSE_SIM':   '6183004',
  'CAR_U_URSE_DIF': '6183003',
  'CAR_URSE_DIF':   '6183003',
};

function numVal(v) {
  if (v === null || v === undefined || v === '-' || v === '') return 0;
  const n = parseFloat(v);
  return isNaN(n) ? 0 : n;
}

/**
 * Parsea el Excel de liquidaciones exportado desde QlikView.
 * Estructura esperada:
 *   Fila 0: [vacío x4, 'Imputación', 'ene. 2026', 'ene. 2026', 'feb. 2026', ... 'Total', 'Total']
 *   Fila 1: DESC ITEM, COD_REG, ESCALAFON, CARGO, CUIL, INC, ROL, INC, ROL, ... INC, ROL
 *   Fila 2+: datos
 * Columnas INC: 5, 7, 9, 11 ... (pares desde col 5)
 * Columnas ROL: 6, 8, 10, 12 ...
 * Col 13 = INC Total, Col 14 = ROL Total
 */
function parseLiquidaciones(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

  if (rows.length < 3) throw new Error('Archivo sin datos suficientes');

  const periodoRow = rows[0];
  const headerRow  = rows[1];

  // Detectar año del archivo desde los encabezados de períodos
  let anioDetectado = null;
  for (const cell of periodoRow) {
    if (typeof cell === 'string') {
      const m = cell.match(/\d{4}/);
      if (m) { anioDetectado = parseInt(m[0]); break; }
    }
  }
  if (!anioDetectado) anioDetectado = new Date().getFullYear();

  // Etiquetas de períodos (para guardar detalle)
  const periodos = [];
  for (let c = 5; c < periodoRow.length - 2; c += 2) {
    const label = periodoRow[c];
    if (label && label !== 'Total') periodos.push(String(label));
  }

  const resultado = [];
  let skipped = 0;

  for (let i = 2; i < rows.length; i++) {
    const row = rows[i];
    const item = String(row[0] || '').trim();
    if (!item || item === 'DESC ITEM') continue;

    const concepto = CONCEPTOS[item];
    if (!concepto) { skipped++; continue; }

    const cuil = String(row[4] || '').trim();
    if (!cuil || !cuil.match(/\d{2}-\d+/)) continue;

    // Totales de las últimas 2 columnas
    const inc_total = numVal(row[row.length - 2]);
    const rol_total = numVal(row[row.length - 1]);

    // Detalle por período
    const per_detail = [];
    for (let ci = 5, pi = 0; ci < periodoRow.length - 2 && pi < periodos.length; ci += 2, pi++) {
      const inc = numVal(row[ci]);
      const rol = numVal(row[ci + 1]);
      if (inc !== 0 || rol !== 0) {
        per_detail.push(`${periodos[pi]}: INC=${inc} ROL=${rol}`);
      }
    }

    resultado.push({
      cuil,
      concepto,
      anio: anioDetectado,
      inc_total,
      rol_total,
      periodos: per_detail.join(' | '),
      cod_rep: '',
      desc_rep: '',
      matched: false,
    });
  }

  return { registros: resultado, anio: anioDetectado, skipped };
}

/**
 * Parsea el Excel de dotación exportado desde QlikView.
 * Estructura:
 *   Fila 0: headers (ORIGEN, CARGO, COD_REP, DESC_REP, ..., CUIL en col J=9)
 *   Fila 1+: datos — un CUIL puede aparecer N veces (historial), tomamos la última
 */
function parseDotacion(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

  if (rows.length < 2) throw new Error('Archivo sin datos suficientes');

  const header = rows[0].map(h => String(h).trim().toUpperCase());

  // Detectar columnas por nombre de header
  const iCuil = header.findIndex(h => h === 'CUIL');
  const iCod  = header.findIndex(h => h === 'COD_REP');
  const iDesc = header.findIndex(h => h === 'DESC_REP');

  const colCuil = iCuil >= 0 ? iCuil : 9;
  const colCod  = iCod  >= 0 ? iCod  : 2;
  const colDesc = iDesc >= 0 ? iDesc : 3;

  // Mapa cuil -> {cod_rep, desc_rep}: última ocurrencia gana (más reciente)
  const mapa = {};
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const cuil = String(row[colCuil] || '').trim();
    const cod  = String(row[colCod]  || '').trim();
    const desc = String(row[colDesc] || '').trim();
    if (cuil && cuil.match(/\d{2}-\d+/) && cod && desc) {
      mapa[cuil] = { cuil, cod_rep: cod, desc_rep: desc };
    }
  }

  return Object.values(mapa);
}

module.exports = { parseLiquidaciones, parseDotacion };
