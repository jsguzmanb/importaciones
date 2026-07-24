import pg from 'pg';
import { extractProductWithOverrides, loadOverrides } from './product-extractor.js';

const { Pool } = pg;

const TABLE = 'importaciones';
const DESC_COLUMN = 'Desc Completa De Producto';

// Postgres necesita un esquema fijo (a diferencia de la versión SQLite anterior, que
// creaba una columna TEXT por cada campo presente en la primera fila descargada).
// Las columnas de Daater no cambian en la práctica; si Daater agrega una columna nueva
// al Excel, replaceMonthData() la ignora silenciosamente en vez de fallar -- hay que
// añadirla aquí a mano si se necesita.
const COLUMNS = [
  'Fecha',
  'Numero Formulario',
  'Numero Factura',
  'Tasa de Cambio',
  'Aduanas',
  'Aduana presentada',
  'Lugar De Ingreso',
  'Nit Declarante (Documento)',
  'Razon Social Declarante',
  'Modalidad Importación',
  'Manifiesto de Carga',
  'Modo Transporte',
  'Empresa Transportadora',
  'Importador (Documento)',
  'Importador (Razon social)',
  'Direccion Importador',
  'Telefono Importador',
  'Departamento Importador',
  'Exportador (Proveedor)',
  'Direccion Exportador',
  'Dato de Contacto Exportador',
  'Ciudad Exportador',
  'País exportador',
  'País compra',
  'País procedencia',
  'País origen',
  'Partida Arancelaria (Documento)',
  'Partida Arancelaria (Razon social)',
  'Cantidad',
  'Unidad comercial',
  'VALOR FOB UNITARIO (Documento)',
  'Embalajes',
  'Numero de Bultos',
  'Peso Neto',
  'Peso Bruto',
  'Seguro',
  'VALOR CIF UNITARIO (Documento)',
  'SUMA FLETE SEGURO OTROS GASTOS',
  'Valor Fob (USD)',
  'Flete',
  'Otros Gastos',
  'Valor Cif (USD)',
  'ANIO REGISTRO LICENCIA',
  'Porcentaje Arancel',
  'Porcentaje Antidumping',
  'Porcentaje Iva',
  'Numero Licencia',
  'Desc Completa De Producto',
  'Precio Unitario Licencias (Documento)',
  'Cantidad Licencias',
  'Fecha de Expedicion',
  'Unidad Fisica',
  'Nombre Visto Bueno',
  'Referencia',
  'Fecha de Vigencia',
  'Nombre Entidad Permiso',
  'Aduana Anterior',
  'Aduana Expo',
  'Documento Transporte (Documento)',
  'Porcentaje Otros',
  'Valor Pagos Anteriores',
  'Razon Social Importador',
];

function quoteIdent(name) {
  return `"${name.replace(/"/g, '""')}"`;
}

let pool;
export function getPool() {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('Falta DATABASE_URL. Copia .env.example a .env.local y completa la connection string de Supabase/Postgres.');
    }
    pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });
  }
  return pool;
}

export async function ensureSchema() {
  const pool = getPool();
  const columns = COLUMNS.map((name) => `${quoteIdent(name)} TEXT`).join(', ');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id SERIAL PRIMARY KEY,
      ${columns},
      anio_mes TEXT,
      molecula TEXT,
      marca TEXT,
      extraction_confidence TEXT
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_${TABLE}_anio_mes ON ${TABLE} (anio_mes)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_${TABLE}_molecula ON ${TABLE} (molecula)`);
}

export async function getLatestMonth() {
  const pool = getPool();
  const { rows } = await pool.query(`SELECT MAX(anio_mes) AS m FROM ${TABLE}`);
  return rows[0]?.m ?? null;
}

// Cierra el pool de conexiones. Los scripts CLI de un solo uso (search-daater.mjs,
// backfill-products.mjs, review-products.mjs) deben llamarlo al terminar para que
// el proceso de Node pueda salir; server.mjs (long-running) nunca lo llama.
export async function closePool() {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

// Tamaño de lote para el INSERT multi-fila: cada fila usa insertColumns.length
// parámetros, y Postgres limita a 65535 parámetros por statement. 500 filas queda muy
// por debajo del límite incluso con ~60 columnas, y evita el costo de un round-trip de
// red por fila (crítico al insertar miles de filas contra una base remota como Supabase).
const BATCH_SIZE = 500;

// Reemplaza por completo los datos de un mes: borra lo existente e inserta las filas
// nuevas, para evitar duplicados cuando Daater completa un mes parcial. De paso calcula
// molecula/marca/extraction_confidence desde "Desc Completa De Producto" para cada fila
// (aplicando product-overrides.json si hay una corrección manual para esa descripción).
export async function replaceMonthData(anioMes, rows) {
  if (rows.length === 0) return;

  const pool = getPool();
  await ensureSchema();
  const overrides = loadOverrides();

  const columns = COLUMNS.filter((c) => c in rows[0]);
  const insertColumns = [...columns, 'anio_mes', 'molecula', 'marca', 'extraction_confidence'];
  const columnList = insertColumns.map(quoteIdent).join(', ');

  const allValues = rows.map((row) => {
    const extracted = extractProductWithOverrides(row[DESC_COLUMN], overrides);
    return [
      ...columns.map((c) => row[c] ?? null),
      anioMes,
      extracted.molecula,
      extracted.marca,
      extracted.confidence,
    ];
  });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM ${TABLE} WHERE anio_mes = $1`, [anioMes]);

    for (let i = 0; i < allValues.length; i += BATCH_SIZE) {
      const batch = allValues.slice(i, i + BATCH_SIZE);
      const params = [];
      const valuePlaceholders = batch.map((values) => {
        const placeholders = values.map((v) => {
          params.push(v);
          return `$${params.length}`;
        });
        return `(${placeholders.join(', ')})`;
      });
      await client.query(
        `INSERT INTO ${TABLE} (${columnList}) VALUES ${valuePlaceholders.join(', ')}`,
        params
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
