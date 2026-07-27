const fmtUSD = (n) => (n == null ? '—' : new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n));
const fmtInt = (n) => (n == null ? '—' : new Intl.NumberFormat('es-CO').format(n));
const fmtUSDCompact = (n) =>
  n == null
    ? '—'
    : new Intl.NumberFormat('es-CO', {
        style: 'currency',
        currency: 'USD',
        notation: 'compact',
        maximumFractionDigits: 1,
      }).format(n);

const root = document.documentElement;
const isDark = () =>
  root.getAttribute('data-theme') === 'dark' ||
  (root.getAttribute('data-theme') !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);

function cssVar(name) {
  return getComputedStyle(document.querySelector('.viz-root')).getPropertyValue(name).trim();
}

const seriesColors = () => [1, 2, 3, 4, 5, 6, 7, 8].map((i) => cssVar(`--series-${i}`));

function chartDefaults() {
  const grid = cssVar('--gridline');
  const muted = cssVar('--text-muted');
  const text = cssVar('--text-secondary');
  Chart.defaults.font.family = 'system-ui, -apple-system, "Segoe UI", sans-serif';
  Chart.defaults.color = text;
  Chart.defaults.borderColor = grid;
  return { grid, muted, text };
}

let state = { from: '', to: '', focus: true, q: '' };
const charts = {};
const lastData = {};

function qs(params) {
  const p = new URLSearchParams();
  if (params.from) p.set('from', params.from);
  if (params.to) p.set('to', params.to);
  if (params.focus) p.set('focus', '1');
  const s = p.toString();
  return s ? `?${s}` : '';
}

// Igual que qs(), más condicion/molecula/level del drill-down actual — usado solo por
// /api/by-month para que la evolución mensual siga el recorte que se esté explorando.
// level='condicion' (el nivel raíz cuando el foco está activo, comparando áreas
// terapéuticas) le indica al backend que desglose por condición en vez de por molécula,
// ya que en ese nivel path no trae ni condicion ni molecula seleccionada.
function monthQs(params) {
  const p = new URLSearchParams();
  if (params.from) p.set('from', params.from);
  if (params.to) p.set('to', params.to);
  if (params.focus) p.set('focus', '1');
  if (moleculaView.path.molecula) p.set('molecula', moleculaView.path.molecula);
  else if (moleculaView.path.condicion) p.set('condicion', moleculaView.path.condicion);
  else if (moleculaView.level === 'condicion') p.set('level', 'condicion');
  const s = p.toString();
  return s ? `?${s}` : '';
}

function moleculaQs(params) {
  const p = new URLSearchParams();
  if (params.from) p.set('from', params.from);
  if (params.to) p.set('to', params.to);
  if (params.focus) p.set('focus', '1');
  if (params.q) p.set('q', params.q);
  const s = p.toString();
  return s ? `?${s}` : '';
}

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

function renderStatRow(summary) {
  const tiles = [
    { label: 'Filas cargadas', value: fmtInt(summary.filas) },
    { label: 'Valor FOB total', value: fmtUSDCompact(summary.fobTotal), title: fmtUSD(summary.fobTotal) },
    { label: 'Valor CIF total', value: fmtUSDCompact(summary.cifTotal), title: fmtUSD(summary.cifTotal) },
    { label: 'Moléculas distintas', value: fmtInt(summary.moleculas) },
    { label: 'Importadores distintos', value: fmtInt(summary.importadores) },
    { label: 'Rango cargado', value: `${summary.desde ?? '—'} a ${summary.hasta ?? '—'}` },
  ];
  document.getElementById('statRow').innerHTML = tiles
    .map(
      (t) =>
        `<div class="stat-tile"><div class="label">${t.label}</div><div class="value"${t.title ? ` title="${t.title}"` : ''}>${t.value}</div></div>`
    )
    .join('');
}

function destroyChart(id) {
  if (charts[id]) {
    charts[id].destroy();
    delete charts[id];
  }
}

// Estado del drill-down de 3 niveles Condición -> Molécula -> Marca (solo el primer
// nivel aplica cuando el toggle de foco está activo; sin foco, se comporta como antes:
// arranca directo en "molecula", top 25 o resultados de búsqueda libre).
// level: 'condicion' | 'molecula' | 'marca'. path guarda el nombre elegido en cada
// nivel superior, para poder reconstruir el breadcrumb y volver atrás.
let moleculaView = { level: 'molecula', path: {} };

