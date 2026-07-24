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

  // Paréntesis que es solo una nota de dosis/unidad extraíble, no parte del nombre
  // (ej. "IMIGLUCERASA (400 U EXTRAIBLES)", "VELAGLUCERASA ALFA (400 UNIDADES),
  // 10,00000 MG", "IMIGLUCERASA (DOSIS EXTRAIBLE 400U)") -- distinto de paréntesis
  // que desambiguan el compuesto (ej. "ANIFROLUMAB (MEDI-546)", "ADRENALINA
  // (EPINEFRINA)"), que no contienen estas palabras clave y se conservan. Se aplica
  // antes del corte de dosis final porque el paréntesis puede quedar en medio del
  // valor (seguido de más dosis, ej. ", 10,00000 MG").
  value = value.replace(/\s*\(\s*(?:DOSIS\s+)?(?:EXTRAIBLES?\s+)?[\d.,]*\s*(?:U|UI|UNIDADES?)\s*(?:EXTRAIBLES?)?\s*\)/i, '');

  // Paréntesis que resume la dosis/ratio de una combinación de varios principios activos
  // (ej. "ELEXACAFTOR/TEZACAFTOR/IVACAFTOR + IVACAFTOR (50/25/37,5 MG + 75 MG)"): el
  // contenido es solo números, separadores ("/", "+", "Y") y unidades (MG/G/ML/UI/MCG),
  // nunca texto -- a diferencia de paréntesis que desambiguan el compuesto (ej.
  // "ANIFROLUMAB (MEDI-546)"), que sí contienen letras propias del nombre y no calzan con
  // este patrón.
  value = value.replace(/\s*\(\s*(?:[\d.,\/+]|MG|G|ML|UI|MCG|%|Y|\s)+\)\s*$/i, '');
  // Puede venir seguido de texto de forma farmacéutica/nombre comercial (ej. "...
  // (100/50/75 MG + 150 MG) TABLETA (TRIKAFTA®)") cuando el corte de límite de campo
  // arrastró de más -- ese texto colgante nunca es parte del nombre de la molécula. Se
  // reconoce por empezar con una palabra de forma farmacéutica conocida (a diferencia de,
  // ej., "PROPINOX (+5%) Y CLONIXINATO DE LISINA", donde lo que sigue es otro ingrediente
  // real que debe conservarse).
  const DOSAGE_FORM_WORDS = 'TABLETA|TABLETAS|CAPSULA|CAPSULAS|COMPRIMIDO|COMPRIMIDOS|SOLUCION|JARABE|CREMA|GEL|AMPOLLA|AMPOLLAS|FRASCO|VIAL|PARCHE|SUSPENSION|GRANULOS';
  value = value.replace(
    new RegExp(`\\s*\\(\\s*(?:[\\d.,\\/+]|MG|G|ML|UI|MCG|%|Y|\\s)+\\)\\s*(?:${DOSAGE_FORM_WORDS})\\b.*$`, 'i'),
    ''
  );

  // Combinaciones de varios principios activos separados por "/" con dosis inline por
  // cada uno (ej. "ELEXACAFTOR 100MG/TEZACAFTOR 50MG/IVACAFTOR 75MG Y IVACAFTOR 150MG"):
  // el corte de dosis final de más abajo es no-global y solo busca la PRIMERA ocurrencia
  // de "<numero><unidad>", así que arrastraría ".*$" desde ahí y se comería el resto de
  // los principios activos, dejando solo el primero. Para evitar mangling en formatos más
  // complejos (dosis con comas, cláusulas "EQUIVALENTE A" embebidas, paréntesis, ej. la
  // fórmula de PEDIALYTE), solo se activa cuando CADA segmento separado por "/"/"Y"/"+"
  // EMPIEZA con "<nombre> <numero><unidad>" sin comas ni paréntesis antes de la dosis —
  // la forma exacta de combinaciones simples tipo Trikafta. El ÚLTIMO segmento puede
  // traer texto colgante después de su dosis (ej. "IVACAFTOR 150MG TABLETA (TRIKAFTA®)")
  // cuando el corte de límite de campo cayó después de "CONCENTRACION" en vez de justo
  // tras el valor; ese texto se descarta junto con la dosis.
  const DOSE_SEGMENT_START = /^([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ\s-]*?)\s+[\d.,]+\s*(MG|G|ML|UI|MCG|%)\b/i;
  if (/\//.test(value)) {
    const parts = value.split(/\s*\/\s*|\s+Y\s+|\s*\+\s*/i).map((s) => s.trim()).filter(Boolean);
    if (parts.length > 1 && parts.every((part) => DOSE_SEGMENT_START.test(part))) {
      const cleanedParts = parts
        .map((part) => DOSE_SEGMENT_START.exec(part)[1].trim())
        .filter(Boolean);
      const seen = new Set();
      const deduped = cleanedParts.filter((part) => {
        const key = part.toUpperCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      if (deduped.length > 1) value = deduped.join('/');
    }
  }

  // Lista de principios activos ya sin dosis (ej. tras el corte de paréntesis-ratio de
  // más arriba, "ELEXACAFTOR/TEZACAFTOR/IVACAFTOR + IVACAFTOR") con un ingrediente
  // repetido literalmente (ivacaftor aparece tanto en el combinado como en la tableta
  // booster por separado): deduplicar es seguro aquí porque cada segmento es un nombre
  // "puro" (sin números ni paréntesis), así que un duplicado exacto es sencillamente el
  // mismo principio activo mencionado dos veces, no información distinta perdida.
  if (/[/]|\bY\b|\+/i.test(value)) {
    const plainParts = value.split(/\s*\/\s*|\s+Y\s+|\s*\+\s*/i).map((s) => s.trim()).filter(Boolean);
    const PLAIN_NAME = /^[A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ\s-]*$/i;
    if (plainParts.length > 1 && plainParts.every((part) => PLAIN_NAME.test(part))) {
      const seen = new Set();
      const deduped = plainParts.filter((part) => {
        const key = part.toUpperCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      if (deduped.length < plainParts.length && deduped.length > 1) value = deduped.join('/');
    }
  }

  // Corta dosis/unidades finales: números, comas decimales, mg/g/ml/ui.
  value = value.replace(/[\d.,]+\s*(MG|G|ML|UI|MCG|%)\b.*$/i, '');

  value = value.replace(/\s+/g, ' ').trim();
  value = value.replace(/[.,;:\s]+$/, '').trim();
  // Paréntesis huérfano de apertura (sin su cierre) dejado por el corte de dosis final
  // cuando el paréntesis solo envolvía la dosis (ej. "IVACAFTOR (150 mg)" -> "IVACAFTOR
  // (" tras cortar en el número): a diferencia de paréntesis balanceados que sí forman
  // parte del nombre (ej. "TERIPARATIDA (ORIGEN ADN RECOMBINANTE)"), un "(" colgante al
  // final nunca es información válida del nombre.
  if (value.endsWith('(')) {
    value = value.slice(0, -1).trim();
    value = value.replace(/[.,;:\s]+$/, '').trim();
  }
  // Normaliza espacios sueltos alrededor del separador "/" en combinaciones
  // (ej. "ELEXACAFTOR/TEZACAFTOR/ IVACAFTOR" -> "ELEXACAFTOR/TEZACAFTOR/IVACAFTOR"):
  // es puramente cosmético, nunca cambia el nombre de un principio activo.
  value = value.replace(/\s*\/\s*/g, '/');

  // Uniforma a mayúsculas: el texto fuente mezcla mayúsculas/minúsculas según el envío
  // (ej. "ECULIZUMAB" y "Eculizumab" para el mismo principio activo), y como "molecula"
  // se usa para agrupar (gráficas, focus-molecules.json), una diferencia de casing
  // fragmentaría el mismo principio activo en barras/filas separadas. No afecta a
  // "marca", que sí se muestra con su casing original de marca comercial.
  const final = canonicalizeMolecula(value || raw.trim());
  // "µ" (signo micro, U+00B5) se convierte con .toUpperCase() a "Μ" (mu griega
  // mayúscula, U+039C) en vez de a una letra ASCII -- visualmente casi idéntica pero un
  // carácter distinto, lo que rompería comparaciones/agrupación exactas más adelante. Se
  // normaliza a la "u" ASCII antes de mayuscular (ej. "µg" -> "UG"), preservando el
  // significado ("micro") sin introducir un carácter Unicode inesperado.
  return final.replace(/[µμ]/g, 'u').toUpperCase();
}

// Variantes conocidas (typos de digitación, separadores inconsistentes) que el
// pipeline de extracción por sí solo no puede normalizar porque dependen del texto
// exacto de cada envío. Se mantiene como mapa explícito en vez de heurística general
// porque cada caso viene de una causa distinta (typo puntual vs. formato variable) y
// una normalización genérica arriesgaría fusionar moléculas que sí son distintas.
const MOLECULA_CANONICAL_MAP = new Map([
  ['EELEXACAFTOR/TEZACAFTOR/IVACAFTOR', 'ELEXACAFTOR/TEZACAFTOR/IVACAFTOR'],
]);

function canonicalizeMolecula(value) {
  const key = value.toUpperCase();
  return MOLECULA_CANONICAL_MAP.get(key) ?? value;
}

// Detecta el patrón "MEDICAMENTO VITAL NO DISPONIBLE" (importación a nombre de
// paciente), que embebe PII (nombre completo + documento de identidad) en el texto.
function isVitalNoDisponible(text) {
  return /MEDICAMENTO VITAL NO DISPONIBLE/i.test(text);
}

// Etiquetas de "NOMBRE COMERCIAL" -- a diferencia de PRODUCTO_LABELS (que incluye el
// genérico "PRODUCTO"/"Producto"), estas SIEMPRE nombran específicamente el producto
// comercial, nunca arrastran cláusulas regulatorias completas -- por eso son seguras
// como último recurso para leer el nombre de marca en texto plano (ver más abajo),
// mientras que "PRODUCTO" a secas no lo es.
const NOMBRE_COMERCIAL_LABELS = ['NOMBRE COMERCIAL DEL PRODUCTO', 'NOMBRE COMERCIAL'];

// Extrae marca con cadena de fallback: MARCA explícita -> símbolo ®/™/© en la línea de
// PRODUCTO/NOMBRE COMERCIAL -> valor plano de NOMBRE COMERCIAL -> null.
function extractMarca(text) {
  const explicit = extractField(text, MARCA_LABELS, FIELD_BOUNDARY_LABELS);
  if (explicit && !/^(N\/?A|NO APLICA|NO TIENE)$/i.test(explicit.value)) {
    return { value: cleanMarca(explicit.value), confidence: 'high', source: 'MARCA' };
  }

  for (const label of PRODUCTO_LABELS) {
    // El separador de puntuación tras el label es opcional (ej. "PRODUCTO ELEXACAFTOR/...
    // (TRIKAFTA®)" sin ":" tras "PRODUCTO"): probado contra el dataset completo, exigir
    // solo espacio en vez de puntuación no genera falsos positivos porque el símbolo
    // ®/™/© cercano (buscado más abajo) ya filtra la prosa genérica que también empieza
    // con "PRODUCTO " (ej. "PRODUCTO ES EMPLEADO EN...", "PRODUCTO EN RS: ...") -- esas
    // frases no tienen un símbolo de marca a corta distancia.
    const labelPattern = new RegExp(`\\b${escapeRegExp(label)}\\s*[:_-]?\\s*`, 'i');
    const match = labelPattern.exec(text);
    if (!match) continue;
    const start = match.index + match[0].length;
    // 300 chars: algunos textos de PRODUCTO enumeran la concentración combinada y luego
    // repiten cada principio activo con su dosis individual antes de llegar al nombre de
    // marca entre paréntesis (ej. Trikafta: "ELEXACAFTOR/TEZACAFTOR/IVACAFTOR (200/100/300
    // MG) ELEXACAFTOR/TEZACAFTOR/IVACAFTOR 100/50/75 MG + IVACAFTOR 150 MG TABLETA
    // (TRIKAFTA®)"), lo que empuja el símbolo más allá de una ventana de 120 caracteres.
    const rest = text.slice(start, start + 300);
    // Busca una palabra (o frase corta) seguida de ®/™/©.
    const brandSymbolMatch = /([A-ZÁÉÍÓÚÑ0-9][A-ZÁÉÍÓÚÑ0-9\s\-]{1,40})[®™©]/.exec(rest);
    if (brandSymbolMatch) {
      const candidate = brandSymbolMatch[1].trim().split(/\s+/).slice(-3).join(' ');
      return { value: cleanMarca(candidate), confidence: 'medium', source: `${label}+symbol` };
    }
  }

  // Sin símbolo ®/™/© cerca (ej. "MARCA: NO APLICA, NOMBRE COMERCIAL: Soliris 300 mg",
  // el patrón usado por INVIMA para biológicos importados bajo protocolo/resolución en
  // vez de registro sanitario estándar): se usa el valor de "NOMBRE COMERCIAL" tal cual,
  // sin requerir el símbolo. Nunca se hace esto con el label genérico "PRODUCTO" (fuera
  // de NOMBRE_COMERCIAL_LABELS) porque ese campo suele arrastrar la descripción
  // regulatoria completa, no solo el nombre comercial.
  const plain = extractField(text, NOMBRE_COMERCIAL_LABELS, FIELD_BOUNDARY_LABELS);
  if (plain && !/^(N\/?A|NO APLICA|NO TIENE)$/i.test(plain.value)) {
    // Corta dosis/concentración final (ej. "Soliris 300 mg" -> "Soliris"), igual que se
    // hace con "molecula", para que la marca quede consistente con el resto de la data
    // (ej. "JARDIANCE" nunca "JARDIANCE 25 MG").
    const withoutDose = plain.value.replace(/[\d.,]+\s*(MG|G|ML|UI|MCG|%)\b.*$/i, '').trim();
    const cleaned = cleanMarca(withoutDose || plain.value);
    if (cleaned && cleaned.length <= 60) {
      return { value: cleaned, confidence: 'medium', source: `${plain.label}+plain` };
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
  let marca = extractMarca(text);

  // El fallback "+plain" de extractMarca() (NOMBRE COMERCIAL sin símbolo ®/™/©) a veces
  // recupera un valor que es, en esencia, el mismo nombre que ya quedó en "molecula"
  // (ej. productos genéricos donde el campo NOMBRE COMERCIAL solo repite el principio
  // activo, a veces con un sufijo de sal/forma distinto: "NOMBRE COMERCIAL: DOCETAXEL
  // 120MG/6ML" con molecula "DOCETAXEL ANHIDRO", o "NOMBRE COMERCIAL_ METOTREXATO 2,5
  // MG X 100 COMP." con molecula "METOTREXATO"). Se compara por prefijo (uno empieza
  // con el otro), no por igualdad exacta, para cubrir también el caso del sufijo de
  // sal. Mostrar la misma palabra en molecula Y marca no aporta información en el
  // desglose por marca del dashboard, así que se descarta -- solo para esta fuente,
  // nunca para MARCA explícita o el fallback por símbolo, donde una coincidencia sí
  // podría ser intencional.
  if (marca.source?.endsWith('+plain') && molecula.value && marca.value) {
    const m = molecula.value.toUpperCase();
    const b = marca.value.toUpperCase();
    if (m.startsWith(b) || b.startsWith(m)) {
      marca = { value: null, confidence: 'low', source: null };
    }
  }

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
