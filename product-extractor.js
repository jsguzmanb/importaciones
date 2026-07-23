// Extrae "molecula" (principio activo) y "marca" (nombre comercial) desde el texto
// libre de "Desc Completa De Producto", que es un párrafo de trámite regulatorio
// INVIMA sin estructura fija: coexisten varias plantillas (PRODUCTO/PRINCIPIO ACTIVO,
// RESOLUCION-first, "Cod. Producto:", reactivos/dispositivos con COMPOSICION/USO en
// vez de PRINCIPIO ACTIVO, y narrativas sin campos reconocibles). No hay separador ni
// orden de campos consistente, así que la extracción es por anclas (nombre de campo)
// en vez de por posición.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// Hash estable de la descripción completa, usado como clave en product-overrides.json.
// Se usa el texto de la descripción (no "Numero Formulario") porque el mismo producto
// se repite en miles de envíos con el mismo texto exacto, mientras que el número de
// formulario es único por envío individual.
export function hashDescripcion(descripcion) {
  return createHash('sha1').update(descripcion ?? '').digest('hex').slice(0, 12);
}

// Carga product-overrides.json. Devuelve {} si el archivo no existe o está vacío,
// para que el resto del pipeline pueda tratar "sin overrides" y "overrides.json
// ausente" de la misma forma.
export function loadOverrides(filePath = './product-overrides.json') {
  try {
    const raw = readFileSync(filePath, 'utf-8');
    return JSON.parse(raw).overrides ?? {};
  } catch {
    return {};
  }
}

// Encabezados observados para cada campo, en orden de preferencia. Las variantes con
// acento y sin acento conviven en los datos reales.
// "Y (SU) CONCENTRACION" es un sufijo opcional que puede seguir a cualquier variante
// del label de principio activo (con o sin "SU", con o sin acento).
const MOLECULA_LABELS = [
  'NOMBRE DEL PRINCIPIO ACTIVO Y SU CONCENTRACIÓN',
  'NOMBRE DEL PRINCIPIO ACTIVO Y SU CONCENTRACION',
  'NOMBRE DEL PRINCIPIO ACTIVO Y CONCENTRACIÓN',
  'NOMBRE DEL PRINCIPIO ACTIVO Y CONCENTRACION',
  'NOMBRE DEL PRINCIPIO ACTIVO',
  'PRINCIPIO ACTIVO Y SU CONCENTRACIÓN',
  'PRINCIPIO ACTIVO Y SU CONCENTRACION',
  'PRINCIPIO ACTIVO Y CONCENTRACION',
  'PRINCIPIO ACTIVO Y CONCENTRACIÓN',
  'PRINCIPIO ACTIVO',
];

const MARCA_LABELS = ['MARCA'];

const PRODUCTO_LABELS = [
  'NOMBRE COMERCIAL DEL PRODUCTO',
  'NOMBRE COMERCIAL',
  'PRODUCTO',
  'Producto',
];

// Cualquiera de estos textos marca el final del valor de un campo (siguiente etiqueta
// o corte de sección), buscado como "siguiente ocurrencia más cercana" tras la ancla.
const FIELD_BOUNDARY_LABELS = [
  'PRINCIPIO ACTIVO Y CONCENTRACION',
  'PRINCIPIO ACTIVO Y CONCENTRACIÓN',
  'NOMBRE DEL PRINCIPIO ACTIVO',
  'PRINCIPIO ACTIVO',
  'CONCENTRACION DEL PRINCIPIO ACTIVO',
  'CONCENTRACIÓN DEL PRINCIPIO ACTIVO',
  'CONCENTRACION',
  'CONCENTRACIÓN',
  'INDICACIONES TERAPEUTICAS',
  'INDICACIONES TERAPÉUTICAS',
  'INDICACIONES Y/O USO TERAPÉUTICO',
  'INDICACIONES Y/O USO',
  'INDICACIONES',
  'FORMA FARMACEUTICA',
  'FORMA FARMACÉUTICA',
  'TIPO DE EMPAQUE',
  'PRESENTACION',
  'PRESENTACIÓN',
  'NOMBRE COMERCIAL DEL PRODUCTO',
  'NOMBRE COMERCIAL',
  'CODIGO IUM',
  'CÓDIGO IUM',
  'USO',
  'FABRICANTE',
  'NOMBRE DEL LABORATORIO FABRICANTE',
  'NOMBRE DEL FABRICANTE',
  'MARCA',
  'RADICADO',
  'RADICACION',
  'RADICACIÓN',
  'COD',
  'CÓDIGO',
  'CODIGO',
  'REFERENCIA',
  'REF',
  'CANTIDAD A IMPORTAR',
  'CANT. A IMPORTAR',
  'CANT A IMPORTAR',
  'NOMBRE COMPLETO DEL PACIENTE',
  'TIPO DE DOCUMENTO',
  'VIDA UTIL',
  'VIDA ÚTIL',
  'MERCANCIA NUEVA',
];

