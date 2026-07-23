# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Playwright automation script that logs into Daater (app.daater.co, a trade-data platform), searches for a fixed list of tariff codes (`tariff-codes.json`) against Colombia's "DAATER ONLINE 2025-2026" import database, downloads the result as an `.xlsx` backup into `output/`, and loads the parsed rows into a local SQLite master database (`daater.db`) that accumulates across weekly runs.

On top of that master database sits a local dashboard (`server.mjs` + `public/`) that visualizes the imports — by molecule (active ingredient), brand, month, tariff code, country of origin, and importer. Molecule/brand aren't columns Daater provides directly: they're extracted from the free-text `Desc Completa De Producto` field (INVIMA regulatory paragraphs) via `product-extractor.js`, with a manual-override mechanism for cases the regex gets wrong.

There is no build step or test suite — this is a set of standalone Node scripts run directly. The scraper (`search-daater.mjs`) is intended to run manually about once a week; the dashboard runs on demand whenever you want to look at the data.

## Commands

```
npm install              # also runs postinstall -> playwright install chromium
npm run search           # runs node search-daater.mjs (scrape Daater, update daater.db)
npm run dashboard         # runs node server.mjs — dashboard at http://localhost:4321

node backfill-products.mjs   # (re)compute molecula/marca/extraction_confidence for ALL rows in daater.db
node review-products.mjs [N] # print the N (default 30) distinct descriptions with lowest-confidence extraction, to guide product-overrides.json edits
```

Setup before running the scraper: copy `.env.example` to `.env.local` and fill in `DAATER_EMAIL` / `DAATER_PASSWORD`. The script exits early with a Spanish error message if these are missing.

`better-sqlite3` requires a native build; on Windows this needs Visual Studio Build Tools with the "Desktop development with C++" workload installed (`npm install` fails with a node-gyp/MSVS error otherwise).

There is no lint or test command configured.

## Architecture

