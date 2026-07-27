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
    // max bajo (no el default de 10): en Vercel cada invocación de función serverless
    // puede crear su propia instancia de este módulo con su propio Pool, así que varias
    // invocaciones concurrentes multiplican conexiones -- con el default de 10 unas
    // pocas invocaciones ya superan el límite del pooler de Supabase en modo sesión (15
    // clientes), como pasó con el error EMAXCONNSESSION. Cada request de este dashboard
    // solo necesita 1-2 conexiones a la vez, así que un max bajo por instancia es
    // suficiente y deja margen para que quepan varias instancias serverless a la vez.
    pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false }, max: 3 });
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
      extraction_confidence TEXT,
      vital_no_disponible BOOLEAN
    )
  `);
  // ADD COLUMN IF NOT EXISTS cubre bases creadas antes de que existiera esta columna
  // (CREATE TABLE IF NOT EXISTS de arriba no las altera si la tabla ya existe).
  await pool.query(`ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS vital_no_disponible BOOLEAN`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_${TABLE}_anio_mes ON ${TABLE} (anio_mes)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_${TABLE}_molecula ON ${TABLE} (molecula)`);

  // moleculas_conocidas registra, de forma durable entre corridas, la primera vez que se
  // vio cada molécula -- necesario porque replaceMonthData() borra y reinserta un mes
  // completo en cada corrida, así que no se puede detectar "molécula nueva" comparando
  // solo las filas del mes actual contra sí mismas.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS moleculas_conocidas (
      molecula TEXT PRIMARY KEY,
      primera_vez_vista TIMESTAMPTZ NOT NULL DEFAULT now(),
      primer_anio_mes TEXT
    )
  `);

  // novedades es el log de alertas mostrado en el dashboard: una fila por molécula nueva
  // detectada en cada corrida del scraper (no se sobreescribe, para conservar historial).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS novedades (
      id SERIAL PRIMARY KEY,
      molecula TEXT NOT NULL,
      anio_mes TEXT,
      filas INTEGER,
      detectada_en TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_novedades_detectada_en ON novedades (detectada_en)`);

  await seedMoleculasConocidas(pool);
}

// Si moleculas_conocidas está vacía pero importaciones ya tiene datos (tabla recién
// creada contra una base histórica ya cargada, o recreada desde cero), hay que sembrarla
// con todo lo que ya existe -- si no, recordNewMoleculas() trataría cada molécula
// histórica como "nueva" en la primera corrida después de crear la tabla, generando
// cientos de falsas alertas de golpe.
async function seedMoleculasConocidas(pool) {
  const { rows: countRows } = await pool.query(`SELECT COUNT(*) AS n FROM moleculas_conocidas`);
  if (Number(countRows[0].n) > 0) return;

  const { rows: existing } = await pool.query(
    `SELECT DISTINCT molecula, MIN(anio_mes) AS anio_mes
     FROM ${TABLE}
     WHERE molecula IS NOT NULL
     GROUP BY molecula`
  );
  if (existing.length === 0) return;

  for (const { molecula, anio_mes } of existing) {
    await pool.query(
      `INSERT INTO moleculas_conocidas (molecula, primer_anio_mes) VALUES ($1, $2)
       ON CONFLICT (molecula) DO NOTHING`,
      [molecula, anio_mes]
    );
  }
}

// Compara las moléculas presentes en `extractedRows` (ya con molecula/marca calculados)
// contra moleculas_conocidas y registra como novedad cualquiera que no se haya visto
// nunca antes. Pensado para llamarse una vez por mes/base procesado dentro de la misma
// transacción de replaceMonthData(), para que la detección de "nueva" quede consistente
// con lo que efectivamente se insertó.
async function recordNewMoleculas(client, anioMes, extractedRows) {
  const countByMolecula = new Map();
  for (const r of extractedRows) {
    if (!r.molecula) continue;
    countByMolecula.set(r.molecula, (countByMolecula.get(r.molecula) ?? 0) + 1);
  }
  if (countByMolecula.size === 0) return [];

  const moleculas = [...countByMolecula.keys()];
  const { rows: known } = await client.query(
    `SELECT molecula FROM moleculas_conocidas WHERE molecula = ANY($1)`,
    [moleculas]
  );
  const knownSet = new Set(known.map((r) => r.molecula));
  const nuevas = moleculas.filter((m) => !knownSet.has(m));
  if (nuevas.length === 0) return [];

  for (const molecula of nuevas) {
    await client.query(
      `INSERT INTO moleculas_conocidas (molecula, primer_anio_mes) VALUES ($1, $2)
       ON CONFLICT (molecula) DO NOTHING`,
      [molecula, anioMes]
    );
    await client.query(
      `INSERT INTO novedades (molecula, anio_mes, filas) VALUES ($1, $2, $3)`,
      [molecula, anioMes, countByMolecula.get(molecula)]
    );
  }
  return nuevas;
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
  const insertColumns = [...columns, 'anio_mes', 'molecula', 'marca', 'extraction_confidence', 'vital_no_disponible'];
  const columnList = insertColumns.map(quoteIdent).join(', ');

  const extractedRows = rows.map((row) => extractProductWithOverrides(row[DESC_COLUMN], overrides));
  const allValues = rows.map((row, i) => {
    const extracted = extractedRows[i];
    return [
      ...columns.map((c) => row[c] ?? null),
      anioMes,
      extracted.molecula,
      extracted.marca,
      extracted.confidence,
      extracted.vitalNoDisponible,
    ];
  });

  const client = await pool.connect();
  let nuevasMoleculas = [];
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

    nuevasMoleculas = await recordNewMoleculas(client, anioMes, extractedRows);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return { nuevasMoleculas };
}

// Últimas novedades (moléculas nunca antes vistas) para mostrar como alertas en el
// dashboard. limitDias acota a detecciones recientes; sin filtro de fecha se acumularían
// indefinidamente en la vista aunque ya se hayan revisado hace meses.
export async function getNovedades(limitDias = 30) {
  const pool = getPool();
  await ensureSchema();
  const { rows } = await pool.query(
    `SELECT molecula, anio_mes, filas, detectada_en
     FROM novedades
     WHERE detectada_en >= now() - ($1 || ' days')::interval
     ORDER BY detectada_en DESC`,
    [limitDias]
  );
  return rows;
}