// Prefijos de forma-sal e infijos que se descartan al derivar el nombre "puro" de la
// molécula a partir del texto crudo de PRINCIPIO ACTIVO (que suele incluir la sal y la
// dosis, ej. "CLORHIDRATO DE GEMCITABINA EQUIVALENTE A GEMCITABINA 1,00000 MG").
const SALT_PREFIXES = [
  'CLORHIDRATO DE',
  'SULFATO DE',
  'FOSFATO DE',
  'ACETATO DE',
  'CITRATO DE',
  'MALEATO DE',
  'TARTRATO DE',
  'BROMURO DE',
  'SUCCINATO DE',
];

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Busca "<label><separador><valor>" y devuelve el valor hasta la próxima etiqueta de
// campo conocida (o hasta el límite de longitud/puntuación de corte si no hay ninguna).
function extractField(text, labels, boundaryLabels) {
  for (const label of labels) {
    const labelPattern = new RegExp(`\\b${escapeRegExp(label)}\\s*[:_-]\\s*`, 'i');
    const match = labelPattern.exec(text);
    if (!match) continue;

    let start = match.index + match[0].length;
    let rest = text.slice(start);

    // Caso "PRINCIPIO ACTIVO: Y CONCENTRACION[.:]..." — el label combinado no matcheó
    // (hay separador entre ambas palabras), así que el label suelto capturó solo "Y".
    // Saltamos tras "CONCENTRACION" (con su propio separador) para leer el valor real.
    const yConcentMatch = /^Y\s+CONCENT[A-ZÁÉÍÓÚÑ]*\s*[:.]\s*/i.exec(rest);
    if (yConcentMatch) {
      start += yConcentMatch[0].length;
      rest = text.slice(start);
    }

    let end = rest.length;
    for (const boundary of boundaryLabels) {
      if (boundary === label) continue;
      const boundaryPattern = new RegExp(`\\b${escapeRegExp(boundary)}\\b`, 'i');
      const boundaryMatch = boundaryPattern.exec(rest);
      if (boundaryMatch && boundaryMatch.index < end) end = boundaryMatch.index;
    }

    // Tope duro por si no aparece ninguna etiqueta siguiente (evita arrastrar párrafos
    // enteros de indicaciones terapéuticas cuando el campo es el último reconocido).
    end = Math.min(end, 200);

    let value = rest.slice(0, end).trim();
    // Recorta separadores/puntuación colgante al final (comas, puntos sueltos).
    value = value.replace(/[.,;:\s]+$/, '').trim();
    if (value) return { value, label };
  }
  return null;
}

// Limpia el nombre comercial: quita símbolos de marca registrada, corta en la primera
// coma/punto (los valores de MARCA a veces arrastran listas de referencias/códigos
// separadas por coma cuando no hay más etiquetas de límite reconocidas) y espacios extra.
function cleanMarca(raw) {
  let value = raw.replace(/[®™©]/g, '');
  const commaIndex = value.search(/[,.]/);
  if (commaIndex > 0) value = value.slice(0, commaIndex);
  return value.replace(/\s+/g, ' ').trim();
}

