import { chromium } from 'playwright';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { getLatestMonth, replaceMonthData, closePool } from './db.js';
import { parseWorkbook, groupRowsByMonth } from './xlsx-parser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env.local') });

const tariffCodes = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'tariff-codes.json'), 'utf-8')
);

const EMAIL = process.env.DAATER_EMAIL;
const PASSWORD = process.env.DAATER_PASSWORD;

if (!EMAIL || !PASSWORD) {
  console.error(
    'Faltan DAATER_EMAIL / DAATER_PASSWORD. Copia .env.example a .env.local y complétalo.'
  );
  process.exit(1);
}

const outputDir = path.join(__dirname, config.outputDir);
fs.mkdirSync(outputDir, { recursive: true });

function slugify(text) {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

async function login(page, email, password) {
  await page.goto('https://app.daater.co/login');
  await page.getByPlaceholder('correo@empresa.com').fill(email);
  await page.getByPlaceholder('••••••••').fill(password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await page
    .getByRole('complementary')
    .getByRole('combobox')
    .first()
    .waitFor({ state: 'visible', timeout: 30000 });
}

async function selectCountry(page, country) {
  const combo = page.getByRole('complementary').getByRole('combobox').first();
  await combo.selectOption({ label: country });
  await page.waitForTimeout(1000);
}

function getBaseTabs(page) {
  return page.getByRole('complementary').getByRole('tab');
}

async function selectFlowTab(page, flowPrefix) {
  const tab = page
    .getByRole('tab', { name: new RegExp('^' + flowPrefix, 'i') })
    .first();
  await tab.click();
  await page
    .locator('text=PARTIDA ARANCELARIA')
    .first()
    .waitFor({ state: 'visible', timeout: 20000 });
  await page.waitForTimeout(500);
}

function getPartidaInput(page) {
  const label = page.locator('text=PARTIDA ARANCELARIA').first();
  return label.locator('xpath=following::input[@placeholder="Buscar..."][1]');
}

async function addTariffCodes(page, codes) {
  const input = getPartidaInput(page);
  for (const code of codes) {
    await input.click();
    await input.fill('');
    await input.type(code, { delay: 40 });
    const suggestion = page.locator(`text=(${code})`).first();
    try {
      await suggestion.waitFor({ state: 'visible', timeout: 8000 });
      await page.waitForTimeout(300);
      // El click directo sobre la sugerencia no siempre confirma la selección en este
      // widget: solo la deja resaltada. La navegación por teclado sí la confirma.
      await input.press('ArrowDown');
      await input.press('Enter');
      console.log(`  + Partida ${code} seleccionada`);
    } catch {
      console.warn(`  ! No se encontró sugerencia para la partida ${code}, se omite.`);
    }
    await page.waitForTimeout(500);
  }
  // Quita el foco del input para forzar que los chips se rendericen visualmente
  await page.keyboard.press('Tab');
  await page.waitForTimeout(500);

  // Verificación: confirmar que cada partida quedó como chip activo
  for (const code of codes) {
    const chip = page.locator(`button:has-text("${code}")`).first();
    const visible = await chip.isVisible().catch(() => false);
    if (!visible) {
      console.warn(`  ! Advertencia: no se detecta chip confirmado para la partida ${code}`);
    }
  }
}

// El texto junto al switch alterna entre "Mostrar detalle" / "Ocultar detalle" según el
// estado actual, así que no podemos guiarnos por la etiqueta. Leemos el estado real del
// control (aria-checked o checkbox marcado) y solo lo togglea si está apagado.
async function ensureShowDetail(page) {
  const toggle = page
    .locator('text=/mostrar detalle|ocultar detalle/i')
    .first()
    .locator('xpath=following::*[@role="switch" or @type="checkbox"][1]');

  const exists = await toggle.count();
  if (!exists) {
    console.warn('  ! No se encontró el toggle de "Mostrar/Ocultar detalle", se omite.');
    return;
  }

  const isChecked = async () => {
    const ariaChecked = await toggle.getAttribute('aria-checked').catch(() => null);
    if (ariaChecked !== null) return ariaChecked === 'true';
    return toggle.isChecked().catch(() => false);
  };

  if (!(await isChecked())) {
    await toggle.click();
    await page.waitForTimeout(300);
  }

  if (await isChecked()) {
    console.log('  Detalle activado (Mostrar detalle).');
  } else {
    console.warn('  ! No se pudo confirmar que el detalle quedó activado.');
  }
}

async function clickSearch(page) {
  const masFiltros = page.getByText('Más filtros', { exact: true });
  const searchBtn = masFiltros.locator('xpath=following::button[1]');
  await searchBtn.click();
}

function readRowCountText(page) {
  return page.evaluate(() => {
    const m = document.body.innerText.match(/([\d.,]+)\s*filas cargadas/i);
    return m ? m[1] : null;
  });
}

// prevText es el texto de "filas cargadas" visible ANTES de lanzar esta búsqueda
// (puede ser un valor residual de la base/búsqueda anterior). Esperamos a que
// cambie en vez de solo esperar a que "exista", porque si no, se lee el conteo
// viejo que quedó en el DOM de la búsqueda previa mientras la nueva aún carga.
//
// El conteo pasa por un "0" transitorio mientras la tabla sigue cargando antes de
// llegar al valor final (confirmado: a los 3s marcaba "0", a los 8s el valor real).
// Por eso, tras detectar el primer cambio, se espera un período de gracia (dando
// tiempo a que ese "0" transitorio aparezca y desaparezca) y luego se exige que el
// valor se mantenga estable durante varias lecturas seguidas antes de aceptarlo.
async function waitForResults(page, prevText) {
  await page.waitForFunction(
    (prev) => {
      const m = document.body.innerText.match(/([\d.,]+)\s*filas cargadas/i);
      return !!m && m[1] !== prev;
    },
    prevText,
    { timeout: 90000 }
  );

  await page.waitForTimeout(10000);

  let last = await readRowCountText(page);
  let stableReads = 0;
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(1000);
    const current = await readRowCountText(page);
    if (current !== null && current === last) {
      stableReads++;
      if (stableReads >= 3) return current;
    } else {
      stableReads = 0;
      last = current;
    }
  }
  return last;
}

async function downloadResults(page, filenameBase, dir) {
  const heading = page.getByText('Tabla de datos', { exact: true }).first();
  const downloadBtn = heading.locator(
    'xpath=following::button[contains(., "Descargar")][1]'
  );
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60000 }),
    downloadBtn.click(),
  ]);
  const filePath = path.join(dir, `${filenameBase}.xlsx`);
  await download.saveAs(filePath);
  return filePath;
}