// Alto de barra + separación entre categorías, en px — se usa tanto para el grosor
// real de la barra (categoryPercentage/barPercentage) como para calcular el alto del
// contenedor, de forma que el desglose por marca/molécula (que puede traer 20-30+
// filas) quepa sin scroll interno del canvas ni forzar scroll de página.
const BAR_ROW_HEIGHT = 20;
const BAR_CHART_MIN_HEIGHT = 260;

function renderMoleculaBarChart(rows, labelKey, onBarClick) {
  destroyChart('moleculaChart');
  const { grid } = chartDefaults();
  const colors = seriesColors();
  const ctx = document.getElementById('moleculaChart');
  ctx.parentElement.style.height = `${Math.max(BAR_CHART_MIN_HEIGHT, rows.length * BAR_ROW_HEIGHT)}px`;
  charts.moleculaChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: rows.map((r) => r[labelKey]),
      datasets: [
        {
          label: 'Valor FOB (USD)',
          data: rows.map((r) => r.fob),
          backgroundColor: rows.map((_, i) => colors[i % colors.length]),
          borderRadius: 3,
          maxBarThickness: 14,
          categoryPercentage: 0.9,
          barPercentage: 0.9,
        },
      ],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      onClick: onBarClick
        ? (evt, elements) => {
            if (!elements.length) return;
            onBarClick(rows[elements[0].index]);
          }
        : undefined,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => `FOB: ${fmtUSD(ctx.raw)} · ${fmtInt(rows[ctx.dataIndex].filas)} envíos`,
          },
        },
      },
      scales: {
        x: { grid: { color: grid }, ticks: { callback: (v) => fmtUSD(v) } },
        y: { grid: { display: false }, ticks: { autoSkip: false, font: { size: 10 } } },
      },
    },
  });
}

function renderMoleculaBreadcrumb() {
  const el = document.getElementById('moleculaBreadcrumb');
  const parts = [];
  if (moleculaView.level === 'condicion') {
    el.style.display = 'none';
    return;
  }
  if (state.focus) parts.push({ label: 'Condiciones', action: () => goToLevel('condicion') });
  if (moleculaView.level === 'marca') {
    parts.push({ label: moleculaView.path.condicion ? moleculaView.path.condicion : 'Moléculas', action: () => goToLevel('molecula') });
  }
  if (!parts.length) {
    el.style.display = 'none';
    return;
  }
  el.style.display = 'block';
  el.innerHTML = parts.map((p, i) => `<button data-idx="${i}">&larr; Volver a ${p.label}</button>`).join(' · ');
  [...el.querySelectorAll('button')].forEach((btn, i) => btn.addEventListener('click', parts[i].action));
}

function goToLevel(level) {
  if (level === 'condicion') {
    moleculaView = { level: 'condicion', path: {} };
    loadCondicionChart();
  } else if (level === 'molecula') {
    const condicion = moleculaView.path.condicion;
    moleculaView = { level: 'molecula', path: { condicion } };
    if (condicion) loadMoleculasOfCondicion(condicion);
    else loadMoleculaChart();
  }
}

async function loadCondicionChart() {
  moleculaView = { level: 'condicion', path: {} };
  const rows = await fetchJSON(`/api/by-condicion${qs(state)}`);
  document.getElementById('moleculaTitle').textContent = 'Importaciones por condición';
  document.getElementById('moleculaSubtitle').textContent = 'Click en una barra para ver el desglose por molécula.';
  renderMoleculaBreadcrumb();
  renderMoleculaBarChart(rows, 'condicion', (row) => loadMoleculasOfCondicion(row.condicion));
  renderTable('moleculaTable', ['Condición', 'Filas', 'FOB', 'CIF'], rows.map((r) => [r.condicion, fmtInt(r.filas), fmtUSD(r.fob), fmtUSD(r.cif)]));
  loadMonthChart();
}

async function loadMoleculasOfCondicion(condicion) {
  moleculaView = { level: 'molecula', path: { condicion } };
  const rows = await fetchJSON(`/api/condicion/${encodeURIComponent(condicion)}${qs(state)}`);
  document.getElementById('moleculaTitle').textContent = `${condicion} — desglose por molécula`;
  document.getElementById('moleculaSubtitle').textContent = 'Click en una barra para ver el desglose por marca.';
  renderMoleculaBreadcrumb();
  renderMoleculaBarChart(rows, 'molecula', (row) => drillIntoMolecula(row.molecula, condicion));
  renderTable('moleculaTable', ['Molécula', 'Filas', 'FOB', 'CIF'], rows.map((r) => [r.molecula, fmtInt(r.filas), fmtUSD(r.fob), fmtUSD(r.cif)]));
  loadMonthChart();
}

