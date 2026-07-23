FROM node:22-slim

WORKDIR /app

# better-sqlite3 no tiene binario prebuilt para esta combinación de imagen/arch,
# así que necesita compilar su addon nativo (node-gyp) en el build.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# Solo dependencias de runtime del dashboard (no Playwright/Chromium: el scraper
# sigue corriendo localmente, este contenedor solo sirve server.mjs).
COPY package.json package-lock.json* ./
# npm install normal (no --ignore-scripts) para que better-sqlite3 compile su binario
# nativo; borramos el script "postinstall" antes para no disparar "playwright install
# chromium", que no hace falta en esta imagen (solo sirve el dashboard).
RUN npm pkg delete scripts.postinstall && npm install --omit=dev

COPY config.js server.mjs ./
COPY public ./public

ENV NODE_ENV=production
ENV PORT=4321
EXPOSE 4321

CMD ["node", "server.mjs"]