// Deriva el nombre "puro" de la molécula a partir del texto crudo de PRINCIPIO ACTIVO,
// quitando prefijos de sal, cláusulas "EQUIVALENTE A ..." redundantes y dosis/unidades.
function cleanMolecula(raw) {
  let value = raw;

  // Cuando el label matcheado fue "PRINCIPIO ACTIVO" pero el texto real combina el
  // campo con CONCENTRACION ("PRINCIPIO ACTIVO: Y CONCENT[RACION]: ..."), sobra el "Y
  // CONCENT..." residual al inicio del valor capturado (abreviado o completo).
  value = value.replace(/^Y\s+CONCENT[A-ZÁÉÍÓÚÑ]*\s*:?\s*/i, '');
  // "CADA X ML/MG CONTIENE" al inicio (a veces sin llegar a nombrar la molécula
  // porque la dosis/unidad no calzó con el patrón esperado más abajo).
  value = value.replace(/^CADA\b.*?\bCONTIENE[;:]?\s*/i, '');

  // "MOLECULA (EQUIVALENTE A <dosis>)" -> es una nota de equivalencia de dosis, no de
  // sal; nos quedamos con el texto ANTES del paréntesis (el nombre real).
  const parenEquivalenteMatch = /^(.+?)\s*\(\s*EQUIVALENTE\s+A\s+[^)]*\)/i.exec(value);
  // "SAL EQUIVALENTE A MOLECULA <dosis>" (sin paréntesis) -> nos quedamos con lo que
  // sigue a "EQUIVALENTE A" (la forma base), no con la sal.
  const equivalenteMatch = !parenEquivalenteMatch && /EQUIVALENTE\s+A\s+([A-ZÁÉÍÓÚÑ0-9\s\-\/.,]+)/i.exec(value);
  if (parenEquivalenteMatch) {
    value = parenEquivalenteMatch[1];
  } else if (equivalenteMatch) {
    value = equivalenteMatch[1];
  } else {
    for (const prefix of SALT_PREFIXES) {
      const prefixPattern = new RegExp(`^${escapeRegExp(prefix)}\\s+`, 'i');
      if (prefixPattern.test(value)) {
        value = value.replace(prefixPattern, '');
        break;
      }
    }
  }

  // Corta dosis/unidades finales: números, comas decimales, mg/g/ml/ui.
  value = value.replace(/[\d.,]+\s*(MG|G|ML|UI|MCG|%)\b.*$/i, '');
  value = value.replace(/\s+/g, ' ').trim();
  value = value.replace(/[.,;:\s]+$/, '').trim();

  return value || raw.trim();
}

// Detecta el patrón "MEDICAMENTO VITAL NO DISPONIBLE" (importación a nombre de
// paciente), que embebe PII (nombre completo + documento de identidad) en el texto.
function isVitalNoDisponible(text) {
  return /MEDICAMENTO VITAL NO DISPONIBLE/i.test(text);
}

// Extrae marca con cadena de fallback: MARCA explícita -> símbolo ®/™/© en la línea de
// PRODUCTO/NOMBRE COMERCIAL -> null.
function extractMarca(text) {
  const explicit = extractField(text, MARCA_LABELS, FIELD_BOUNDARY_LABELS);
  if (explicit && !/^(N\/?A|NO APLICA|NO TIENE)$/i.test(explicit.value)) {
    return { value: cleanMarca(explicit.value), confidence: 'high', source: 'MARCA' };
  }

  for (const label of PRODUCTO_LABELS) {
    const labelPattern = new RegExp(`\\b${escapeRegExp(label)}\\s*[:_-]\\s*`, 'i');
    const match = labelPattern.exec(text);
    if (!match) continue;
    const start = match.index + match[0].length;
    const rest = text.slice(start, start + 120);
    // Busca una palabra (o frase corta) seguida de ®/™/©.
    const brandSymbolMatch = /([A-ZÁÉÍÓÚÑ0-9][A-ZÁÉÍÓÚÑ0-9\s\-]{1,40})[®™©]/.exec(rest);
    if (brandSymbolMatch) {
      const candidate = brandSymbolMatch[1].trim().split(/\s+/).slice(-3).join(' ');
      return { value: cleanMarca(candidate), confidence: 'medium', source: `${label}+symbol` };
    }
  }

  return { value: null, confidence: 'low', source: null };
}