function addMonth(anioMes) {
  const [year, month] = anioMes.split('-').map(Number);
  const next = month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, '0')}`;
  return next;
}

function monthRange(anioMes) {
  const lastDay = new Date(Date.UTC(...anioMes.split('-').map(Number), 0)).getUTCDate();
  return { fromDate: `${anioMes}-01`, toDate: `${anioMes}-${String(lastDay).padStart(2, '0')}` };
}

// Si la base maestra está vacía (primera corrida), se usa config.backfillRange: el rango
// "default" que Daater deja al abrir la base no trae resultados para estas partidas.
// En corridas siguientes solo se piden el último mes ya cargado (por si Daater lo completó)
// y el mes siguiente.
async function computeMonthsToFetch() {
  const latestMonth = await getLatestMonth();
  if (!latestMonth) return config.backfillRange;

  const nextMonth = addMonth(latestMonth);
  const { fromDate } = monthRange(latestMonth);
  const { toDate } = monthRange(nextMonth);
  return { fromDate, toDate };
}

// Los dos <input type="date"> (desde/hasta) no viven dentro del sidebar (complementary),
// están en el panel principal de filtros. Ambos son editables.
async function setDateRange(page, fromDate, toDate) {
  const dateInputs = page.locator('input[type="date"]');
  await dateInputs.nth(0).fill(fromDate);
  await dateInputs.nth(1).fill(toDate);
  await page.waitForTimeout(500);
}

(async () => {
  const browser = await chromium.launch({ headless: config.headless });
  const page = await browser.newPage({ acceptDownloads: true });

  console.log('Iniciando sesión en Daater...');
  await login(page, EMAIL, PASSWORD);

  console.log(`Seleccionando país: ${config.country}`);
  await selectCountry(page, config.country);

  const baseCount = await getBaseTabs(page).count();
  console.log(`Bases disponibles para ${config.country}: ${baseCount}`);
  if (config.baseFilter) {
    console.log(`Filtrando solo bases que coincidan con: "${config.baseFilter}"`);
  }

  const normalize = (text) =>
    text
      .toLowerCase()
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '');

  const results = [];

  for (let i = 0; i < baseCount; i++) {
    const tab = getBaseTabs(page).nth(i);
    const baseName = (await tab.textContent()).trim();

    if (
      config.baseFilter &&
      !normalize(baseName).includes(normalize(config.baseFilter))
    ) {
      continue;
    }

    console.log(`\n--- Base: ${baseName} ---`);
    await tab.click();
    await page.waitForTimeout(800);

    await selectFlowTab(page, config.flow);

    console.log(`Agregando ${tariffCodes.length} partidas arancelarias...`);
    await addTariffCodes(page, tariffCodes);

    if (config.showDetail) {
      await ensureShowDetail(page);
    }

    const range = await computeMonthsToFetch();
    console.log(`  Rango de fechas: ${range.fromDate} a ${range.toDate}`);
    await setDateRange(page, range.fromDate, range.toDate);

    const prevRowText = await readRowCountText(page);
    console.log('Ejecutando búsqueda...');
    await clickSearch(page);
    const rowCount = await waitForResults(page, prevRowText);
    console.log(`Resultados: ${rowCount ?? 'desconocido'} filas`);

    if (!rowCount || rowCount === '0') {
      console.log('Sin resultados en esta base, se omite la descarga.');
      results.push({ base: baseName, rowCount, filePath: null });
      continue;
    }

    const filenameBase = `daater_${slugify(config.country)}_${slugify(config.flow)}_${slugify(baseName)}`;
    const filePath = await downloadResults(page, filenameBase, outputDir);
    console.log(`Descargado: ${filePath}`);

    const rows = parseWorkbook(filePath);
    const byMonth = groupRowsByMonth(rows);
    for (const [anioMes, monthRows] of byMonth) {
      await replaceMonthData(anioMes, monthRows);
      console.log(`  Base maestra: mes ${anioMes} actualizado (${monthRows.length} filas).`);
    }

    results.push({ base: baseName, rowCount, filePath });
  }

  await browser.close();
  await closePool();

  console.log('\nResumen:');
  for (const r of results) {
    console.log(`  ${r.base}: ${r.rowCount ?? '?'} filas -> ${r.filePath}`);
  }
})().catch((err) => {
  console.error('Error en la automatización:', err);
  process.exit(1);
});
