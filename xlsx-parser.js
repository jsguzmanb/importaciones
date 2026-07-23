import XLSX from 'xlsx';

// Lee el .xlsx descargado de Daater y devuelve un array de objetos
// { nombreColumna: valor, ... } usando la primera fila como encabezados.
export function parseWorkbook(filePath) {
  const workbook = XLSX.readFile(filePath);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { raw: false, defval: null });
}

// Agrupa las filas por año-mes (YYYY-MM) derivado de la columna "Fecha" (YYYY-MM-DD).
// Un mismo archivo puede traer filas de más de un mes.
export function groupRowsByMonth(rows) {
  const byMonth = new Map();
  for (const row of rows) {
    const fecha = row['Fecha'];
    if (!fecha || typeof fecha !== 'string' || fecha.length < 7) continue;
    const anioMes = fecha.slice(0, 7);
    if (!byMonth.has(anioMes)) byMonth.set(anioMes, []);
    byMonth.get(anioMes).push(row);
  }
  return byMonth;
}
