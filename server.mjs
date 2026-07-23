// Servidor local del dashboard: lee daater.db (solo lectura) y expone endpoints JSON
// de agregación consumidos por public/index.html. Uso: npm run dashboard.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import DatabaseConstructor from 'better-sqlite3';
import { config } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TABLE = 'importaciones';
const PORT = process.env.PORT || 4321;

// Solo lectura: el dashboard nunca debe escribir en daater.db, y así puede convivir
// con una corrida de "npm run search" en curso sin bloquearla.
const db = new DatabaseConstructor(config.dbFile, { readonly: true });

// Los valores numéricos vienen como TEXT desde el Excel de Daater, a veces con coma
// decimal. CAST(REPLACE(x, ',', '.') AS REAL) los normaliza para sumar/promediar.
const FOB = `CAST(REPLACE("Valor Fob (USD)", ',', '.') AS REAL)`;
const CIF = `CAST(REPLACE("Valor Cif (USD)", ',', '.') AS REAL)`;
const CANTIDAD = `CAST(REPLACE("Cantidad", ',', '.') AS REAL)`;

function dateFilter(req) {
  const { from, to } = req.query;
  const clauses = [];
  const params = [];
  if (from) {
    clauses.push('anio_mes >= ?');
    params.push(from);
  }
  if (to) {
    clauses.push('anio_mes <= ?');
    params.push(to);
  }
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

const app = express();
app.use(express.static('public'));
app.use(
  '/vendor/chart.js',
  express.static(path.join(__dirname, 'node_modules/chart.js/dist/chart.umd.min.js'))
);

app.get('/api/summary', (req, res) => {
  const { where, params } = dateFilter(req);
  const row = db
    .prepare(
      `SELECT COUNT(*) as filas, MIN(anio_mes) as desde, MAX(anio_mes) as hasta,
              SUM(${FOB}) as fobTotal, SUM(${CIF}) as cifTotal,
              COUNT(DISTINCT molecula) as moleculas, COUNT(DISTINCT "Importador (Razon social)") as importadores
       FROM ${TABLE} ${where}`
    )
    .get(...params);
  res.json(row);
});

app.get('/api/by-molecula', (req, res) => {
  const { where, params } = dateFilter(req);
  const extra = where ? 'AND' : 'WHERE';
  const rows = db
    .prepare(
      `SELECT COALESCE(molecula, 'Sin clasificar') as molecula,
              COUNT(*) as filas, SUM(${FOB}) as fob, SUM(${CIF}) as cif, SUM(${CANTIDAD}) as cantidad
       FROM ${TABLE} ${where} ${extra} molecula IS NOT NULL
       GROUP BY molecula
       ORDER BY fob DESC
       LIMIT 25`
    )
    .all(...params);
  res.json(rows);
});

app.get('/api/by-month', (req, res) => {
  const { where, params } = dateFilter(req);
  const rows = db
    .prepare(
      `SELECT anio_mes, COUNT(*) as filas, SUM(${FOB}) as fob, SUM(${CIF}) as cif
       FROM ${TABLE} ${where}
       GROUP BY anio_mes
       ORDER BY anio_mes ASC`
    )
    .all(...params);
  res.json(rows);
});

app.get('/api/by-tariff', (req, res) => {
  const { where, params } = dateFilter(req);
  const rows = db
    .prepare(
      `SELECT "Partida Arancelaria (Documento)" as partida,
              "Partida Arancelaria (Razon social)" as descripcion,
              COUNT(*) as filas, SUM(${FOB}) as fob, SUM(${CIF}) as cif
       FROM ${TABLE} ${where}
       GROUP BY partida
       ORDER BY fob DESC`
    )
    .all(...params);
  res.json(rows);
});

app.get('/api/by-country', (req, res) => {
  const { where, params } = dateFilter(req);
  const extra = where ? 'AND' : 'WHERE';
  const rows = db
    .prepare(
      `SELECT COALESCE("País origen", 'Sin dato') as pais,
              COUNT(*) as filas, SUM(${FOB}) as fob, SUM(${CIF}) as cif
       FROM ${TABLE} ${where} ${extra} "País origen" IS NOT NULL
       GROUP BY pais
       ORDER BY fob DESC
       LIMIT 15`
    )
    .all(...params);
  res.json(rows);
});

app.get('/api/by-importer', (req, res) => {
  const { where, params } = dateFilter(req);
  const extra = where ? 'AND' : 'WHERE';
  const rows = db
    .prepare(
      `SELECT "Importador (Razon social)" as importador,
              COUNT(*) as filas, SUM(${FOB}) as fob, SUM(${CIF}) as cif
       FROM ${TABLE} ${where} ${extra} "Importador (Razon social)" IS NOT NULL
       GROUP BY importador
       ORDER BY fob DESC
       LIMIT 15`
    )
    .all(...params);
  res.json(rows);
});

// Detalle de envíos para una molécula puntual (usado al hacer click en la vista
// principal), con marca desglosada.
app.get('/api/molecula/:nombre', (req, res) => {
  const { where, params } = dateFilter(req);
  const extra = where ? 'AND' : 'WHERE';
  const rows = db
    .prepare(
      `SELECT COALESCE(marca, 'Sin marca') as marca,
              COUNT(*) as filas, SUM(${FOB}) as fob, SUM(${CIF}) as cif
       FROM ${TABLE} ${where} ${extra} molecula = ?
       GROUP BY marca
       ORDER BY fob DESC`
    )
    .all(...params, req.params.nombre);
  res.json(rows);
});

const HOST = process.env.HOST || 'localhost';
app.listen(PORT, HOST, () => {
  console.log(`Dashboard disponible en http://${HOST}:${PORT}`);
});
