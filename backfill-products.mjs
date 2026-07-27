// Migración de un solo uso: recalcula molecula/marca/extraction_confidence/
// vital_no_disponible para todas las filas históricas a partir de "Desc Completa De
// Producto". Correr con `node backfill-products.mjs`; correrlo de nuevo es seguro
// (recalcula todo, útil tras editar product-overrides.json o ajustar el extractor).
import { getPool, closePool, ensureSchema } from './db.js';
import { extractProductWithOverrides, loadOverrides } from './product-extractor.js';

const TABLE = 'importaciones';
const DESC_COLUMN = 'Desc Completa De Producto';

async function main() {
  const pool = getPool();
  await ensureSchema();
  const overrides = loadOverrides();

  const { rows } = await pool.query(`SELECT id, "${DESC_COLUMN}" AS descripcion FROM ${TABLE}`);
  console.log(`Procesando ${rows.length} filas...`);

  let high = 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const row of rows) {
      const extracted = extractProductWithOverrides(row.descripcion, overrides);
      if (extracted.confidence === 'high') high++;
      await client.query(
        `UPDATE ${TABLE} SET molecula = $1, marca = $2, extraction_confidence = $3, vital_no_disponible = $4 WHERE id = $5`,
        [extracted.molecula, extracted.marca, extracted.confidence, extracted.vitalNoDisponible, row.id]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  console.log(`Listo. Confianza alta: ${high}/${rows.length} (${((100 * high) / rows.length).toFixed(1)}%)`);
  await closePool();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