async function drillIntoMolecula(nombre, condicion) {
  moleculaView = { level: 'marca', path: { condicion, molecula: nombre } };
  const rows = await fetchJSON(`/api/molecula/${encodeURIComponent(nombre)}${qs(state)}`);
  document.getElementById('moleculaTitle').textContent = `${nombre} — desglose por marca`;
  document.getElementById('moleculaSubtitle').textContent = '';
  renderMoleculaBreadcrumb();
  renderMoleculaBarChart(rows, 'marca');
  renderTable('moleculaTable', ['Marca', 'Filas', 'FOB', 'CIF'], rows.map((r) => [r.marca, fmtInt(r.filas), fmtUSD(r.fob), fmtUSD(r.cif)]));
  loadMonthChart();
}

// Punto de entrada del bloque de moléculas: con foco activo y sin búsqueda de texto,
// arranca en el nivel de condición (primer nivel de la jerarquía); si hay búsqueda
// libre o el foco está apagado, arranca directo en molécula (comportamiento previo).
async function loadMoleculaChart() {
  if (state.focus && !state.q) {
    await loadCondicionChart();
    return;
  }
  moleculaView = { level: 'molecula', path: {} };
  const rows = await fetchJSON(`/api/by-molecula${moleculaQs(state)}`);
  document.getElementById('moleculaTitle').textContent = 'Importaciones por molécula (principio activo)';
  document.getElementById('moleculaSubtitle').textContent = state.q
    ? `Resultados para "${state.q}". Click en una barra para ver el desglose por marca.`
    : 'Top 25 por valor FOB. Click en una barra para ver el desglose por marca.';
  renderMoleculaBreadcrumb();
  renderMoleculaBarChart(rows, 'molecula', (row) => {
    if (row.molecula !== 'Sin clasificar') drillIntoMolecula(row.molecula);
  });
  renderTable('moleculaTable', ['Molécula', 'Filas', 'FOB', 'CIF'], rows.map((r) => [r.molecula, fmtInt(r.filas), fmtUSD(r.fob), fmtUSD(r.cif)]));
  loadMonthChart();
}

async function loadMonthChart() {
  const { total, breakdown } = await fetchJSON(`/api/by-month${monthQs(state)}`);
  const label = moleculaView.path.molecula || moleculaView.path.condicion;
  document.getElementById('monthSubtitle').textContent = label
    ? `Valor FOB y CIF importado por mes — ${label}.`
    : 'Valor FOB y CIF importado por mes.';
  renderMonthChart(total, breakdown);
}

