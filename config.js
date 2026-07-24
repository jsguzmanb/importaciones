export const config = {
  // País tal como aparece en el selector de Daater: PERU, PANAMA, ECUADOR, COLOMBIA, CHILE
  country: 'COLOMBIA',

  // Prefijo del tab a buscar: 'IMPORTACIONES' o 'EXPORTACIONES'
  flow: 'IMPORTACIONES',

  // Si se define, solo se procesa la base cuyo nombre coincide (substring, sin distinguir
  // mayúsculas/acentos) con este valor, por ejemplo 'DAATER ONLINE 2025-2026'.
  // Si es null, se recorren todas las bases disponibles para el país.
  baseFilter: 'DAATER ONLINE 2025-2026',

  // Fuerza el toggle "Mostrar detalle" a encendido antes de buscar/descargar en cada base.
  showDetail: true,

  outputDir: './output',

  // Rango de fechas a usar SOLO en la primera corrida (base maestra vacía, en Supabase/
  // Postgres). El rango
  // "default" que Daater deja al abrir la base NO trae resultados para estas partidas
  // (confirmado: da 0 filas); hay que fijarlo explícitamente al rango completo disponible.
  backfillRange: { fromDate: '2025-01-01', toDate: '2026-04-30' },

  // El chrome.exe con interfaz visual falla en esta máquina (error de manifiesto SxS de Windows).
  // El modo headless funciona correctamente; el progreso se ve por los logs de consola.
  headless: true,
};
