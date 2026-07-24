// Reporta las descripciones distintas cuya extracción de molecula/marca quedó en baja
// confianza, ordenadas por cuántas filas afectan (para priorizar las que más pesan).
// Cada línea trae el hash a usar como clave en product-overrides.json.
// Uso: node review-products.mjs [N]   (N = cuántas descripciones distintas mostrar, default 30)
import { getPool, closePool } from './db.js';
import { hashDescripcion } from './product-extractor.js';

const TABLE = 'importaciones';
const DESC_COLUMN = 'Desc Completa De Producto';
const limit = Number(process.argv[2]) || 30;

async function main() {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT "${DESC_COLUMN}" AS descripcion, molecula, marca, COUNT(*) as n
     FROM ${TABLE}
     WHERE extraction_confidence = 'low' AND "${DESC_COLUMN}" IS NOT NULL
     GROUP BY "${DESC_COLUMN}", molecula, marca
     ORDER BY n DESC
     LIMIT $1`,
    [limit]
  );

  console.log(`Top ${rows.length} descripciones de baja confianza (por filas afectadas):\n`);
  for (const row of rows) {
    console.log('='.repeat(80));
    console.log(`hash: ${hashDescripcion(row.descripcion)}  |  filas: ${row.n}`);
    console.log(`molecula detectada: ${row.molecula ?? '(ninguna)'}  |  marca detectada: ${row.marca ?? '(ninguna)'}`);
    console.log(`texto: ${row.descripcion.slice(0, 300)}${row.descripcion.length > 300 ? '...' : ''}`);
  }

  console.log(`\nPara corregir, agrega en product-overrides.json bajo "overrides":`);
  console.log(`  "<hash>": { "molecula": "...", "marca": "..." }`);
  console.log('Luego corre "node backfill-products.mjs" de nuevo para aplicar los cambios.');

  await closePool();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
