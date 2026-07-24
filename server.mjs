// Servidor del dashboard: lee de Supabase/Postgres y expone endpoints JSON de
// agregación consumidos por public/index.html. Uso local: npm run dashboard.
// En producción corre como función serverless en Vercel (ver api/index.js).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';
import { getPool } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TABLE = 'importaciones';
const PORT = process.env.PORT || 4321;

// Moléculas de interés particular para la empresa (focus-molecules.json). El matching
// contra "molecula" es por substring, sin distinguir mayúsculas/acentos, para agrupar
// variantes de dosis/forma bajo la misma palabra clave. Se resuelve contra los valores
// distintos ya presentes en la base y se cachea en memoria por CACHE_TTL_MS (en vez de
// una sola vez al arrancar), porque en Vercel cada invocación de función puede reusar o
// no la misma instancia -- un caché con expiración evita tanto recalcular en cada
// request como quedarse con una lista desactualizada indefinidamente.
const normalize = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
const CACHE_TTL_MS = 5 * 60 * 1000;
let focusCache = { data: null, expiresAt: 0 };
// Varios endpoints piden getFocusMoleculas() en paralelo en cada carga del dashboard
// (?focus=1 dispara 6 requests simultáneas); sin esto, cuando el caché está vacío o
// venció, las 6 verían focusCache.data como null a la vez y cada una dispararía su
// propia query -- multiplicando conexiones al pool justo cuando ya hay presión sobre
// él. Compartir la misma promesa en vuelo hace que solo la primera consulte la DB.
let focusPromise = null;

async function getFocusMoleculas() {
  if (focusCache.data && Date.now() < focusCache.expiresAt) return focusCache.data;
  if (focusPromise) return focusPromise;

  focusPromise = (async () => {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'focus-molecules.json'), 'utf8'));
    } catch {
      raw = { keywords: [] };
    }
    const keywords = (raw.keywords || []).map(normalize);

    const pool = getPool();
    const { rows } = await pool.query(`SELECT DISTINCT molecula FROM ${TABLE} WHERE molecula IS NOT NULL`);
    const matched = rows
      .map((r) => r.molecula)
      .filter((m) => {
        const n = normalize(m);
        return keywords.some((k) => n.includes(k));
      });

    const data = { keywords: raw.keywords || [], moleculas: matched };
    focusCache = { data, expiresAt: Date.now() + CACHE_TTL_MS };
    return data;
  })();

  try {
    return await focusPromise;
  } finally {
    focusPromise = null;
  }
}

// Los valores numéricos vienen como TEXT desde el Excel de Daater, a veces con coma
// decimal. REPLACE(x, ',', '.')::NUMERIC los normaliza para sumar/promediar.
const FOB = `REPLACE("Valor Fob (USD)", ',', '.')::NUMERIC`;
const CIF = `REPLACE("Valor Cif (USD)", ',', '.')::NUMERIC`;
const CANTIDAD = `REPLACE("Cantidad", ',', '.')::NUMERIC`;