- **config.js** — the only place to change run behavior: target `country`, `flow` (`IMPORTACIONES`/`EXPORTACIONES` tab prefix), `baseFilter` (restricts the run to one base tab, e.g. `'DAATER ONLINE 2025-2026'` — set to `null` to iterate all bases), `showDetail`, `outputDir`, `dbFile`, and `backfillRange` (the explicit date range used only the very first time the master DB is empty).
- **tariff-codes.json** — flat array of tariff codes to search for; edit this to change what the script pulls.
- **db.js** — SQLite access layer (`better-sqlite3`). Creates the `importaciones` table lazily from the columns of the first row ever inserted (Daater's export columns aren't hardcoded, so schema changes upstream don't break it), plus derived `anio_mes` (`YYYY-MM`), `molecula`, `marca`, and `extraction_confidence` columns. `getLatestMonth()` reads `MAX(anio_mes)`. `replaceMonthData()` does `DELETE` + re-`INSERT` for a given month inside a transaction — a month is always fully replaced, never merged, because Daater reports partial months that get completed over subsequent weeks and this avoids duplicate/stale rows. It also runs each row's `Desc Completa De Producto` through `extractProductWithOverrides()` before insert, so every new weekly run gets molecula/marca automatically.
- **product-extractor.js** — extracts `molecula` (active ingredient) and `marca` (brand name) from `Desc Completa De Producto`, which is free-text INVIMA regulatory boilerplate (250–5000 chars) with no fixed structure — at least 6 recurring sub-templates coexist (standard PRODUCTO/PRINCIPIO ACTIVO, RESOLUCION-first, "Cod. Producto:", medical-device/reagent PRODUCTO/COMPOSICION/USO, "MEDICAMENTO VITAL NO DISPONIBLE" named-patient imports, and unstructured narrative outliers) and the same tariff code can appear with any of them. Extraction is anchor-based (search for known field labels like "PRINCIPIO ACTIVO"/"NOMBRE DEL PRINCIPIO ACTIVO", accent/spelling variants included) rather than positional, with salt-prefix and dose stripping for molecula, and a fallback chain for marca (explicit `MARCA:` field → ®/™/© symbol next to the product name → null). Returns a confidence flag (`'high'`/`'low'`) per row so weak extractions can be found via `review-products.mjs`. Named-patient records ("MEDICAMENTO VITAL NO DISPONIBLE") get their embedded PII (patient name/ID) explicitly stripped from the output fields. `hashDescripcion()` hashes the exact description text (not `Numero Formulario`, since the same product description repeats across thousands of shipments) — this hash is the key used in `product-overrides.json`.
- **product-overrides.json** — manual corrections keyed by `hashDescripcion()` output; each entry can set `molecula` and/or `marca` and always wins over the regex result (`applyOverrides()`). Use `review-products.mjs` to find which hashes need an entry, add them here, then re-run `backfill-products.mjs` to apply.
- **backfill-products.mjs** — one-time-but-safe-to-rerun migration: adds the `molecula`/`marca`/`extraction_confidence` columns if missing and recomputes them for every row in `daater.db`. Re-run it after editing `product-overrides.json` or changing the extraction rules in `product-extractor.js`.
- **review-products.mjs** — reports the top N (by row count) distinct product descriptions whose extraction came out low-confidence, with the hash to use as a `product-overrides.json` key — the workflow for iteratively improving extraction accuracy over time.
- **server.mjs** / **public/index.html** / **public/app.js** — the dashboard. `server.mjs` is an Express app that opens `daater.db` read-only (so it can run alongside `npm run search` without locking it) and exposes JSON aggregation endpoints (`/api/summary`, `/api/by-molecula`, `/api/by-month`, `/api/by-tariff`, `/api/by-country`, `/api/by-importer`, `/api/molecula/:nombre` for the brand breakdown of one molecule), all accepting optional `?from=YYYY-MM&to=YYYY-MM` filters. Numeric Daater columns are stored as TEXT with comma decimals, so every aggregation query does `CAST(REPLACE(x, ',', '.') AS REAL)`. The front end is plain HTML/JS + Chart.js (no build step, no framework) — molecule view is the primary chart with click-to-drill-down into brand, plus a monthly time series and secondary tabs for tariff code/country/importer, each with a "Ver tabla" toggle for an accessible table view.
- **xlsx-parser.js** — parses the downloaded `.xlsx` (via `xlsx`/SheetJS) into row objects keyed by column header, and groups them by `anio_mes` derived from the `Fecha` column (`YYYY-MM-DD`) — a single downloaded file can span multiple months.
- **search-daater.mjs** — the entire automation, structured as a linear sequence of Playwright steps:
  1. `login()` — fills credentials, waits for the sidebar combobox to confirm login succeeded.
  2. `selectCountry()` — picks the country from the sidebar dropdown; this determines which "bases" (period tabs) become available.
  3. Iterates base tabs (`getBaseTabs`), skipping any that don't match `config.baseFilter`.
  4. For each matching base: `selectFlowTab()` switches to imports or exports, `addTariffCodes()` types each code into the autocomplete and confirms it via keyboard (`ArrowDown`+`Enter` — **clicking the suggestion directly does not confirm selection in this widget**, only keyboard nav does), then verifies each code rendered as a confirmed chip. `ensureShowDetail()` reads the actual `aria-checked` state of the "Mostrar/Ocultar detalle" switch (the label text flips depending on state, so it can't be used to determine current state) and toggles it on if needed.
  5. `computeMonthsToFetch()` + `setDateRange()` fix the two `<input type="date">` fields (they live in the main filter panel, not the sidebar): if the master DB is empty, uses `config.backfillRange`; otherwise requests `[last loaded month, next month]` so a partially-loaded month gets re-pulled once Daater completes it, and any newly available month gets picked up.
  6. `clickSearch()` runs the query; `waitForResults()` polls the "N filas cargadas" text. This needed two waits, not one: it first waits for the count to *change* from its pre-search value (a stale count can otherwise be misread as the new result), then — because the count passes through a transient `"0"` for several seconds while the table is still loading — waits out a 10s grace period and requires the value to read the same on 3 consecutive 1s polls before accepting it as final.
  7. `downloadResults()` triggers the download button, saves the file as `daater_<país>_<flow>_<base>.xlsx` (slugified) into `outputDir` as a backup copy.
  8. The downloaded file is parsed and grouped by month, then each month is written into `daater.db` via `replaceMonthData()`.
  9. Prints a summary of row counts and file paths per base at the end.

All UI targeting is done via Playwright role/text locators (no test IDs available in the target app), so if Daater's UI changes, the brittle points to check first are: the sidebar combobox/tab roles, the `PARTIDA ARANCELARIA` label used to locate the tariff-code input, the "Mostrar/Ocultar detalle" switch, the two bare `input[type="date"]` fields, and the `filas cargadas` / `Descargar` text matches.

Output files (`output/*.xlsx`), `daater.db`, and `.env.local` are gitignored; sample historical outputs may exist locally under `output/` but are not tracked. `product-overrides.json` is NOT gitignored — it's hand-maintained and should be kept in version control alongside the extraction rules it corrects.

## Deployment

The dashboard (only) is deployed to Fly.io so the wider org can view it, at `https://daater-dashboard.fly.dev/`. The scraper keeps running locally exactly as described above — nothing about `npm run search` changes.

- **Dockerfile** — builds a dashboard-only image (`server.mjs`, `config.js`, `public/`, no Playwright/Chromium). Base is `node:22-slim` (not 20 — `better-sqlite3` requires Node ≥22) with `python3 make g++` installed so `better-sqlite3`'s native addon can compile in-container (no prebuilt binary is fetched for this image/arch combo). `npm pkg delete scripts.postinstall` runs before `npm install` to skip `playwright install chromium`, which isn't needed here.
- **fly.toml** — app `daater-dashboard`, region `gru` (São Paulo — Fly has no Bogotá region), 1GB volume `daater_data` mounted at `/data`. `DB_FILE=/data/daater.db` env var overrides `config.js`'s default path (see below). `HOST=0.0.0.0` is required — Express/`server.mjs` defaults to binding `localhost` only, which Fly's proxy can't reach. `min_machines_running=0` / `auto_stop_machines=stop` let it scale to zero when idle.
- **config.js** — `dbFile` now reads `process.env.DB_FILE` (falling back to `./daater.db` for local use), so the same file works unmodified in both environments.
- **server.mjs** — `app.listen` now takes `process.env.HOST` (falls back to `localhost` locally).
- **deploy/upload-db.ps1** / **deploy/README.md** — the weekly sync step (`npm run deploy:db`) after `npm run search`. `flyctl sftp put` never overwrites an existing remote file, so the script deletes the old `/data/daater.db` via `flyctl ssh console -C "rm -f ..."` first, then uploads and redeploys.
- **Trial account cap**: without a card on file, Fly trial accounts hard-stop any machine after 5 minutes of continuous runtime ("Trial machine stopping" in `flyctl logs`) — looks like a crash/config bug but isn't. Add a card at fly.io/trial to remove it.
- **Known fragility**: uploading `daater.db` (~70MB) over `flyctl sftp put` has dropped mid-transfer (`connection lost`) in testing, seemingly unrelated to the trial cap. If this recurs or the db grows much larger, gzip it first (~7x smaller for this data) and `gunzip` on the remote via `flyctl ssh console` — much less time exposed to whatever is killing the connection.
