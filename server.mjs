// Servidor del dashboard: lee de Supabase/Postgres y expone endpoints JSON de
// agregación consumidos por public/index.html. Uso local: npm run dashboard.
// En producción corre como función serverless en Vercel (ver api/index.js).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';
import { getPool, getNovedades } from './db.js';

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
      condicionDetallada: k.condicionDetallada,
    }));

    // Mapa sigla -> nombre completo (ej. "FQ" -> "Fibrosis Quística"), para mostrar el
    // nombre detallado de la enfermedad en el dashboard sin reemplazar la sigla corta
    // usada como identificador funcional en agrupación/filtros/breadcrumb. Varias
    // keywords comparten condicion (misma sigla), así que solo hace falta una entrada
    // por sigla, no por keyword.
    const nombreDetalladoPorCondicion = {};
    for (const e of entries) {
      if (e.condicionDetallada && !nombreDetalladoPorCondicion[e.condicion]) {
        nombreDetalladoPorCondicion[e.condicion] = e.condicionDetallada;
      }
    }

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
      nombreDetalladoPorCondicion,
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

// Arma la cláusula WHERE + params ($1, $2, ...) para los filtros de fecha, foco y
// Medicamento Vital No Disponible (MVND, ver product-extractor.js isVitalNoDisponible).
// focusMoleculas ya viene resuelto (ver getFocusMoleculas) para no hacer la consulta
// de moléculas de interés dentro de cada endpoint. applyFocus=false hace que se ignore
// ?focus= por completo (usado por /api/by-condicion y /api/condicion/:nombre, que ya
// filtran explícitamente a un subconjunto de moléculas propio y no deben añadir además
// la cláusula `molecula = ANY(...)` genérica de foco encima).
// ?vital=exclude|only controla el selector de 3 estados del dashboard: sin el parámetro
// (o cualquier otro valor) no filtra por este campo, 'exclude' saca los envíos MVND
// (importación a nombre de paciente individual, no comercial) y 'only' aísla solo esos.
function dateFilter(req, focusMoleculas, applyFocus = true) {
  const { from, to, vital } = req.query;
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
  if (vital === 'exclude') {
    clauses.push(`(vital_no_disponible IS NOT TRUE)`);
  } else if (vital === 'only') {
    clauses.push(`vital_no_disponible IS TRUE`);
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
              COUNT(DISTINCT molecula) as moleculas, COUNT(DISTINCT "Importador (Razon social)") as importadores,
              COUNT(*) FILTER (WHERE vital_no_disponible IS TRUE) as "vitalNoDisponible"
       FROM ${TABLE} ${where}`,
      params
    );
    // Fecha máxima real (columna "Fecha", no el mes anio_mes) sobre TODA la tabla, sin
    // aplicar los filtros de rango/foco de este request -- es el "corte" de los datos
    // cargados, no algo que deba cambiar según lo que el usuario esté filtrando.
    const { rows: corte } = await pool.query(
      `SELECT MAX("Fecha") as "ultimaFecha" FROM ${TABLE}`
    );
    res.json({ ...rows[0], ultimaFecha: corte[0].ultimaFecha });
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

const TOP_SERIES_IN_MONTH_CHART = 5;

// Agrega FOB mensual por una columna (marca o molecula) dentro del recorte ya filtrado
// por where/extraWhere/params, quedándose con las top N por FOB total y agrupando el
// resto en "Otras" -- usado para no saturar la gráfica de líneas con una serie por cada
// valor distinto. `total` son las filas ya agregadas por mes (para tomar la lista de
// meses del período), `groupCol` es la columna real de la tabla ('marca' o 'molecula').
async function computeBreakdownSeries(pool, groupCol, where, extraWhere, params, total) {
  const { rows: groupTotals } = await pool.query(
    `SELECT COALESCE(${groupCol}, 'Sin clasificar') as nombre, SUM(${FOB}) as fob
     FROM ${TABLE} ${where} ${extraWhere}
     GROUP BY nombre
     ORDER BY fob DESC`,
    params
  );
  const topNames = groupTotals.slice(0, TOP_SERIES_IN_MONTH_CHART).map((r) => r.nombre);
  const { rows: monthly } = await pool.query(
    `SELECT anio_mes, COALESCE(${groupCol}, 'Sin clasificar') as nombre, SUM(${FOB}) as fob
     FROM ${TABLE} ${where} ${extraWhere}
     GROUP BY anio_mes, nombre`,
    params
  );
  const meses = total.map((r) => r.anio_mes);
  const series = topNames.map((nombre) => ({
    nombre,
    data: meses.map((m) => {
      const row = monthly.find((r) => r.anio_mes === m && r.nombre === nombre);
      return row ? Number(row.fob) : 0;
    }),
  }));
  if (groupTotals.length > TOP_SERIES_IN_MONTH_CHART) {
    series.push({
      nombre: 'Otras',
      data: meses.map((m) =>
        monthly
          .filter((r) => r.anio_mes === m && !topNames.includes(r.nombre))
          .reduce((sum, r) => sum + Number(r.fob), 0)
      ),
    });
  }
  return { meses, series };
}

// Igual que computeBreakdownSeries pero agrupando por condición/área terapéutica en vez
// de una columna real de la tabla -- condicion no existe como columna, así que se trae
// el FOB mensual por molécula (limitado al conjunto de moléculas de interés) y se
// reagrupa en JS vía condicionPorMolecula, igual que hace /api/by-condicion. No hay
// "Otras" aquí: el conjunto de condiciones ya es acotado (focus-molecules.json).
async function computeCondicionBreakdown(pool, focusMoleculas, where, extraWhere, params, total) {
  const { rows: monthly } = await pool.query(
    `SELECT anio_mes, molecula, SUM(${FOB}) as fob
     FROM ${TABLE} ${where} ${extraWhere}
     GROUP BY anio_mes, molecula`,
    params
  );
  const meses = total.map((r) => r.anio_mes);
  const porCondicion = new Map();
  for (const r of monthly) {
    const condicion = focusMoleculas.condicionPorMolecula[r.molecula] ?? 'Sin condición';
    if (!porCondicion.has(condicion)) porCondicion.set(condicion, new Map());
    const porMes = porCondicion.get(condicion);
    porMes.set(r.anio_mes, (porMes.get(r.anio_mes) ?? 0) + Number(r.fob));
  }
  const series = [...porCondicion.entries()]
    .map(([nombre, porMes]) => ({ nombre, data: meses.map((m) => porMes.get(m) ?? 0) }))
    .sort((a, b) => b.data.reduce((s, v) => s + v, 0) - a.data.reduce((s, v) => s + v, 0));
  return { meses, series };
}

// ?condicion= y/o ?molecula= restringen la evolución mensual al recorte que el
// usuario esté viendo en el drill-down de Condición -> Molécula -> Marca, para que la
// gráfica de evolución siga lo que se está explorando en vez de mostrar siempre el
// total general. condicion se resuelve vía condicionPorMolecula (igual que
// /api/by-condicion), ya que no es una columna real de la tabla. ?level=condicion marca
// el nivel raíz del drill-down (con foco activo, comparando áreas terapéuticas), donde
// no hay ni condicion ni molecula seleccionada todavía.
//
// Además del total, se calcula un desglose mensual por líneas: por condición a nivel
// raíz (?level=condicion), por marca cuando ya hay una molécula puntual seleccionada
// (?molecula=), o por molécula en cualquier otro caso (condición seleccionada, o vista
// general/búsqueda sin drill-down) -- top N por FOB total, agrupando el resto en
// "Otras" para no saturar la gráfica de líneas (excepto el desglose por condición, que
// no agrupa "Otras" al ser un conjunto ya acotado).
app.get('/api/by-month', async (req, res, next) => {
  try {
    const pool = getPool();
    const focusMoleculas = await getFocusMoleculas();
    const { where, params } = dateFilter(req, focusMoleculas);
    const clauses = [];

    const molecula = (req.query.molecula || '').trim();
    const isCondicionLevel = !molecula && req.query.level === 'condicion';
    if (molecula) {
      params.push(molecula);
      clauses.push(`molecula = $${params.length}`);
    } else {
      const condicion = (req.query.condicion || '').trim();
      if (condicion) {
        const moleculasDeCondicion = focusMoleculas.moleculas.filter(
          (m) => (focusMoleculas.condicionPorMolecula[m] ?? 'Sin condición') === condicion
        );
        if (moleculasDeCondicion.length === 0) {
          res.json({ total: [], breakdown: null });
          return;
        }
        params.push(moleculasDeCondicion);
        clauses.push(`molecula = ANY($${params.length})`);
      }
    }

    const extra = where ? 'AND' : 'WHERE';
    const extraWhere = clauses.length ? `${extra} ${clauses.join(' AND ')}` : '';
    const { rows: total } = await pool.query(
      `SELECT anio_mes, COUNT(*) as filas, SUM(${FOB}) as fob, SUM(${CIF}) as cif
       FROM ${TABLE} ${where} ${extraWhere}
       GROUP BY anio_mes
       ORDER BY anio_mes ASC`,
      params
    );

    let breakdown = null;
    if (total.length) {
      if (isCondicionLevel) {
        breakdown = { by: 'condicion', ...(await computeCondicionBreakdown(pool, focusMoleculas, where, extraWhere, params, total)) };
      } else {
        const groupCol = molecula ? 'marca' : 'molecula';
        breakdown = { by: groupCol, ...(await computeBreakdownSeries(pool, groupCol, where, extraWhere, params, total)) };
      }
    }

    res.json({ total, breakdown });
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

// Alertas de moléculas nunca antes vistas (ver db.js recordNewMoleculas), detectadas en
// las últimas ?dias (default 30). Usado por la sección "Novedades" del dashboard.
app.get('/api/novedades', async (req, res, next) => {
  try {
    const dias = Number(req.query.dias) || 30;
    res.json(await getNovedades(dias));
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
