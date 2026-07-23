import DatabaseConstructor from 'better-sqlite3';
import { extractProductWithOverrides, loadOverrides } from './product-extractor.js';

const TABLE = 'importaciones';
const DESC_COLUMN = 'Desc Completa De Producto';

function quoteIdent(name) {
  return `"${name.replace(/"/g, '""')}"`;
}

export function openDb(dbPath) {
  const db = new DatabaseConstructor(dbPath);
  db.pragma('journal_mode = WAL');
  return db;
}

function tableExists(db) {
  return !!db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(TABLE);
}

// Crea la tabla en el primer uso, con una columna por cada campo presente en la
// primera fila descargada (más las columnas derivadas anio_mes, molecula, marca y
// extraction_confidence), ya que las columnas exactas del Excel de Daater no están
// garantizadas a futuro.
function ensureTable(db, sampleRow) {
  if (tableExists(db)) return;
  const columns = Object.keys(sampleRow).map((name) => `${quoteIdent(name)} TEXT`);
  columns.push('anio_mes TEXT', 'molecula TEXT', 'marca TEXT', 'extraction_confidence TEXT');
  db.exec(`CREATE TABLE ${TABLE} (${columns.join(', ')})`);
  db.exec(`CREATE INDEX idx_${TABLE}_anio_mes ON ${TABLE} (anio_mes)`);
  db.exec(`CREATE INDEX idx_${TABLE}_molecula ON ${TABLE} (molecula)`);
}

export function getLatestMonth(db) {
  if (!tableExists(db)) return null;
  const row = db.prepare(`SELECT MAX(anio_mes) AS m FROM ${TABLE}`).get();
  return row?.m ?? null;
}

// Reemplaza por completo los datos de un mes: borra lo existente e inserta las
// filas nuevas, para evitar duplicados cuando Daater completa un mes parcial.
// De paso calcula molecula/marca/extraction_confidence desde "Desc Completa De
// Producto" para cada fila (aplicando product-overrides.json si hay una corrección
// manual para esa descripción exacta).
export function replaceMonthData(db, anioMes, rows) {
  if (rows.length === 0) return;

  ensureTable(db, rows[0]);
  const overrides = loadOverrides();

  const columns = Object.keys(rows[0]);
  const insertSql = `INSERT INTO ${TABLE} (${columns.map(quoteIdent).join(', ')}, anio_mes, molecula, marca, extraction_confidence) VALUES (${columns.map(() => '?').join(', ')}, ?, ?, ?, ?)`;
  const insertStmt = db.prepare(insertSql);
  const deleteStmt = db.prepare(`DELETE FROM ${TABLE} WHERE anio_mes = ?`);

  const tx = db.transaction((rows) => {
    deleteStmt.run(anioMes);
    for (const row of rows) {
      const values = columns.map((c) => row[c] ?? null);
      const extracted = extractProductWithOverrides(row[DESC_COLUMN], overrides);
      insertStmt.run(...values, anioMes, extracted.molecula, extracted.marca, extracted.confidence);
    }
  });

  tx(rows);
}
