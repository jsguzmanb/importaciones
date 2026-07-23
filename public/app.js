const fmtUSD = (n) => (n == null ? '—' : new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n));
const fmtInt = (n) => (n == null ? '—' : new Intl.NumberFormat('es-CO').format(n));

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

let state = { from: '', to: '' };
const charts = {};
const lastData = {};

function qs(params) {
  const p = new URLSearchParams();
  if (params.from) p.set('from', params.from);
  if (params.to) p.set('to', params.to);
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
    { label: 'Valor FOB total', value: fmtUSD(summary.fobTotal) },
    { label: 'Valor CIF total', value: fmtUSD(summary.cifTotal) },
    { label: 'Moléculas distintas', value: fmtInt(summary.moleculas) },
    { label: 'Importadores distintos', value: fmtInt(summary.importadores) },
    { label: 'Rango cargado', value: `${summary.desde ?? '—'} a ${summary.hasta ?? '—'}` },
  ];
  document.getElementById('statRow').innerHTML = tiles
    .map((t) => `<div class="stat-tile"><div class="label">${t.label}</div><div class="value">${t.value}</div></div>`)
    .join('');
}

function destroyChart(id) {
  if (charts[id]) {
    charts[id].destroy();
    delete charts[id];
  }
}

function renderMoleculaChart(rows) {
  lastData.molecula = rows;
  destroyChart('moleculaChart');
  const { grid } = chartDefaults();
  const colors = seriesColors();
  const ctx = document.getElementById('moleculaChart');
  charts.moleculaChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: rows.map((r) => r.molecula),
      datasets: [
        {
          label: 'Valor FOB (USD)',
          data: rows.map((r) => r.fob),
          backgroundColor: rows.map((_, i) => colors[i % colors.length]),
          borderRadius: 4,
          maxBarThickness: 22,
        },
      ],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      onClick: (evt, elements) => {
        if (!elements.length) return;
        const row = rows[elements[0].index];
        if (row.molecula !== 'Sin clasificar') drillIntoMolecula(row.molecula);
      },
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
        y: { grid: { display: false }, ticks: { autoSkip: false } },
      },
    },
  });
  renderTable('moleculaTable', ['Molécula', 'Filas', 'FOB', 'CIF'], rows.map((r) => [r.molecula, fmtInt(r.filas), fmtUSD(r.fob), fmtUSD(r.cif)]));
}

async function drillIntoMolecula(nombre) {
  const rows = await fetchJSON(`/api/molecula/${encodeURIComponent(nombre)}${qs(state)}`);
  lastData.molecula = rows;
  destroyChart('moleculaChart');
  const { grid } = chartDefaults();
  const colors = seriesColors();
  document.getElementById('moleculaTitle').textContent = `${nombre} — desglose por marca`;
  document.getElementById('moleculaBreadcrumb').style.display = 'block';
  const ctx = document.getElementById('moleculaChart');
  charts.moleculaChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: rows.map((r) => r.marca),
      datasets: [
        {
          label: 'Valor FOB (USD)',
          data: rows.map((r) => r.fob),
          backgroundColor: rows.map((_, i) => colors[i % colors.length]),
          borderRadius: 4,
          maxBarThickness: 22,
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
  renderTable('moleculaTable', ['Marca', 'Filas', 'FOB', 'CIF'], rows.map((r) => [r.marca, fmtInt(r.filas), fmtUSD(r.fob), fmtUSD(r.cif)]));
}

async function resetMoleculaView() {
  document.getElementById('moleculaTitle').textContent = 'Importaciones por molécula (principio activo)';
  document.getElementById('moleculaBreadcrumb').style.display = 'none';
  const rows = await fetchJSON(`/api/by-molecula${qs(state)}`);
  renderMoleculaChart(rows);
}

function renderMonthChart(rows) {
  lastData.month = rows;
  destroyChart('monthChart');
  const { grid } = chartDefaults();
  const colors = seriesColors();
  const ctx = document.getElementById('monthChart');
  charts.monthChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: rows.map((r) => r.anio_mes),
      datasets: [
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
      ],
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
  renderTable('monthTable', ['Mes', 'Filas', 'FOB', 'CIF'], rows.map((r) => [r.anio_mes, fmtInt(r.filas), fmtUSD(r.fob), fmtUSD(r.cif)]));
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
  const [summary, molecula, month, tariff, country, importer] = await Promise.all([
    fetchJSON(`/api/summary${qs(state)}`),
    fetchJSON(`/api/by-molecula${qs(state)}`),
    fetchJSON(`/api/by-month${qs(state)}`),
    fetchJSON(`/api/by-tariff${qs(state)}`),
    fetchJSON(`/api/by-country${qs(state)}`),
    fetchJSON(`/api/by-importer${qs(state)}`),
  ]);
  renderStatRow(summary);
  document.getElementById('moleculaTitle').textContent = 'Importaciones por molécula (principio activo)';
  document.getElementById('moleculaBreadcrumb').style.display = 'none';
  renderMoleculaChart(molecula);
  renderMonthChart(month);
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
  state = { from: '', to: '' };
  loadAll();
});
document.getElementById('backToMoleculas').addEventListener('click', resetMoleculaView);

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
