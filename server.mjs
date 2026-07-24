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
// Equivalente SQL de normalize() de arriba, sin depender de la extensión unaccent de
// Postgres (no siempre habilitable en el proyecto de Supabase) -- solo cubre los
// acentos/diéresis que de hecho aparecen en nombres de molécula en español.
const UNACCENT_SQL = `TRANSLATE(UPPER($COL$), 'ÁÉÍÓÚÀÈÌÒÙÄËÏÖÜÑ', 'AEIOUAEIOUAEIOUN')`;
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
    const entries = (raw.keywords || []).map((k) => ({
      keyword: normalize(k.keyword),
      condicion: k.condicion,
    }));

    const pool = getPool();
    const { rows } = await pool.query(`SELECT DISTINCT molecula FROM ${TABLE} WHERE molecula IS NOT NULL`);
    const moleculas = [];
    // Mapa molecula -> condición, para el primer nivel de desglose (Condición ->
    // Molécula -> Marca) del dashboard. Varias keywords pueden compartir condición (ej.
    // Estiripentol y Fenfluramina, ambas Dravet), así que se agrupa por condicion, no
    // por keyword individual. Si una misma molécula matchea más de una keyword, se
    // queda con la primera condición encontrada (orden de focus-molecules.json).
    const condicionPorMolecula = {};
    for (const r of rows) {
      const m = r.molecula;
      const n = normalize(m);
      const entry = entries.find((e) => n.includes(e.keyword));
      if (entry) {
        moleculas.push(m);
        condicionPorMolecula[m] = entry.condicion;
      }
    }

    const data = {
      keywords: (raw.keywords || []).map((k) => k.keyword),
      moleculas,
      condicionPorMolecula,
    };
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
// de moléculas de interés dentro de cada endpoint. applyFocus=false hace que se ignore
// ?focus= por completo (usado por /api/by-condicion y /api/condicion/:nombre, que ya
// filtran explícitamente a un subconjunto de moléculas propio y no deben añadir además
// la cláusula `molecula = ANY(...)` genérica de foco encima).
function dateFilter(req, focusMoleculas, applyFocus = true) {
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
  if (applyFocus && req.query.focus === '1') {
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

// Primer nivel de desglose cuando el toggle de foco está activo: agrupa por la
// condición/enfermedad asociada a cada molécula de interés (focus-molecules.json),
// no por molecula misma. Ignora ?focus= -- esta vista solo tiene sentido para el
// conjunto de moléculas de interés, así que siempre filtra a ese conjunto.
app.get('/api/by-condicion', async (req, res, next) => {
  try {
    const pool = getPool();
    const focusMoleculas = await getFocusMoleculas();
    const { where, params } = dateFilter(req, focusMoleculas, false);
    const extra = where ? 'AND' : 'WHERE';

    if (focusMoleculas.moleculas.length === 0) {
      res.json([]);
      return;
    }
    params.push(focusMoleculas.moleculas);
    const { rows } = await pool.query(
      `SELECT molecula,
              COUNT(*) as filas, SUM(${FOB}) as fob, SUM(${CIF}) as cif
       FROM ${TABLE} ${where} ${extra} molecula = ANY($${params.length})
       GROUP BY molecula`,
      params
    );

    // Agregación por condición se hace en JS, no en SQL, porque el mapeo
    // molecula -> condicion vive en focus-molecules.json (JS), no en una columna de
    // la tabla -- no hay forma de hacer este GROUP BY directamente en Postgres.
    const porCondicion = new Map();
    for (const r of rows) {
      const condicion = focusMoleculas.condicionPorMolecula[r.molecula] ?? 'Sin condición';
      const acc = porCondicion.get(condicion) ?? { condicion, filas: 0, fob: 0, cif: 0 };
      acc.filas += Number(r.filas);
      acc.fob += Number(r.fob ?? 0);
      acc.cif += Number(r.cif ?? 0);
      porCondicion.set(condicion, acc);
    }
    const result = [...porCondicion.values()].sort((a, b) => b.fob - a.fob);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// Segundo nivel: desglose por molécula dentro de una condición puntual (click en una
// barra de /api/by-condicion). Reutiliza el mismo mapeo condicionPorMolecula.
app.get('/api/condicion/:nombre', async (req, res, next) => {
  try {
    const pool = getPool();
    const focusMoleculas = await getFocusMoleculas();
    const { where, params } = dateFilter(req, focusMoleculas, false);
    const extra = where ? 'AND' : 'WHERE';

    const moleculasDeCondicion = focusMoleculas.moleculas.filter(
      (m) => (focusMoleculas.condicionPorMolecula[m] ?? 'Sin condición') === req.params.nombre
    );
    if (moleculasDeCondicion.length === 0) {
      res.json([]);
      return;
    }
    params.push(moleculasDeCondicion);
    const { rows } = await pool.query(
      `SELECT molecula,
              COUNT(*) as filas, SUM(${FOB}) as fob, SUM(${CIF}) as cif, SUM(${CANTIDAD}) as cantidad
       FROM ${TABLE} ${where} ${extra} molecula = ANY($${params.length})
       GROUP BY molecula
       ORDER BY fob DESC`,
      params
    );
    res.json(rows);
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
    const clauses = ['molecula IS NOT NULL'];
    // Búsqueda libre por nombre: substring insensible a mayúsculas/acentos, igual que
    // el matching de focus-molecules.json (normalize + unaccent), en vez de exigir
    // coincidencia exacta -- el usuario puede escribir "eculizumab" o "eculizu" y
    // encontrar variantes de dosis/forma como "ECULIZUMAB (400MG)".
    const q = (req.query.q || '').trim();
    if (q) {
      params.push(`%${normalize(q)}%`);
      clauses.push(`${UNACCENT_SQL.replace('$COL$', 'molecula')} LIKE $${params.length}`);
    }
    const { rows } = await pool.query(
      `SELECT COALESCE(molecula, 'Sin clasificar') as molecula,
              COUNT(*) as filas, SUM(${FOB}) as fob, SUM(${CIF}) as cif, SUM(${CANTIDAD}) as cantidad
       FROM ${TABLE} ${where} ${extra} ${clauses.join(' AND ')}
       GROUP BY molecula
       ORDER BY fob DESC
       ${q ? '' : 'LIMIT 25'}`,
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