// breakdown (ver /api/by-month) trae una línea de FOB por cada uno de los top N valores
// de la columna relevante en el nivel actual del drill-down -- por marca cuando ya hay
// una molécula puntual seleccionada, o por molécula en cualquier otro caso (condición o
// vista general) -- más una serie "Otras" agrupando el resto. Reemplaza la vista de
// FOB/CIF total, ya que ambas no caben con claridad en la misma gráfica de líneas.
function renderMonthChart(rows, breakdown) {
  lastData.month = rows;
  destroyChart('monthChart');
  const { grid } = chartDefaults();
  const colors = seriesColors();
  const ctx = document.getElementById('monthChart');

  const datasets =
    breakdown && breakdown.series.length
      ? breakdown.series.map((s, i) => ({
          label: s.nombre,
          data: s.data,
          borderColor: colors[i % colors.length],
          backgroundColor: 'transparent',
          tension: 0.25,
          pointRadius: 3,
          borderWidth: 2,
        }))
      : [
          {
            label: 'FOB',
            data: rows.map((r) => r.fob),
            borderColor: colors[0],
            backgroundColor: colors[0] + '33',
            fill: true,
            tension: 0.25,
            pointRadius: 3,
            borderWidth: 2,
          },
          {
            label: 'CIF',
            data: rows.map((r) => r.cif),
            borderColor: colors[1],
            backgroundColor: 'transparent',
            tension: 0.25,
            pointRadius: 3,
            borderWidth: 2,
          },
        ];

  charts.monthChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: (breakdown ? breakdown.meses : rows.map((r) => r.anio_mes)),
      datasets,
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'top', align: 'end', labels: { boxWidth: 10, boxHeight: 10 } },
        tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${fmtUSD(ctx.raw)}` } },
      },
      scales: {
        x: { grid: { display: false } },
        y: { grid: { color: grid }, ticks: { callback: (v) => fmtUSD(v) } },
      },
    },
  });

  if (breakdown && breakdown.series.length) {
    const headers = ['Mes', ...breakdown.series.map((s) => s.nombre)];
    const tableRows = breakdown.meses.map((m, i) => [m, ...breakdown.series.map((s) => fmtUSD(s.data[i]))]);
    renderTable('monthTable', headers, tableRows);
  } else {
    renderTable('monthTable', ['Mes', 'Filas', 'FOB', 'CIF'], rows.map((r) => [r.anio_mes, fmtInt(r.filas), fmtUSD(r.fob), fmtUSD(r.cif)]));
  }
}

function renderSimpleBar(canvasId, tableId, rows, labelKey) {
  lastData[canvasId] = rows;
  destroyChart(canvasId);
  const { grid } = chartDefaults();
  const colors = seriesColors();
  const ctx = document.getElementById(canvasId);
  charts[canvasId] = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: rows.map((r) => r[labelKey]),
      datasets: [
        {
          label: 'Valor FOB (USD)',
          data: rows.map((r) => r.fob),
          backgroundColor: rows.map((_, i) => colors[i % colors.length]),
          borderRadius: 4,
          maxBarThickness: 26,
        },
      ],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (ctx) => `FOB: ${fmtUSD(ctx.raw)} · ${fmtInt(rows[ctx.dataIndex].filas)} envíos` } },
      },
      scales: {
        x: { grid: { color: grid }, ticks: { callback: (v) => fmtUSD(v) } },
        y: { grid: { display: false }, ticks: { autoSkip: false } },
      },
    },
  });
  renderTable(tableId, ['Nombre', 'Filas', 'FOB', 'CIF'], rows.map((r) => [r[labelKey], fmtInt(r.filas), fmtUSD(r.fob), fmtUSD(r.cif)]));
}

function renderTable(tableId, headers, rows) {
  const table = document.getElementById(tableId);
  table.innerHTML =
    `<thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead>` +
    `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody>`;
}

async function loadAll() {
  const [summary, , tariff, country, importer] = await Promise.all([
    fetchJSON(`/api/summary${qs(state)}`),
    loadMoleculaChart(),
    fetchJSON(`/api/by-tariff${qs(state)}`),
    fetchJSON(`/api/by-country${qs(state)}`),
    fetchJSON(`/api/by-importer${qs(state)}`),
  ]);
  renderStatRow(summary);
  renderSimpleBar('tariffChart', 'tariffTable', tariff, 'partida');
  renderSimpleBar('countryChart', 'countryTable', country, 'pais');
  renderSimpleBar('importerChart', 'importerTable', importer, 'importador');
}

document.getElementById('applyFilter').addEventListener('click', () => {
  state.from = document.getElementById('fromInput').value;
  state.to = document.getElementById('toInput').value;
  loadAll();
});
document.getElementById('clearFilter').addEventListener('click', () => {
  document.getElementById('fromInput').value = '';
  document.getElementById('toInput').value = '';
  document.getElementById('moleculaSearch').value = '';
  state = { from: '', to: '', focus: state.focus, q: '' };
  loadAll();
});
document.getElementById('focusToggle').addEventListener('change', (e) => {
  state.focus = e.target.checked;
  loadAll();
});
let moleculaSearchTimer = null;
document.getElementById('moleculaSearch').addEventListener('input', (e) => {
  state.q = e.target.value.trim();
  clearTimeout(moleculaSearchTimer);
  moleculaSearchTimer = setTimeout(loadMoleculaChart, 300);
});

document.getElementById('secondaryTabs').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-tab]');
  if (!btn) return;
  document.querySelectorAll('#secondaryTabs button').forEach((b) => b.classList.toggle('active', b === btn));
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === `panel-${btn.dataset.tab}`));
});

document.querySelectorAll('.table-toggle').forEach((btn) => {
  btn.addEventListener('click', () => {
    const key = btn.dataset.toggle;
    const canvasMap = { molecula: 'moleculaChart', month: 'monthChart', tariff: 'tariffChart', country: 'countryChart', importer: 'importerChart' };
    const tableMap = { molecula: 'moleculaTable', month: 'monthTable', tariff: 'tariffTable', country: 'countryTable', importer: 'importerTable' };
    const canvas = document.getElementById(canvasMap[key]);
    const table = document.getElementById(tableMap[key]);
    const showingTable = table.style.display !== 'none';
    table.style.display = showingTable ? 'none' : 'table';
    canvas.parentElement.style.display = showingTable ? 'block' : 'none';
    btn.textContent = showingTable ? 'Ver tabla' : 'Ver gráfico';
  });
});

loadAll().catch((err) => {
  console.error(err);
  document.querySelector('.page').insertAdjacentHTML('afterbegin', `<div class="empty-state">No se pudo cargar el dashboard: ${err.message}</div>`);
});