// Arma la cláusula WHERE + params ($1, $2, ...) para los filtros de fecha y foco.
// focusMoleculas ya viene resuelto (ver getFocusMoleculas) para no hacer la consulta
// de moléculas de interés dentro de cada endpoint.
function dateFilter(req, focusMoleculas) {
  const { from, to } = req.query;
  const clauses = [];
  const params = [];
  if (from) {
    params.push(from);
    clauses.push(`anio_mes >= $${params.length}`);
  }
  if (to) {
    params.push(to);
    clauses.push(`anio_mes <= $${params.length}`);
  }
  if (req.query.focus === '1') {
    if (focusMoleculas.moleculas.length === 0) {
      // Ninguna molécula coincide: forzar un resultado vacío en vez de devolver todo.
      clauses.push('1 = 0');
    } else {
      params.push(focusMoleculas.moleculas);
      clauses.push(`molecula = ANY($${params.length})`);
    }
  }
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

export const app = express();
// chart.js se copia a public/vendor/chart.js (ver package.json "postinstall-vendor" o
// correr manualmente `cp node_modules/chart.js/dist/chart.umd.min.js public/vendor/`)
// en vez de servirse dinámicamente desde node_modules: el bundler de funciones
// serverless de Vercel no empaqueta archivos de node_modules a los que solo se accede
// vía ruta de filesystem en runtime (como hacía express.static aquí antes), así que el
// archivo no viajaba al deployment y /vendor/chart.js daba 404 en producción.
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/summary', async (req, res, next) => {
  try {
    const pool = getPool();
    const focusMoleculas = await getFocusMoleculas();
    const { where, params } = dateFilter(req, focusMoleculas);
    const { rows } = await pool.query(
      `SELECT COUNT(*) as filas, MIN(anio_mes) as desde, MAX(anio_mes) as hasta,
              SUM(${FOB}) as "fobTotal", SUM(${CIF}) as "cifTotal",
              COUNT(DISTINCT molecula) as moleculas, COUNT(DISTINCT "Importador (Razon social)") as importadores
       FROM ${TABLE} ${where}`,
      params
    );
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

app.get('/api/by-molecula', async (req, res, next) => {
  try {
    const pool = getPool();
    const focusMoleculas = await getFocusMoleculas();
    const { where, params } = dateFilter(req, focusMoleculas);
    const extra = where ? 'AND' : 'WHERE';
    const { rows } = await pool.query(
      `SELECT COALESCE(molecula, 'Sin clasificar') as molecula,
              COUNT(*) as filas, SUM(${FOB}) as fob, SUM(${CIF}) as cif, SUM(${CANTIDAD}) as cantidad
       FROM ${TABLE} ${where} ${extra} molecula IS NOT NULL
       GROUP BY molecula
       ORDER BY fob DESC
       LIMIT 25`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

app.get('/api/by-month', async (req, res, next) => {
  try {
    const pool = getPool();
    const focusMoleculas = await getFocusMoleculas();
    const { where, params } = dateFilter(req, focusMoleculas);
    const { rows } = await pool.query(
      `SELECT anio_mes, COUNT(*) as filas, SUM(${FOB}) as fob, SUM(${CIF}) as cif
       FROM ${TABLE} ${where}
       GROUP BY anio_mes
       ORDER BY anio_mes ASC`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

app.get('/api/by-tariff', async (req, res, next) => {
  try {
    const pool = getPool();
    const focusMoleculas = await getFocusMoleculas();
    const { where, params } = dateFilter(req, focusMoleculas);
    const { rows } = await pool.query(
      `SELECT "Partida Arancelaria (Documento)" as partida,
              "Partida Arancelaria (Razon social)" as descripcion,
              COUNT(*) as filas, SUM(${FOB}) as fob, SUM(${CIF}) as cif
       FROM ${TABLE} ${where}
       GROUP BY partida, descripcion
       ORDER BY fob DESC`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

app.get('/api/by-country', async (req, res, next) => {
  try {
    const pool = getPool();
    const focusMoleculas = await getFocusMoleculas();
    const { where, params } = dateFilter(req, focusMoleculas);
    const extra = where ? 'AND' : 'WHERE';
    const { rows } = await pool.query(
      `SELECT COALESCE("País origen", 'Sin dato') as pais,
              COUNT(*) as filas, SUM(${FOB}) as fob, SUM(${CIF}) as cif
       FROM ${TABLE} ${where} ${extra} "País origen" IS NOT NULL
       GROUP BY pais
       ORDER BY fob DESC
       LIMIT 15`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

app.get('/api/by-importer', async (req, res, next) => {
  try {
    const pool = getPool();
    const focusMoleculas = await getFocusMoleculas();
    const { where, params } = dateFilter(req, focusMoleculas);
    const extra = where ? 'AND' : 'WHERE';
    const { rows } = await pool.query(
      `SELECT "Importador (Razon social)" as importador,
              COUNT(*) as filas, SUM(${FOB}) as fob, SUM(${CIF}) as cif
       FROM ${TABLE} ${where} ${extra} "Importador (Razon social)" IS NOT NULL
       GROUP BY importador
       ORDER BY fob DESC
       LIMIT 15`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Detalle de envíos para una molécula puntual (usado al hacer click en la vista
// principal), con marca desglosada.
app.get('/api/molecula/:nombre', async (req, res, next) => {
  try {
    const pool = getPool();
    const focusMoleculas = await getFocusMoleculas();
    const { where, params } = dateFilter(req, focusMoleculas);
    const extra = where ? 'AND' : 'WHERE';
    params.push(req.params.nombre);
    const { rows } = await pool.query(
      `SELECT COALESCE(marca, 'Sin marca') as marca,
              COUNT(*) as filas, SUM(${FOB}) as fob, SUM(${CIF}) as cif
       FROM ${TABLE} ${where} ${extra} molecula = $${params.length}
       GROUP BY marca
       ORDER BY fob DESC`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

app.get('/api/focus-molecules', async (req, res, next) => {
  try {
    res.json(await getFocusMoleculas());
  } catch (err) {
    next(err);
  }
});

// Solo arranca un listener HTTP cuando se ejecuta directamente (npm run dashboard).
// En Vercel, api/index.js importa `app` y lo envuelve como función serverless sin
// llamar a listen(). La comparación se hace vía pathToFileURL (no interpolando
// process.argv[1] directo en un template "file://...") porque en Windows argv[1] usa
// backslashes y le falta el separador "///" que sí lleva import.meta.url -- una
// comparación de string ingenua nunca matchea ahí y el servidor jamás arranca.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const HOST = process.env.HOST || 'localhost';
  app.listen(PORT, HOST, () => {
    console.log(`Dashboard disponible en http://${HOST}:${PORT}`);
  });
}
