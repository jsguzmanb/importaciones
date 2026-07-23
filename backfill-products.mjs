// Migración de un solo uso: agrega (si faltan) las columnas molecula/marca/
// extraction_confidence a la tabla importaciones ya existente, y calcula esos
// valores para todas las filas históricas a partir de "Desc Completa De Producto".
// Correr una vez con `node backfill-products.mjs`; correrlo de nuevo es seguro
// (recalcula todo, útil tras editar product-overrides.json o ajustar el extractor).
import { config } from './config.js';
import { openDb } from './db.js';
import { extractProductWithOverrides, loadOverrides } from './product-extractor.js';

const TABLE = 'importaciones';
const DESC_COLUMN = 'Desc Completa De Producto';

function ensureColumns(db) {
  const existing = db.prepare(`PRAGMA table_info(${TABLE})`).all().map((c) => c.name);
  for (const [name, type] of [
    ['molecula', 'TEXT'],
    ['marca', 'TEXT'],
    ['extraction_confidence', 'TEXT'],
  ]) {
    if (!existing.includes(name)) {
      db.exec(`ALTER TABLE ${TABLE} ADD COLUMN "${name}" ${type}`);
    }
  }
  const hasIndex = db
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name=?")
    .get(`idx_${TABLE}_molecula`);
  if (!hasIndex) db.exec(`CREATE INDEX idx_${TABLE}_molecula ON ${TABLE} (molecula)`);
}

function main() {
  const db = openDb(config.dbFile);
  ensureColumns(db);

  const overrides = loadOverrides();
  const rows = db.prepare(`SELECT rowid, "${DESC_COLUMN}" AS descripcion FROM ${TABLE}`).all();
  console.log(`Procesando ${rows.length} filas...`);

  const updateStmt = db.prepare(
    `UPDATE ${TABLE} SET molecula = ?, marca = ?, extraction_confidence = ? WHERE rowid = ?`
  );

  let high = 0;
  const tx = db.transaction((rows) => {
    for (const row of rows) {
      const extracted = extractProductWithOverrides(row.descripcion, overrides);
      if (extracted.confidence === 'high') high++;
      updateStmt.run(extracted.molecula, extracted.marca, extracted.confidence, row.rowid);
    }
  });
  tx(rows);

  console.log(`Listo. Confianza alta: ${high}/${rows.length} (${((100 * high) / rows.length).toFixed(1)}%)`);
  db.close();
}

main();
