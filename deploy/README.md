# Desplegar el dashboard en Fly.io

El scraper (`npm run search`) sigue corriendo localmente como siempre. Solo el
dashboard (`server.mjs`) vive en Fly.io, leyendo una copia de `daater.db` en un
volumen persistente.

## Setup (una sola vez)

1. Instalar flyctl: https://fly.io/docs/hands-on/install-flyctl/
2. `flyctl auth login`
3. Desde la raíz del proyecto: `flyctl launch --no-deploy` (usa el `fly.toml` ya
   creado, o `flyctl apps create daater-dashboard` si prefieres crear la app
   antes). Confirmar que la app se llama `daater-dashboard` (o ajustar
   `fly.toml` y `deploy/upload-db.ps1` si usas otro nombre).
4. Crear el volumen para la base de datos (1GB alcanza sobradamente):
   `flyctl volumes create daater_data --region gru --size 1`
   (Fly no tiene región en Colombia; `gru` = São Paulo es la más cercana)
5. Deploy inicial: `npm run deploy` (equivalente a `flyctl deploy`).
6. Subir la base de datos actual: `npm run deploy:db`.

## Uso semanal

Después de cada `npm run search`:

```
npm run deploy:db
```

Esto sube el `daater.db` local al volumen de Fly y reinicia la máquina para
que el servidor relea el archivo.

Si además cambias código del dashboard (`server.mjs`, `public/`, `config.js`),
corre también `npm run deploy` para reconstruir y redeplegar la imagen.

## Notas

- No hay autenticación: cualquiera con la URL pública puede ver el dashboard.
  Si eso deja de ser aceptable, agregar HTTP Basic Auth en `server.mjs` antes
  de compartir el link más ampliamente.
- La app está configurada con `min_machines_running = 0`, así que se apaga
  sola cuando no hay tráfico y no genera costo fuera del volumen (~pocos
  centavos de USD al mes por 1GB).
- **Cuenta trial de Fly.io**: mientras no se agregue una tarjeta en
  https://fly.io/trial, cada arranque de la máquina tiene un límite duro de
  5 minutos de uso continuo antes de reiniciarse sola (se ve en los logs como
  "Trial machine stopping"). Para uso ocasional del dashboard no se nota
  (Fly la vuelve a levantar en la siguiente petición), pero alguien navegando
  sin pausa por más de 5 minutos verá un reinicio. Agregar tarjeta quita el
  límite.
- `flyctl sftp put` nunca sobreescribe un archivo remoto existente — por eso
  `upload-db.ps1` borra `/data/daater.db` (via `flyctl ssh console`) antes de
  subir el nuevo. Si `daater.db` crece mucho más allá de ~70MB, la subida por
  sftp puede cortarse a mitad de camino (visto durante la configuración
  inicial); en ese caso comprimir con `gzip` antes de subir y descomprimir en
  el servidor con `flyctl ssh console -a daater-dashboard -C "gunzip -f ..."`
  reduce bastante el tiempo de transferencia.