function extractMolecula(text) {
  const field = extractField(text, MOLECULA_LABELS, FIELD_BOUNDARY_LABELS);
  if (!field) return { value: null, confidence: 'low', source: null };

  const cleaned = cleanMolecula(field.value);
  if (!cleaned) return { value: null, confidence: 'low', source: field.label };

  // Confianza baja si el resultado quedó sospechosamente largo (probablemente arrastró
  // texto de otro campo) o sospechosamente corto (1-2 caracteres).
  const confidence = cleaned.length > 60 || cleaned.length < 3 ? 'low' : 'high';
  return { value: cleaned, confidence, source: field.label };
}

/**
 * Extrae { molecula, marca, confidence, rawMatch } desde el texto de
 * "Desc Completa De Producto". No lanza excepción con texto vacío/null.
 *
 * confidence es 'high' | 'low' — 'low' cuando cualquiera de los dos campos no pudo
 * anclarse con confianza (para poder filtrarlos en el reporte de revisión manual).
 * Los registros "MEDICAMENTO VITAL NO DISPONIBLE" excluyen explícitamente cualquier
 * dato de paciente (nombre/documento) de los campos devueltos.
 */
export function extractProduct(descripcion) {
  if (!descripcion || typeof descripcion !== 'string') {
    return { molecula: null, marca: null, confidence: 'low', rawMatch: null, vitalNoDisponible: false };
  }

  const text = descripcion.trim();
  const vitalNoDisponible = isVitalNoDisponible(text);

  const molecula = extractMolecula(text);
  const marca = extractMarca(text);

  const confidence = molecula.confidence === 'high' && marca.confidence !== 'low' ? 'high' : 'low';

  // Salvaguarda de PII: si el regex arrastró texto posterior al nombre del paciente
  // (documento de identidad, tipo de documento), lo descartamos aunque haya calzado
  // como si fuera parte del valor de otro campo.
  const stripPii = (value) => {
    if (!value || !vitalNoDisponible) return value;
    return /IDENTIFICACI[OÓ]N|DOCUMENTO|NUIP|C\.?C\.?\s*\d/i.test(value) ? null : value;
  };

  return {
    molecula: stripPii(molecula.value),
    marca: stripPii(marca.value),
    confidence,
    rawMatch: { moleculaSource: molecula.source, marcaSource: marca.source },
    vitalNoDisponible,
  };
}

/**
 * Aplica product-overrides.json sobre el resultado de extractProduct(): si el hash de
 * la descripción tiene una entrada, sus campos "molecula"/"marca" reemplazan al valor
 * del regex (y la confianza sube a 'high', ya que fue confirmada a mano). Overrides
 * parciales (solo molecula o solo marca) no tocan el campo no especificado.
 */
export function applyOverrides(result, overridesForHash) {
  if (!overridesForHash) return result;
  return {
    ...result,
    molecula: overridesForHash.molecula ?? result.molecula,
    marca: overridesForHash.marca ?? result.marca,
    confidence: 'high',
    overridden: true,
  };
}

/**
 * Extrae molecula/marca desde la descripción y aplica el override manual
 * correspondiente si existe en el mapa `overrides` (keyed por hashDescripcion()).
 */
export function extractProductWithOverrides(descripcion, overrides) {
  const hash = hashDescripcion(descripcion);
  const result = extractProduct(descripcion);
  return { ...applyOverrides(result, overrides?.[hash]), hash };
}
