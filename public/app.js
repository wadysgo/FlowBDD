import { buildPython } from './python-generator.js';
import { buildJava } from './java-generator.js';

const MAX_REQ_CHARS = 20000;
const input = document.querySelector('#requirement');
const result = document.querySelector('#results');
const count = document.querySelector('#char-count');
const urlInput = document.querySelector('#target-url');
const urlWrap = document.querySelector('#url-wrap');
const modeInput = document.querySelector('#input-mode');
const platformInput = document.querySelector('#target-platform');
const nativeConfigWrap = document.querySelector('#native-platform-config');
const desktopConfig = document.querySelector('#desktop-config');
const mobileConfig = document.querySelector('#mobile-config');
const analyzeButton = document.querySelector('#analyze-url');
const previewButton = document.querySelector('#generate');
const authDialog = document.querySelector('#auth-dialog');
const discrepancyDialog = document.querySelector('#discrepancy-dialog');
const superAgentToggle = document.querySelector('#superagent-enabled');
const apiKeyInput = document.querySelector('#openai-api-key');
const aiToggle = document.querySelector('#use-llm');
const voiceToggle = document.querySelector('#voice-enabled');
const themeToggle = document.querySelector('#theme-toggle');
let sessionApiKey = '';

const sample = `REQUERIMIENTO FUNCIONAL: APROBACIÓN DE FACTURAS PENDIENTES
URL de acceso: https://sistema-empresa.com/facturas/pendientes
Como gerente, quiero aprobar facturas pendientes para que se paguen a tiempo.
Elementos de interfaz y selectores:
Botón "Ingresar al Sistema": XPath → //button[@id='btn-login'] | CSS → #btn-login
Campo Usuario: XPath → //input[@name='usuario'] | CSS → input[name='usuario']
Campo Contraseña: XPath → //input[@type='password'] | CSS → input[type='password']
Tabla listado: XPath → //table[@id='tabla-facturas'] | CSS → #tabla-facturas
Botón Aprobar: XPath → //button[@id='btn-aprobar'] | CSS → #btn-aprobar
Campo Observaciones: XPath → //textarea[@id='txt-observaciones'] | CSS → #txt-observaciones
Mensaje confirmación: XPath → //div[@id='mensaje-resultado'] | CSS → #mensaje-resultado
Reglas de negocio:
Solo usuarios con perfil Gerente pueden acceder a esta funcionalidad.
El monto menor a $500.000 se aprueba directamente.
El vencimiento superado bloquea la acción y muestra alerta: "La factura se encuentra vencida".
Pasos de ejecución:
1. Navegar a la página de facturas pendientes.
2. Ingresar usuario gerente.
3. Ingresar contraseña.
4. Iniciar sesión.
5. Aprobar la factura pendiente y verificar el mensaje de operación exitosa.`;

let pageAnalysis = null;
let previewData = null;
let outputArtifacts = null;
let activeDiscrepancy = null;
let cachedInterpretation = null;
let cachedInterpretationKey = '';
let activeRunId = '';
let runEventSource = null;
let runTimerId = 0;
let runStartedAt = 0;
const confirmedDiscrepancies = new Map();

document.querySelector('#sample').addEventListener('click', () => {
  input.value = sample;
  modeInput.value = 'mixed';
  updateMode();
  urlInput.value = 'https://sistema-empresa.com/facturas/pendientes';
  updateCount();
});
superAgentToggle.addEventListener('change', updateSuperAgent);
apiKeyInput.addEventListener('input', () => {
  sessionApiKey = apiKeyInput.value.trim();
  aiToggle.closest('label').hidden = !sessionApiKey;
  if (!sessionApiKey) aiToggle.checked = false;
});
voiceToggle.addEventListener('change', () => { if (voiceToggle.checked) speak('¡Hola! SuperAgente activado. Estoy listo para ayudarte.'); else window.speechSynthesis?.cancel(); });
themeToggle.addEventListener('click', () => {
  document.body.classList.toggle('dark-theme');
  const enabled = document.body.classList.contains('dark-theme');
  themeToggle.setAttribute('aria-pressed', String(enabled));
  themeToggle.textContent = enabled ? '☀ Tema claro' : '☾ Tema oscuro';
  localStorage.setItem('flowbdd-theme', enabled ? 'dark' : 'light');
});
input.addEventListener('input', () => { updateCount(); confirmedDiscrepancies.clear(); cachedInterpretation = null; });
urlInput.addEventListener('input', () => { pageAnalysis = null; confirmedDiscrepancies.clear(); cachedInterpretation = null; });
modeInput.addEventListener('change', updateMode);
platformInput.addEventListener('change', updatePlatform);
document.querySelector('#mobile-os').addEventListener('change', () => { if (previewData) previewData.platformConfig.mobileOs = document.querySelector('#mobile-os').value; });
document.querySelector('#auth-form').addEventListener('submit', async (event) => {
  if (event.submitter?.value !== 'continue') return;
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  authDialog.close();
  await analyzeUrl({ username: String(form.get('username') || ''), password: String(form.get('password') || '') });
});
document.querySelector('#discrepancy-form').addEventListener('submit', (event) => {
  if (event.submitter?.value !== 'continue') { activeDiscrepancy = null; return; }
  event.preventDefault();
  const selected = document.querySelector('input[name="suggested-selector"]:checked');
  const manual = document.querySelector('#manual-selector').value.trim();
  if (!selected && !manual) {
    document.querySelector('#manual-selector').focus();
    return;
  }
  if (activeDiscrepancy) {
    const choice = selected ? JSON.parse(selected.value) : { selector: manual, selectorType: inferSelectorType(manual), label: manual };
    confirmedDiscrepancies.set(normalize(activeDiscrepancy.requested), { ...choice, requested: activeDiscrepancy.requested });
  }
  activeDiscrepancy = null;
  discrepancyDialog.close();
  preparePreview();
});

function updateCount() { count.textContent = `${input.value.length} / ${MAX_REQ_CHARS}`; }
function updateMode() { urlWrap.hidden = modeInput.value === 'requirement'; }
function speak(message) {
  if (!voiceToggle.checked || !('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(message);
  utterance.lang = 'es-AR';
  utterance.rate = 0.94;
  window.speechSynthesis.speak(utterance);
}
function updateSuperAgent() {
  const enabled = superAgentToggle.checked;
  document.body.classList.toggle('superagent-active', enabled);
  document.querySelector('#superagent-settings').hidden = !enabled;
  document.querySelector('.hero h1').innerHTML = enabled
    ? 'Tu flujo.<br><span class="serif">Una prueba trazable. ✨ SuperAgente activo</span>'
    : 'Tu flujo.<br><span class="serif">Una prueba trazable.</span>';
  previewButton.querySelector('span:first-child').textContent = enabled ? '🚀 Generar con SuperAgente' : 'Preparar vista previa';
  if (!enabled) {
    aiToggle.checked = false;
    voiceToggle.checked = false;
    apiKeyInput.value = '';
    sessionApiKey = '';
    cachedInterpretation = null;
    window.speechSynthesis?.cancel();
  }
  aiToggle.closest('label').hidden = !enabled || !sessionApiKey;
  if (enabled) speak('¡Hola! SuperAgente activado. Estoy listo para ayudarte.');
}
function updatePlatform() {
  const native = platformInput.value !== 'web';
  nativeConfigWrap.hidden = !native;
  desktopConfig.hidden = platformInput.value !== 'desktop';
  mobileConfig.hidden = platformInput.value !== 'mobile';
  analyzeButton.hidden = native;
  document.querySelector('#java-selenium-option').hidden = native;
  document.querySelector('#java-testng-option').hidden = native;
  if (native) {
    document.querySelector('#want-java-selenium').checked = false;
    document.querySelector('#want-java-testng').checked = false;
  }
  if (native) pageAnalysis = null;
}
function clean(value) { return String(value || '').trim(); }
function normalize(value) { return clean(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ñ/g, 'n').toLowerCase(); }
function escapeHtml(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}
function nowLocal() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Argentina/Buenos_Aires', dateStyle: 'short', timeStyle: 'medium' }).format(new Date()).replace(' ', ' ');
}
function getUrl(text) {
  const entered = clean(urlInput.value);
  const inText = text.match(/https?:\/\/[^\s<>"']+/i)?.[0];
  const cleanTextUrl = (inText || '').replace(/[.,;)}\]]+$/, '');
  if (entered && cleanTextUrl) {
    try {
      const formUrl = new URL(entered);
      const requirementUrl = new URL(cleanTextUrl);
      if (formUrl.origin === requirementUrl.origin && requirementUrl.pathname.length > formUrl.pathname.length) return cleanTextUrl;
    } catch { /* La validación de URL se realiza antes de generar. */ }
  }
  return (entered || cleanTextUrl || '').replace(/[.,;)}\]]+$/, '');
}
function section(text, name) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex(line => new RegExp(`^\\s*(?:[📌📝]\\s*)?${name}\\s*:?\\s*$`, 'i').test(line.trim()));
  if (start < 0) return '';
  const values = [];
  for (let i = start + 1; i < lines.length; i++) {
    const heading = normalize(lines[i]);
    if (/^\s*(?:[A-ZÁÉÍÓÚÑ][^\n]{1,70}:\s*$|#{1,3}\s|[🎯📝⚠️🧪📌]\s*)/u.test(lines[i])
      || /^(?:tipo de prueba|validaciones esperadas|instruccion para el agente|historia de usuario|descripcion detallada de los pasos)$/.test(heading)) break;
    values.push(lines[i]);
  }
  return values.join('\n').trim();
}
function extractSelectors(text) {
  const result = new Map();
  for (const line of text.split(/\r?\n/)) {
    const label = line.match(/^\s*([^:]{2,100}):\s*(.*)$/);
    if (!label) continue;
    const rest = label[2];
    const xpath = rest.match(/XPath\s*[→:]\s*(.*?)\s*(?:\||$)/i)?.[1]?.trim();
    const css = rest.match(/CSS(?:\s+Selector)?\s*[→:]\s*([^|]+)/i)?.[1]?.trim();
    const name = rest.match(/(?:Atributo\s+)?Name\s*[→:]\s*([^|]+)/i)?.[1]?.trim();
    const id = rest.match(/(?:ID|Identificador)\s*[→:]\s*([^|]+)/i)?.[1]?.trim();
    if (xpath || css || name || id) result.set(normalize(label[1]), { xpath, css, name, id });
  }
  return result;
}
function actionFor(line) {
  const t = normalize(line);
  if (/verificar|validar|comprobar/.test(t) && /pagina cargue|pagina cargo|pagina se haya cargado|contenido visible/.test(t)) return 'validar_contenido';
  if (/\b(navegar|acceder a la url|abrir la pagina|ir a la pagina|ingresar a (?:la )?(?:pagina|url|sitio))\b/.test(t)) return 'navegar';
  if (/\b(desplazarse|desplazar|scroll|bajar por la pagina)\b/.test(t)) return 'desplazar';
  if (/\b(ingresar|escribir|completar|introducir|rellenar)\b/.test(t)) return 'escribir';
  if (/\b(verificar|validar|comprobar|debe mostrar|confirmar que)\b/.test(t)) return 'validar';
  if (/\b(clic|click|presionar|pulsar|seleccionar|aprobar|rechazar|iniciar sesion|enviar)\b/.test(t)) return 'clic';
  if (/\b(esperar|aguardar)\b/.test(t)) return 'esperar';
  return 'manual';
}
function mapExplicitSelector(description, selectors) {
  const normalized = normalize(description);
  const keys = [...selectors.keys()];
  const exact = keys.find(key => normalized.includes(key) || key.includes(normalized));
  const genericWords = new Set(['boton', 'button', 'campo', 'field', 'input', 'enlace', 'link', 'opcion', 'option', 'selector', 'de', 'del', 'la', 'el', 'los', 'las', 'con', 'para', 'por', 'que', 'presionar', 'hacer', 'clic', 'click', 'verificar', 'validar', 'comprobar', 'ingresar', 'escribir', 'completar', 'mostrar', 'visible', 'texto']);
  const descriptionWords = new Set(normalized.split(/\W+/).filter(word => word.length > 2 && !genericWords.has(word)));
  const ranked = keys.map(key => {
    const keyWords = key.split(/\W+/).filter(word => word.length > 2 && !genericWords.has(word));
    const overlap = keyWords.filter(word => descriptionWords.has(word));
    return { key, score: overlap.length, coverage: overlap.length / Math.max(keyWords.length, 1) };
  }).sort((a, b) => b.score - a.score || b.coverage - a.coverage);
  const best = exact || (ranked[0]?.score > 0 ? ranked[0].key : undefined);
  if (best) return selectors.get(best);
  if (/iniciar sesion|login|autenticar/.test(normalized)) {
    const login = keys.find(key => /ingresar al sistema|iniciar sesion|login/.test(key));
    if (login) return selectors.get(login);
  }
  if (/usuario|correo|email/.test(normalized)) {
    const user = keys.find(key => /campo usuario|campo email|campo correo|username/.test(key));
    if (user) return selectors.get(user);
  }
  if (/contrase/.test(normalized)) {
    const password = keys.find(key => /campo contrase|campo password/.test(key));
    if (password) return selectors.get(password);
  }
  return {};
}
function recommendedLocator(candidate) {
  if (!candidate) return { selector: '', selectorType: '', candidates: {} };
  const ordered = [['XPath', candidate.xpath], ['CSS', candidate.css], ['Name', candidate.name], ['ID', candidate.id]];
  const first = ordered.find(([, value]) => clean(value));
  return { selector: first?.[1] || '', selectorType: first?.[0] || '', candidates: Object.fromEntries(ordered.filter(([, value]) => clean(value))) };
}
function analysisMatch(description) {
  if (!pageAnalysis?.elements?.length) return null;
  const words = normalize(description).split(/\W+/).filter(word => word.length > 2);
  const candidates = pageAnalysis.elements.map(el => {
    const label = normalize([el.text, el.aria, el.placeholder, el.name].join(' '));
    const exact = words.length && words.every(word => label.includes(word));
    const score = words.reduce((sum, word) => sum + (label.includes(word) ? 1 : 0), 0) / Math.max(words.length, 1);
    return { el, score: exact ? 1 : score };
  }).filter(item => item.score > 0).sort((a, b) => b.score - a.score);
  return candidates[0]?.el || null;
}
function stepFromText(text, index, selectors) {
  const line = clean(text).replace(/^(?:[-*•]|\d+[.)])\s*/, '');
  const action = actionFor(line);
  const selected = mapExplicitSelector(line, selectors);
  const inferred = action === 'navegar' ? {} : selected;
  const locator = recommendedLocator(inferred);
  const matched = !locator.selector && action !== 'navegar' ? analysisMatch(line) : null;
  const autoLocator = matched ? recommendedLocator({ xpath: matched.xpath, css: matched.css, name: matched.name, id: matched.id }) : null;
  const selectedLocator = locator.selector ? locator : autoLocator || locator;
  const override = [...confirmedDiscrepancies.values()].find(item => normalize(line).includes(normalize(item.requested)));
  if (override) {
    selectedLocator.selector = override.selector;
    selectedLocator.selectorType = override.selectorType;
    selectedLocator.candidates = { [override.selectorType]: override.selector };
  }
  const valueMatch = line.match(/(?:con|valor|texto)\s+["“']([^"”']+)["”']/i);
  const expectedMatch = line.match(/(?:mensaje|texto|resultado)\s*(?:esperado)?\s*[:=]?\s*["“']([^"”']+)["”']/i);
  const inferredExpected = line.match(/(?:verificar|validar|comprobar)\s+(?:que\s+)?(?:el\s+|la\s+)?(?:mensaje|texto|resultado)\s+(?:de\s+)?([^.;]+)/i)?.[1]?.trim();
  const explicitSectionExpected = line.match(/(?:secci[oó]n|categor[ií]a)\s+["“']([^"”']+)["”']/i)?.[1]?.trim() || '';
  const expected = expectedMatch?.[1] || inferredExpected || explicitSectionExpected;
  const pending = !['navegar', 'desplazar', 'validar_contenido'].includes(action) && !selectedLocator?.selector && !(action === 'validar' && expected);
  return {
    number: index + 1,
    name: line.slice(0, 100),
    action,
    selector: selectedLocator?.selector || '',
    selectorType: selectedLocator?.selectorType || '',
    candidates: selectedLocator?.candidates || {},
    value: valueMatch?.[1] || '',
    expected,
    description: line,
    pending,
  };
}
function xpathLiteral(value) {
  if (!String(value).includes("'")) return `'${value}'`;
  if (!String(value).includes('"')) return `"${value}"`;
  return `concat(${String(value).split("'").map(part => `'${part}'`).join(', "\'", ')})`;
}
function todoMvcPlan(text, url) {
  if (!/todomvc/i.test(url || '') || !/\b(?:tarea|tareas|todo)\b/i.test(text)) return null;
  const lines = text.split(/\r?\n/).map(clean);
  const quotePattern = /[“‘"']([^“”’"']+)[”’"']/g;
  const quoted = line => [...line.matchAll(quotePattern)].at(0)?.[1]?.trim() || '';
  const taskNames = [...new Set(lines.filter(line => /\b(?:agregar|añadir|crear)\b/i.test(line))
    .map(quoted).filter(Boolean))];
  const completedName = quoted(lines.find(line => /\b(?:marcar|completar)\b/i.test(line) && /\bcompletad[ao]\b/i.test(line)) || '');
  const editLine = lines.find(line => /\beditar\b/i.test(line) && (/\b(?:cambiar(?:la)?|renombrar(?:la)?)\b/i.test(line) || /\ba\s*[“‘"']/i.test(line) || [...line.matchAll(quotePattern)].length >= 2)) || '';
  const newName = [...editLine.matchAll(quotePattern)].at(-1)?.[1]?.trim() || '';
  if (taskNames.length < 2 || !completedName || !newName) return null;
  const [firstTask, secondTask] = taskNames;
  const row = name => `//li[.//label[normalize-space(.)=${xpathLiteral(name)}]]`;
  const checkbox = name => `${row(name)}//input[@type='checkbox']`;
  const label = name => `${row(name)}//label`;
  const steps = [];
  const add = (name, action, selector, selectorType = 'CSS', value = '', expected = '') => steps.push({
    number: steps.length + 1, name, description: name, action, selector, selectorType,
    candidates: selector ? { [selectorType]: selector } : {}, value, expected, pending: false,
  });
  add('Abrir TodoMVC', 'navegar', '', '', url);
  add(`Escribir tarea: ${firstTask}`, 'escribir', 'input.new-todo', 'CSS', firstTask);
  add('Confirmar primera tarea con Enter', 'presionar_tecla', 'input.new-todo', 'CSS', 'Enter');
  add(`Verificar tarea visible: ${firstTask}`, 'validar', label(firstTask), 'XPath', '', firstTask);
  add(`Escribir tarea: ${secondTask}`, 'escribir', 'input.new-todo', 'CSS', secondTask);
  add('Confirmar segunda tarea con Enter', 'presionar_tecla', 'input.new-todo', 'CSS', 'Enter');
  add('Verificar que existan exactamente dos tareas', 'validar_conteo', '.todo-list li', 'CSS', '', '2');
  add(`Verificar tarea visible: ${secondTask}`, 'validar', label(secondTask), 'XPath', '', secondTask);
  add(`Completar solo ${completedName}`, 'clic', checkbox(completedName), 'XPath');
  add(`Comprobar que ${completedName} quedó completada`, 'validar_marcado', checkbox(completedName), 'XPath');
  add(`Comprobar que ${secondTask} sigue activa`, 'validar_desmarcado', checkbox(secondTask), 'XPath');
  add('Abrir filtro Completed', 'clic', 'a[href="#/completed"]');
  add(`Completed muestra ${completedName}`, 'validar', label(completedName), 'XPath', '', completedName);
  add(`Completed oculta ${secondTask}`, 'validar_oculto', row(secondTask), 'XPath');
  add('Abrir filtro Active', 'clic', 'a[href="#/active"]');
  add(`Active oculta ${completedName}`, 'validar_oculto', row(completedName), 'XPath');
  add(`Active muestra ${secondTask}`, 'validar', label(secondTask), 'XPath', '', secondTask);
  add(`Iniciar edición de ${secondTask}`, 'doble_clic', label(secondTask), 'XPath');
  add(`Cambiar nombre a ${newName}`, 'escribir', 'input.edit', 'CSS', newName);
  add('Guardar edición con Enter', 'presionar_tecla', 'input.edit', 'CSS', 'Enter');
  add(`Verificar nombre actualizado: ${newName}`, 'validar', label(newName), 'XPath', '', newName);
  add(`Verificar que ya no figure ${secondTask}`, 'validar_oculto', row(secondTask), 'XPath');
  add('Volver al filtro Completed', 'clic', 'a[href="#/completed"]');
  add(`Completed conserva ${completedName}`, 'validar', label(completedName), 'XPath', '', completedName);
  add(`Completed oculta ${newName}`, 'validar_oculto', row(newName), 'XPath');
  add('Volver al filtro Active', 'clic', 'a[href="#/active"]');
  add(`Active oculta ${completedName}`, 'validar_oculto', row(completedName), 'XPath');
  add(`Active muestra ${newName}`, 'validar', label(newName), 'XPath', '', newName);
  return {
    steps,
    negativeScenario: {
      name: 'No crear tareas vacías',
      expected: 'La lista permanece vacía (0 tareas) después de enviar el campo vacío.',
      steps: [
        { name: 'Abrir TodoMVC para el caso vacío', description: 'Abrir TodoMVC para el caso vacío', action: 'navegar', selector: '', selectorType: '', candidates: {}, value: url, expected: '' },
        { name: 'Limpiar el campo de nueva tarea', description: 'Limpiar el campo de nueva tarea', action: 'limpiar', selector: 'input.new-todo', selectorType: 'CSS', candidates: { CSS: 'input.new-todo' }, value: '', expected: '' },
        { name: 'Enviar el campo vacío con Enter', description: 'Enviar el campo vacío con Enter', action: 'presionar_tecla', selector: 'input.new-todo', selectorType: 'CSS', candidates: { CSS: 'input.new-todo' }, value: 'Enter', expected: '' },
        { name: 'Verificar que la lista permanezca vacía', description: 'Verificar que la lista permanezca vacía', action: 'validar_conteo', selector: '.todo-list li', selectorType: 'CSS', candidates: { CSS: '.todo-list li' }, value: '', expected: '0' },
      ],
    },
  };
}
function makeSteps(text, url, selectors) {
  const todoPlan = todoMvcPlan(text, url);
  if (todoPlan) return todoPlan.steps;
  const stepsText = section(text, '(?:Pasos de ejecución|Pasos de prueba|Flujo de ejecución|Flujo esperado|Flujo funcional esperado|Escenario)');
  let lines = stepsText.split(/\r?\n/).map(clean).filter(Boolean);
  if (!lines.length) {
    const actionLines = text.split(/\r?\n/).map(clean).filter(line => /^(?:(?:Cuando|Then|Y|-\s*Cuando)\b|\d+[.)](?:\s|$))/i.test(line) || /^(?:Given|When|Then)\b/i.test(line));
    lines = actionLines.map(line => line.replace(/^(?:Given|When|Then|Dado que|Cuando|Entonces|Y)\s*/i, ''));
  }
  const expandedLines = [];
  let readingSectionNames = false;
  for (const line of lines) {
    const normalized = normalize(line.replace(/^(?:[-*•]|\d+[.)])\s*/, ''));
    if (/verificar|validar|comprobar/.test(normalized) && /siguientes secciones|secciones mencionadas|categorias disponibles/.test(normalized)) {
      readingSectionNames = true;
      continue;
    }
    if (readingSectionNames && !/^(dentro de|desplaz|verificar|validar|comprobar|confirmar|[🎯📝⚠️✅])/.test(normalized)) {
      expandedLines.push(`Verificar sección "${line.replace(/^[•*\-\d.)\s]+/, '').trim()}"`);
      continue;
    }
    readingSectionNames = false;
    if (/dentro de cada seccion/.test(normalized)) {
      expandedLines.push('Verificar que cada sección contiene títulos de películas visibles');
      continue;
    }
    if (/al menos una pelicula de cada categoria/.test(normalized)) {
      expandedLines.push('Verificar títulos visibles en cada categoría');
      continue;
    }
    expandedLines.push(line);
  }
  lines = expandedLines;
  if (!lines.length) {
    lines = [];
    if (url) lines.push('Navegar a la URL indicada');
    if (/inicio de sesion|login|autenticar/i.test(text)) {
      lines.push('Ingresar usuario de prueba');
      lines.push('Ingresar contraseña de prueba');
      lines.push('Iniciar sesión');
    }
    if (url) lines.push('Verificar que la página cargue y muestre contenido visible');
  }
  lines = lines.flatMap(line => {
    const parts = line.split(/\s+y\s+(?=(?:verificar|validar|comprobar)\b)/i);
    return parts.length > 1 ? [parts[0], ...parts.slice(1).map(part => `Verificar ${part.replace(/^(?:verificar|validar|comprobar)\s+/i, '')}`)] : [line];
  });
  return lines.map((line, index) => {
    const step = stepFromText(line, index, selectors);
    if (step.action === 'navegar' && !step.value) step.value = url;
    return step;
  });
}
function sensitiveWarnings(text) {
  const patterns = [
    ['correo electrónico', /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i],
    ['posible contraseña o token', /^\s*(?:usuario|correo|email|contrase(?:ña|na)|password|token|api[_ -]?key)(?:\s+(?:v[aá]lido|v[aá]lida|inv[aá]lido|inv[aá]lida))?\s*[:=]\s*(?!xpath\b|css\b|selector\b|variable\b|\$\{)([^\n]{4,})/im],
    ['posible contraseña', /(?:contrase(?:ña|na)|password)[^\n]{0,80}\bcon\s+["“'][^"”']+["”']/i],
    ['número telefónico', /(?:\+?\d[\d ()-]{8,}\d)/],
  ];
  return patterns.filter(([, regex]) => regex.test(text)).map(([label]) => `⚠️ AVISO: Se detectó ${label} en la descripción. Se conserva tal como fue escrito; se recomienda sustituirlo por una variable de prueba.`);
}
function parseRequirement(text) {
  const title = text.match(/(?:REQUERIMIENTO FUNCIONAL|HISTORIA DE USUARIO|NOMBRE DE PRUEBA)\s*:\s*([^\n]+)/i)?.[1]?.trim()
    || text.split(/\r?\n/).find(line => clean(line))?.replace(/^#+\s*/, '').slice(0, 100) || 'Flujo funcional';
  const role = text.match(/Como\s+([^,.;\n]+)/i)?.[1]?.trim() || text.match(/Solo usuarios con perfil\s+([^.,\n]+)/i)?.[1]?.trim() || 'usuario';
  const goal = text.match(/quiero\s+(.+?)(?:,?\s+para\s+|[.;\n])/i)?.[1]?.trim() || text.match(/quiero\s+([^.;\n]+)/i)?.[1]?.trim() || `completar ${title.toLowerCase()}`;
  const outcome = text.match(/para\s+(que\s+[^.;\n]+)/i)?.[1]?.trim() || text.match(/para\s+([^.;\n]+)/i)?.[1]?.trim() || 'obtener el resultado esperado';
  const selectors = extractSelectors(text);
  const url = getUrl(text);
  const rulesText = section(text, 'Reglas de negocio');
  const rules = rulesText ? rulesText.split(/\r?\n/).map(line => clean(line).replace(/^[-*•]\s*/, '')).filter(Boolean) : [];
  const todoPlan = todoMvcPlan(text, url);
  const steps = todoPlan?.steps || makeSteps(text, url, selectors);
  const explicitData = [...text.matchAll(/^\s*(usuario|correo|email|contrase(?:ña|na)|password|token)(?:\s+(v[aá]lido|v[aá]lida|inv[aá]lido|inv[aá]lida))?\s*[:=]\s*(?!xpath\b|css\b|selector\b|variable\b|\$\{)([^\n]+?)\s*$/gim)].map(match => ({ campo: `${match[1]} ${match[2] || (normalize(match[1]).includes('contrase') || normalize(match[1]) === 'password' ? 'valida' : 'valido')}`, valor: match[3].trim() }));
  const testData = Object.fromEntries(explicitData.map(item => [normalize(item.campo).replace(/\s+/g, '_'), item.valor]));
  for (const step of steps) {
    if (step.action !== 'escribir' || step.value) continue;
    if (/contrase/.test(normalize(step.description))) {
      step.value = Object.entries(testData).find(([key]) => /contrase|password/.test(key))?.[1] || '${contrasena_valida}';
      testData.contrasena_valida ||= step.value;
    } else if (/usuario|correo|email/.test(normalize(step.description))) {
      step.value = Object.entries(testData).find(([key]) => /usuario|correo|email/.test(key))?.[1] || '${usuario_valido}';
      testData.usuario_valido ||= step.value;
    }
    if (step.action === 'escribir' && step.value && !/^\$\{[^}]+\}$/.test(step.value)) {
      const description = normalize(step.description);
      const fieldKey = /contrase|password/.test(description) ? 'contrasena_valida'
        : /usuario|correo|email/.test(description) ? 'usuario_valido'
          : /apellido|last.?name/.test(description) ? 'apellido'
            : /codigo postal|postal.?code|zip/.test(description) ? 'codigo_postal'
              : /nombre|first.?name/.test(description) ? 'nombre'
                : /telefono|phone/.test(description) ? 'telefono'
                  : /direccion|address/.test(description) ? 'direccion' : '';
      if (fieldKey) testData[fieldKey] = step.value;
    }
  }
  const negativeMatch = text.match(/caso negativo[^\n]*?usa\s+([A-Za-z0-9_.@+-]+)\s+con\s+([A-Za-z0-9_.@+-]+)[^\n]*?(?:mostrar|ver)\s+["“'](.+?)["”']/i);
  let negativeScenario = todoPlan?.negativeScenario || { name: '', steps: [], expected: '' };
  if (negativeMatch && url) {
    const findSelector = pattern => [...selectors.entries()].find(([label]) => pattern.test(label))?.[1] || {};
    const userSelector = recommendedLocator(findSelector(/usuario|correo|email|username/i));
    const passwordSelector = recommendedLocator(findSelector(/contrase|password/i));
    const loginSelector = recommendedLocator(findSelector(/login|iniciar sesion|ingresar al sistema/i));
    const errorSelector = recommendedLocator(findSelector(/error|alert|mensaje|resultado/i));
    negativeScenario = {
      name: 'Rechazar el acceso con credenciales negativas',
      expected: negativeMatch[3],
      steps: [
        { name: 'Abrir el acceso', action: 'navegar', selector: '', selectorType: '', candidates: {}, value: url, description: 'Abrir el acceso' },
        { name: 'Ingresar usuario negativo', action: 'escribir', ...userSelector, value: negativeMatch[1], description: 'Ingresar usuario negativo' },
        { name: 'Ingresar contraseña de prueba', action: 'escribir', ...passwordSelector, value: negativeMatch[2], description: 'Ingresar contraseña de prueba' },
        { name: 'Enviar credenciales', action: 'clic', ...loginSelector, value: '', description: 'Enviar credenciales' },
        { name: 'Comprobar mensaje de rechazo', action: 'validar', selector: errorSelector.selector || 'body', selectorType: errorSelector.selectorType || 'CSS', candidates: errorSelector.candidates || { CSS: 'body' }, value: '', expected: negativeMatch[3], description: 'Comprobar mensaje de rechazo' },
      ],
    };
    testData.usuario_negativo = negativeMatch[1];
    testData.contrasena_negativa = negativeMatch[2];
  }
  const path = url ? new URL(url).pathname || '/' : '/';
  return {
    title, role, goal, outcome, url, path, selectors, rules,
    steps,
    warnings: sensitiveWarnings(text),
    testData,
    negativeScenario,
    pending: [],
    requirementText: text,
  };
}
function getTestTypes() { return [...document.querySelectorAll('input[name="test-type"]:checked')].map(input => input.value).length ? [...document.querySelectorAll('input[name="test-type"]:checked')].map(input => input.value) : ['funcional']; }
function checkOutputSelections() {
  if (!['#want-json', '#want-python', '#want-java-selenium', '#want-java-testng'].some(selector => document.querySelector(selector).checked)) {
    alert('Seleccioná al menos una salida: JSON, Python o Java.');
    return false;
  }
  return true;
}
function findDiscrepancy(data) {
  if (!pageAnalysis?.elements?.length) return null;
  const labels = [...data.requirementText.matchAll(/(?:bot[oó]n|enlace|campo|opci[oó]n)\s+["“']([^"”']+)["”']/gi)].map(match => match[1]);
  for (const requested of labels) {
    if (confirmedDiscrepancies.has(normalize(requested))) continue;
    const exact = pageAnalysis.elements.some(el => normalize([el.text, el.aria, el.placeholder, el.name].join(' ')) === normalize(requested));
    if (exact) continue;
    const requestedWords = normalize(requested).split(/\W+/).filter(word => word.length > 2);
    const candidates = pageAnalysis.elements.filter(el => /button|a|input|select|textarea/.test(el.tag)).map(el => {
      const label = normalize([el.text, el.aria, el.placeholder, el.name, el.id].join(' '));
      const score = requestedWords.reduce((sum, word) => sum + (label.includes(word) ? 1 : 0), 0);
      return { el, score };
    }).filter(item => item.score > 0).sort((a, b) => b.score - a.score).slice(0, 6).map(item => item.el);
    const explicit = data.selectors.get(normalize(`Botón "${requested}"`)) || data.selectors.get(normalize(`Enlace "${requested}"`)) || data.selectors.get(normalize(`Campo "${requested}"`));
    const explicitLocator = explicit && recommendedLocator(explicit).selector;
    const step = data.steps.find(item => normalize(item.description).includes(normalize(requested)))
      || (explicitLocator && data.steps.find(item => item.selector === explicitLocator))
      || data.steps.find(item => item.action === 'clic' && /enviar|ingresar|iniciar|confirmar|continuar/.test(normalize(item.description)))
      || data.steps.find(item => !item.selector && item.action !== 'navegar');
    if (step && candidates.length) return { requested, step, candidates };
  }
  return null;
}
function askDiscrepancy(discrepancy) {
  activeDiscrepancy = { ...discrepancy, warning: '' };
  document.querySelector('#discrepancy-copy').textContent = `No se encontró exactamente “${discrepancy.requested}”. La página sí contiene estos elementos. ¿Cuál querés usar?`;
  const options = document.querySelector('#discrepancy-options');
  options.replaceChildren();
  for (const element of discrepancy.candidates) {
    const item = recommendedLocator({ xpath: element.xpath, css: element.css, name: element.name, id: element.id });
    const label = element.text || element.aria || element.placeholder || `${element.tag} ${element.name || element.id}`;
    const row = document.createElement('label');
    row.className = 'selector-option';
    row.innerHTML = `<input type="radio" name="suggested-selector" value="${escapeHtml(JSON.stringify({ ...item, label }))}"><strong>${escapeHtml(label)}</strong><br><small>${escapeHtml(item.selectorType)} · ${escapeHtml(item.selector)}</small>`;
    options.append(row);
  }
  document.querySelector('#manual-selector').value = '';
  discrepancyDialog.showModal();
}
async function preparePreview() {
  if (!checkOutputSelections()) return;
  const targetPlatform = platformInput.value || 'web';
  const text = clean(input.value);
  if (text.length < 20) { input.focus(); alert('Ingresá al menos 20 caracteres en el requerimiento.'); return; }
  if (text.length > MAX_REQ_CHARS) { input.focus(); alert(`El límite es ${MAX_REQ_CHARS} caracteres.`); return; }
  if (targetPlatform === 'web' && (modeInput.value === 'url' || modeInput.value === 'mixed') && !getUrl(text)) { urlInput.focus(); alert('Ingresá una URL http(s) para este modo.'); return; }
  const targetUrl = targetPlatform === 'web' ? getUrl(text) : '';
  if (targetUrl) {
    try { if (!['http:', 'https:'].includes(new URL(targetUrl).protocol)) throw new Error(); }
    catch { urlInput.focus(); alert('La URL debe comenzar con http:// o https://.'); return; }
  }
  if (modeInput.value !== 'requirement' && pageAnalysis && targetUrl && new URL(targetUrl).origin !== new URL(pageAnalysis.url).origin) pageAnalysis = null;
  let aiInterpretation = null;
  if (document.querySelector('#use-llm').checked) {
    if (!sessionApiKey) { alert('Ingresá una API Key de OpenAI para activar las funciones del SuperAgente.'); return; }
    const cacheKey = `${modeInput.value}\n${targetUrl}\n${text}`;
    if (cachedInterpretation && cacheKey === cachedInterpretationKey) {
      aiInterpretation = cachedInterpretation;
    } else {
      const sensitive = sensitiveWarnings(text);
      if (sensitive.length && !window.confirm(`${sensitive.join('\n')}\n\nEl requerimiento se enviará a OpenAI junto con tu clave para generar la interpretación. ¿Continuar?`)) return;
      try {
        previewButton.disabled = true;
        speak('Dame un momento, estoy analizando tu requerimiento…');
        const response = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionApiKey}` }, body: JSON.stringify({ model: 'gpt-4.1-mini', temperature: 0.2, response_format: { type: 'json_object' }, messages: [
          { role: 'system', content: 'Eres SuperAgente FlowBDD, analista QA senior. Devuelve JSON válido con claves title, role, goal, outcome, rules (array), steps (array de {name, action, value, expected, selector, selectorType}), extra_scenarios (array strings), recommended_test_types (array con humo, funcional, regresion, integracion, carga), selector_advice (array strings), questions (array strings), code_comments (array strings). Ordena requerimientos desordenados, conserva el comportamiento escrito, sugiere casos adicionales y tipos de prueba. No inventes URLs, credenciales ni selectores: usa selector vacío si el DOM no los confirma. Si falta información, formula preguntas y marca los pasos incompletos como manual. Distingue pruebas de UI de integraciones reales y de carga concurrente.' },
          { role: 'user', content: JSON.stringify({ mode: modeInput.value, url: targetUrl, requirement: text, detected_controls: pageAnalysis?.elements?.filter(element => element.visible).slice(0, 100) || [] }) },
        ] }) });
        const body = await response.json();
        if (!response.ok || body.error) { const message = body.error?.message || body.error || `HTTP ${response.status}`; speak(`Encontré un inconveniente: ${message}. Revisá y volvé a intentar.`); alert(`OpenAI no pudo interpretar el requerimiento: ${message}`); return; }
        const content = body.choices?.[0]?.message?.content;
        if (!content) throw new Error('OpenAI no devolvió una interpretación en JSON.');
        aiInterpretation = JSON.parse(content);
        cachedInterpretation = aiInterpretation;
        cachedInterpretationKey = cacheKey;
      } catch (error) {
        speak(`Encontré un inconveniente: ${error.message}. Revisá y volvé a intentar.`);
        alert(`No se pudo contactar OpenAI: ${error.message}`);
        return;
      } finally {
        previewButton.disabled = false;
      }
    }
  }
  const data = parseRequirement(text);
  if (aiInterpretation) {
    data.title = clean(aiInterpretation.title) || data.title;
    data.role = clean(aiInterpretation.role) || data.role;
    data.goal = clean(aiInterpretation.goal) || data.goal;
    data.outcome = clean(aiInterpretation.outcome) || data.outcome;
    data.aiSuggestions = {
      extraScenarios: Array.isArray(aiInterpretation.extra_scenarios) ? aiInterpretation.extra_scenarios.map(clean).filter(Boolean).slice(0, 12) : [],
      recommendedTypes: Array.isArray(aiInterpretation.recommended_test_types) ? aiInterpretation.recommended_test_types.filter(type => ['humo', 'funcional', 'regresion', 'integracion', 'carga'].includes(type)) : [],
      selectorAdvice: Array.isArray(aiInterpretation.selector_advice) ? aiInterpretation.selector_advice.map(clean).filter(Boolean).slice(0, 12) : [],
      questions: Array.isArray(aiInterpretation.questions) ? aiInterpretation.questions.map(clean).filter(Boolean).slice(0, 12) : [],
    };
    data.aiCodeComments = Array.isArray(aiInterpretation.code_comments) ? aiInterpretation.code_comments.map(clean).filter(Boolean).slice(0, 16) : [];
      data.aiSuggestions.selectorAdvice ||= [];
    if (Array.isArray(aiInterpretation.rules)) data.rules = [...new Set([...data.rules, ...aiInterpretation.rules.map(clean).filter(Boolean)])];
    if (Array.isArray(aiInterpretation.steps) && aiInterpretation.steps.length) {
      data.steps = aiInterpretation.steps.map((item, index) => {
        const name = typeof item === 'string' ? item : clean(item.name || item.description) || `Paso ${index + 1}`;
        const step = stepFromText(name, index, data.selectors);
        if (typeof item === 'object') {
          if (['navegar', 'escribir', 'clic', 'validar', 'esperar', 'manual', 'doble_clic', 'presionar_tecla', 'validar_conteo', 'validar_oculto', 'validar_marcado', 'validar_desmarcado'].includes(normalize(item.action))) step.action = normalize(item.action);
          if (clean(item.value)) step.value = String(item.value);
          if (clean(item.expected)) step.expected = String(item.expected);
          const suggestedSelector = clean(item.selector);
          if (suggestedSelector) {
            const detected = pageAnalysis?.elements?.find(element => [element.xpath, element.css, element.name, element.id ? `#${element.id}` : ''].includes(suggestedSelector));
            const explicitlyProvided = [...data.selectors.values()].some(candidate => Object.values(candidate).includes(suggestedSelector));
            if (detected || explicitlyProvided) {
              step.selector = suggestedSelector;
              step.selectorType = detected?.xpath === suggestedSelector ? 'XPath' : detected?.css === suggestedSelector ? 'CSS' : detected?.name === suggestedSelector ? 'Name' : clean(item.selectorType) || 'ID';
              step.candidates = detected ? Object.fromEntries([['XPath', detected.xpath], ['CSS', detected.css], ['Name', detected.name], ['ID', detected.id ? `#${detected.id}` : '']].filter(([, selector]) => selector)) : { [step.selectorType]: suggestedSelector };
            } else {
              data.aiSuggestions.selectorAdvice.push(`Selector sugerido por IA no verificado en el DOM y no aplicado: ${suggestedSelector}`);
            }
          }
        }
        step.pending = step.action !== 'navegar' && !step.selector;
        return step;
      });
    }
  }
  data.url = targetPlatform === 'web' ? (getUrl(text) || data.url) : '';
  if (data.url) data.path = new URL(data.url).pathname || '/';
  else if (targetPlatform !== 'web') data.path = '/';
  data.testTypes = getTestTypes();
  if (data.aiSuggestions?.recommendedTypes?.length) {
    data.suggestedTestTypes = data.aiSuggestions.recommendedTypes;
  }
  data.targetPlatform = targetPlatform;
  data.platformConfig = {
    appiumServerUrl: clean(document.querySelector('#appium-server-url').value),
    desktopAppPath: clean(document.querySelector('#desktop-app-path').value),
    mobileOs: document.querySelector('#mobile-os').value,
    deviceName: clean(document.querySelector('#mobile-device').value),
    mobileAppId: clean(document.querySelector('#mobile-app-id').value),
    mobileAppPath: clean(document.querySelector('#mobile-app-path').value),
  };
  data.generatedAt = nowLocal();
  data.timeoutSeconds = 5;
  data.stepDelayMs = 1800;
  data.iterations = 1;
  data.concurrentUsers = 1;
  data.negativeScenario ||= { name: '', steps: [], expected: '' };
  data.useOcr = document.querySelector('#use-ocr').checked;
  data.ocrWarning = pageAnalysis?.ocr_warning || '';
  if (data.useOcr) data.warnings.push('OCR activo como apoyo de identificación visual. El texto reconocido y sus coordenadas requieren revisión manual; no sustituyen selectores DOM.');
  if (targetPlatform === 'desktop') {
    data.warnings.push('Escritorio Windows genera una plantilla Appium. Requiere servidor Appium, el driver Windows compatible (basado en WinAppDriver) y una ruta .exe o ID UWP; la ejecución visual Chrome no aplica. Revisa los requisitos del driver para tu versión de Windows.');
    if (!data.platformConfig.desktopAppPath) data.pending.push({ description: 'Aplicación de escritorio', recommendation: 'Completar la ruta del ejecutable o el ID UWP antes de ejecutar el script.' });
  } else if (targetPlatform === 'mobile') {
    data.warnings.push(`Móvil ${data.platformConfig.mobileOs} genera una plantilla Appium. Requiere dispositivo/emulador, servidor Appium y driver ${data.platformConfig.mobileOs === 'iOS' ? 'XCUITest en macOS' : 'UiAutomator2'}. Usa Accessibility ID o selectores nativos revisados.`);
    if (!data.platformConfig.mobileAppId && !data.platformConfig.mobileAppPath) data.pending.push({ description: 'Aplicación móvil', recommendation: 'Completar package/bundle ID o la ruta de APK/IPA/APP antes de ejecutar el script.' });
    if (!data.platformConfig.deviceName) data.pending.push({ description: 'Dispositivo móvil', recommendation: 'Completar el nombre o UDID del dispositivo/simulador.' });
  }
  if (targetPlatform !== 'web') {
    for (const step of data.steps) {
      if (step.selectorType === 'CSS') data.pending.push({ description: step.description, recommendation: 'El selector CSS es de navegador. Sustituirlo por Accessibility ID, ID, Name, Class Name o XPath nativo inspeccionado.' });
      if (['desplazar', 'manual'].includes(step.action)) data.pending.push({ description: step.description, recommendation: 'La acción requiere completar el gesto o interacción para la aplicación y el dispositivo objetivo.' });
    }
  }
  if (targetPlatform !== 'web' && data.testTypes.includes('carga')) data.warnings.push('La suite Appium prueba la interfaz nativa; no simula usuarios concurrentes. Usa una herramienta de carga de API/backend para medir estrés.');
  data.pageMap = pageAnalysis?.elements?.filter(item => item.visible).map((item, index) => ({
    id: index + 1,
    page_url: pageAnalysis.url || targetUrl || '',
    tag: item.tag,
    label: item.text || item.aria || item.placeholder || item.name || item.id || item.tag,
    role: item.role || '',
    selector_candidates: [
      ['XPath', item.xpath], ['CSS', item.css], ['Name', item.name], ['ID', item.id],
    ].filter(([, selector]) => selector).map(([type, selector]) => ({ type, selector, verified_visible: Boolean(item.visible) })),
    href: item.href || '',
    disabled: Boolean(item.disabled),
    verification: item.visible ? 'visible_en_analisis' : 'no_verificado',
  })) || [];
  data.ocrElements = pageAnalysis?.ocr_elements || [];
  data.source = [modeInput.value === 'requirement' ? 'requerimiento' : modeInput.value === 'url' ? 'analisis_url' : 'requerimiento', ...(pageAnalysis ? ['analisis_url'] : []), ...(aiInterpretation ? ['interpretacion_llm'] : [])];
  data.warnings = [...new Set([...data.warnings, ...(aiInterpretation ? ['Interpretación generada por LLM: revisar historia, acciones y validaciones antes de confirmar.'] : []), ...(pageAnalysis?.warning ? [pageAnalysis.warning] : []), ...(data.ocrWarning ? [data.ocrWarning] : []), ...[...confirmedDiscrepancies.values()].map(item => `Se confirmó usar “${item.label}” como equivalente de “${item.requested}”; validar manualmente.`), ...(!pageAnalysis && data.url ? ['La URL no se analizó automáticamente. Los selectores deben validarse manualmente.'] : []), ...(data.steps.some(step => !['navegar', 'desplazar', 'validar_contenido'].includes(step.action) && !step.selector) ? ['Hay pasos que necesitan selector; completarlos o validarlos manualmente antes de ejecutar.'] : [])])];
  if (data.testTypes.includes('integracion')) data.warnings.push('El caso de integración generado valida la interfaz. No afirma validar API, base de datos ni servicios externos si no se configuraron esos puntos de integración.');
  if (data.targetPlatform === 'web' && data.testTypes.includes('carga')) data.warnings.push('Python + Playwright ejecuta usuarios concurrentes en Chromium headless. La ejecución visual de una sola ventana repite el flujo en serie y no mide carga concurrente.');
  data.platformPending = [...data.pending];
  data.pending = [...data.platformPending, ...data.steps.filter(step => step.pending).map(step => ({ description: step.description, recommendation: '⚠️ PENDIENTE DE VALIDACIÓN MANUAL: No se pudo detectar este elemento automáticamente. Completar selector y acción manualmente si es necesario.' }))];
  if (data.testTypes.includes('regresion')) {
    data.pending.push({ description: 'Escenario negativo de regresión', recommendation: 'Definir el caso negativo con pasos, datos inválidos y mensaje esperado en la vista previa para que pueda ejecutarse.' });
    data.warnings.push('El caso negativo solo se ejecutará cuando su flujo, datos y resultado esperado estén completos; de lo contrario quedará omitido explícitamente.');
  }
  if (pageAnalysis?.auth_required) data.warnings.push('La página muestra señales de autenticación; verificar que el análisis se realizó con acceso válido.');
  const discrepancy = findDiscrepancy(data);
  if (discrepancy) { askDiscrepancy(discrepancy); return; }
  renderPreview(data);
  if (aiInterpretation) {
    speak(`¡Listo! Detecté ${data.steps.length} pasos y ${data.pageMap?.length || 0} elementos. Revisá cuando quieras.`);
  }
}
function bddFor(data) {
  const testType = data.testTypes.join(', ') || 'funcional';
  const mainSteps = data.testTypes.includes('humo') ? data.steps.slice(0, 4) : data.steps;
  const clauses = mainSteps.map((step, index) => {
    const prefix = index === 0 ? 'Dado que' : (step.action === 'validar' || step.action.startsWith('validar_') || step.action === 'validar_contenido') ? 'Entonces' : 'Cuando';
    return `    ${prefix} ${step.description}`;
  });
  const output = [`Característica: ${data.title}`, `  Como ${data.role}`, `  Quiero ${data.goal}`, `  Para ${data.outcome}`, '', `  Escenario (${testType}): Flujo principal`, ...clauses];
  if (data.testTypes.includes('regresion')) {
    const negative = data.negativeScenario || {};
    output.push('', `  Escenario: ${negative.name || 'Rechazar datos que incumplen una regla'}`);
    const steps = Array.isArray(negative.steps) ? negative.steps : [];
    if (steps.length) steps.forEach((step, index) => output.push(`    ${index === 0 ? 'Dado que' : (step.action === 'validar' || step.action.startsWith('validar_') || step.action === 'validar_contenido') ? 'Entonces' : 'Cuando'} ${step.name || step.description || `paso ${index + 1}`}`));
    else output.push('    Dado que se proporcionan datos inválidos o un estado no permitido', '    Cuando se intenta completar la acción protegida', '    Entonces el sistema muestra el error definido para la regla correspondiente');
    if (negative.expected && steps.some(step => step.action === 'validar' && step.expected)) output.push(`    Y el mensaje visible contiene "${negative.expected}"`);
  }
  return output.join('\n');
}
function stepEditor(step, index) {
  const actionOptions = ['navegar', 'desplazar', 'escribir', 'limpiar', 'clic', 'doble_clic', 'presionar_tecla', 'validar', 'validar_contenido', 'validar_oculto', 'validar_conteo', 'validar_marcado', 'validar_desmarcado', 'esperar', 'manual'];
  const typeOptions = previewData?.targetPlatform === 'web' ? ['XPath', 'CSS', 'Name', 'ID'] : ['XPath', 'Accessibility ID', 'ID', 'Name', 'Class Name'];
  return `<article class="preview-step" data-step="${index}">
    <span class="step-number">${index + 1}</span>
    <div><label>Nombre / descripción</label><input data-field="name" value="${escapeHtml(step.name)}"><label>Acción</label><select data-field="action">${actionOptions.map(option => `<option ${step.action === option ? 'selected' : ''}>${option}</option>`).join('')}</select></div>
    <div><label>Selector</label><input data-field="selector" value="${escapeHtml(step.selector)}" placeholder="Completar selector"><label>Tipo de selector</label><select data-field="selectorType"><option value="">Sin definir</option>${typeOptions.map(option => `<option ${step.selectorType === option ? 'selected' : ''}>${option}</option>`).join('')}</select></div>
    <textarea data-field="value" placeholder="Valor de prueba">${escapeHtml(step.value)}</textarea><textarea data-field="expected" placeholder="Validación esperada">${escapeHtml(step.expected)}</textarea>
    ${step.pending && !step.selector ? '<div class="alert">⚠️ PENDIENTE DE VALIDACIÓN MANUAL: No se pudo detectar este elemento automáticamente.</div>' : ''}
    </article>`;
}
function renderPreview(data) {
  previewData = data;
  const warnings = data.warnings.length ? `<div class="preview-section"><h3>Advertencias</h3><ul class="warning-list">${data.warnings.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul></div>` : '';
  const pending = data.pending.length ? `<div class="preview-section"><h3>Elementos pendientes</h3><ul class="pending-list">${data.pending.map(item => `<li>${escapeHtml(item.recommendation)} — ${escapeHtml(item.description)}</li>`).join('')}</ul></div>` : '';
  const types = data.testTypes.length ? data.testTypes.join(', ') : 'funcional';
  const ai = data.aiSuggestions;
  const suggestions = ai ? `<section class="preview-section ai-suggestions"><h3>✨ Sugerencias del SuperAgente</h3>${ai.extraScenarios.length ? `<strong>Escenarios que podrías agregar</strong><ul>${ai.extraScenarios.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : ''}${ai.recommendedTypes.length ? `<p><strong>Tipos sugeridos:</strong> ${escapeHtml(ai.recommendedTypes.join(', '))}</p><button class="secondary-button" id="apply-ai-test-types" type="button">Aplicar tipos sugeridos</button>` : ''}${ai.selectorAdvice.length ? `<strong>Revisión de selectores</strong><ul>${ai.selectorAdvice.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : ''}${ai.questions.length ? `<strong>Dudas para completar</strong><ul>${ai.questions.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : ''}</section>` : '';
  const ocrPanel = data.useOcr ? `<section class="preview-section"><h3>Lectura OCR · requiere revisión manual</h3><p class="hint">El OCR identifica texto y coordenadas de pantalla; no genera selectores ejecutables ni confirma que el elemento sea interactivo.</p>${data.ocrWarning ? `<div class="alert">${escapeHtml(data.ocrWarning)}</div>` : ''}${data.ocrElements?.length ? `<ul class="ocr-list">${data.ocrElements.slice(0, 40).map(item => `<li><strong>${escapeHtml(item.text)}</strong><span>x:${item.x}, y:${item.y} · confianza ${item.confidence}%</span></li>`).join('')}</ul>` : '<p class="hint">No hay texto OCR disponible. Analizá la URL con la casilla OCR activa; requiere Tesseract instalado.</p>'}</section>` : '';
  result.innerHTML = `<div class="preview-header"><h2>02 · Vista previa editable</h2><span>${data.steps.length} PASOS</span></div>
    <p class="preview-summary"><strong>${escapeHtml(data.title)}</strong><br>Como ${escapeHtml(data.role)}, quiero ${escapeHtml(data.goal)}, para ${escapeHtml(data.outcome)}.<br>Plataforma: ${escapeHtml(data.targetPlatform || 'web')} · URL: ${escapeHtml(data.url || 'sin URL')} · Tipo: ${escapeHtml(types)}</p>
    ${warnings}${pending}${suggestions}${ocrPanel}
    <section class="preview-section"><h3>Historia de usuario</h3><textarea id="edit-story">Como ${escapeHtml(data.role)}, quiero ${escapeHtml(data.goal)}, para ${escapeHtml(data.outcome)}.</textarea></section>
    ${data.pageMap?.length ? `<section class="preview-section"><h3>Mapa real de controles (${data.pageMap.length})</h3><p class="hint">Selectores hallados durante el análisis. “Visible en análisis” confirma que el control se vio; la unicidad se valida al ejecutar la acción.</p><div class="code-box">${data.pageMap.map(item => `<p><strong>${escapeHtml(item.label)}</strong> · ${escapeHtml(item.tag)}${item.disabled ? ' · deshabilitado' : ''}<br>${item.selector_candidates.map(candidate => `<small>${escapeHtml(candidate.type)}: ${escapeHtml(candidate.selector)}</small>`).join('<br>')}</p>`).join('')}</div></section>` : ''}
    <section class="preview-section"><h3>Datos de prueba identificados (JSON editable)</h3><textarea id="edit-test-data">${escapeHtml(JSON.stringify(data.testData, null, 2))}</textarea></section>
    ${data.testTypes.includes('regresion') ? `<section class="preview-section"><h3>Caso negativo de regresión (JSON editable)</h3><p class="hint">Completá los pasos, datos inválidos y validación esperada. Si faltan datos, el script lo informará como omitido.</p><textarea id="edit-negative-scenario">${escapeHtml(JSON.stringify(data.negativeScenario || { name: '', steps: [], expected: '' }, null, 2))}</textarea></section>` : ''}
    <section class="preview-section"><h3>Pasos, selectores y validaciones</h3><div id="steps-editor">${data.steps.map(stepEditor).join('')}</div><button class="secondary-button" id="add-step" type="button">+ Agregar paso</button></section>
    <section class="preview-section"><h3>Escenario BDD (editable)</h3><textarea id="bdd-preview">${escapeHtml(bddFor(data))}</textarea></section>
    ${data.targetPlatform !== 'web' ? `<section class="preview-section"><h3>Configuración nativa Appium</h3><pre class="code-box">${escapeHtml(JSON.stringify(data.platformConfig, null, 2))}</pre><p class="hint">Los selectores web CSS no se pueden reutilizar directamente en apps nativas. Usá Accessibility ID, ID, Name, Class Name o XPath inspeccionados en el dispositivo.</p></section>` : ''}
    <section class="preview-section"><h3>Configuración de ejecución</h3><div class="preview-step"><label>Timeout por elemento (segundos)<input type="number" min="1" max="300" data-setting="timeoutSeconds" value="${data.timeoutSeconds}"></label><label>Pausa entre acciones (ms)<input type="number" min="0" max="5000" step="100" data-setting="stepDelayMs" value="${data.stepDelayMs ?? 1800}"></label><label>Iteraciones por usuario (máx. 100)<input type="number" min="1" max="100" data-setting="iterations" value="${data.iterations}"></label><label>Usuarios simultáneos (máx. 25)<input type="number" min="1" max="25" data-setting="concurrentUsers" value="${data.concurrentUsers}"></label></div></section>
    <div id="artifact-error" class="alert error" role="alert" hidden></div><div class="preview-footer"><button class="generate" id="confirm-generate" type="button">✅ Confirmar y Generar</button><button class="secondary-button" id="edit-again" type="button">Volver a editar entrada</button></div>`;
  result.querySelector('#add-step').addEventListener('click', () => {
    data.steps.push({ number: data.steps.length + 1, name: 'Nuevo paso', action: 'manual', selector: '', selectorType: '', value: '', expected: '', description: 'Nuevo paso de prueba', pending: true });
    renderPreview(data);
  });
  result.querySelector('#edit-negative-scenario')?.addEventListener('input', event => {
    try {
      const scenario = JSON.parse(event.currentTarget.value);
      if (scenario && Array.isArray(scenario.steps)) {
        data.negativeScenario = scenario;
        result.querySelector('#bdd-preview').value = bddFor(data);
      }
    } catch { /* La vista previa acepta JSON mientras el usuario lo completa. */ }
  });
  result.querySelector('#edit-again').addEventListener('click', () => { previewData = null; result.innerHTML = '<div class="empty-state"><div class="empty-icon">↳</div><span class="empty-kicker">VOLVÉ A EDITAR LA ENTRADA</span></div>'; });
  result.querySelector('#confirm-generate').addEventListener('click', confirmAndGenerate);
  result.querySelector('#apply-ai-test-types')?.addEventListener('click', () => {
    document.querySelectorAll('input[name="test-type"]').forEach(control => { control.checked = previewData.aiSuggestions.recommendedTypes.includes(control.value); });
    previewData.testTypes = getTestTypes();
    renderPreview(previewData);
  });
}
function readPreviewEdits() {
  if (!previewData) return;
  const story = result.querySelector('#edit-story').value;
  const parsedRole = story.match(/Como\s+([^,]+)/i)?.[1];
  const parsedGoal = story.match(/quiero\s+(.+?),\s*para\s+/i)?.[1];
  const parsedOutcome = story.match(/para\s+(.+)\.?$/i)?.[1];
  if (parsedRole) previewData.role = parsedRole.trim();
  if (parsedGoal) previewData.goal = parsedGoal.trim();
  if (parsedOutcome) previewData.outcome = parsedOutcome.trim();
  try {
    const editedData = JSON.parse(result.querySelector('#edit-test-data').value);
    if (editedData && typeof editedData === 'object' && !Array.isArray(editedData)) previewData.testData = editedData;
    else throw new Error('El formato debe ser un objeto JSON.');
  } catch (error) {
    alert(`Datos de prueba: ${error.message}`);
    return false;
  }
  const negativeEditor = result.querySelector('#edit-negative-scenario');
  if (negativeEditor) {
    try {
      const negative = JSON.parse(negativeEditor.value);
      if (!negative || typeof negative !== 'object' || Array.isArray(negative) || !Array.isArray(negative.steps)) throw new Error('Se requiere un objeto con una lista steps.');
      previewData.negativeScenario = negative;
    } catch (error) { alert(`Caso negativo: ${error.message}`); return false; }
  }
  previewData.bdd = result.querySelector('#bdd-preview').value;
  result.querySelectorAll('[data-step]').forEach((row, index) => {
    const step = previewData.steps[index];
    if (!step) return;
    const originalSelector = step.selector;
    const originalSelectorType = step.selectorType;
    for (const field of ['name', 'action', 'selector', 'selectorType', 'value', 'expected']) {
      const control = row.querySelector(`[data-field="${field}"]`);
      if (control) step[field] = control.value;
    }
    step.description = step.name;
    step.pending = !['navegar', 'desplazar', 'validar_contenido'].includes(step.action) && !step.selector && !(step.action === 'validar' && step.expected);
    if (step.selector !== originalSelector || step.selectorType !== originalSelectorType) {
      step.candidates = step.selector ? { [step.selectorType || inferSelectorType(step.selector)]: step.selector } : {};
    }
    step.number = index + 1;
  });
  result.querySelectorAll('[data-setting]').forEach(control => {
    const number = Number(control.value);
    if (Number.isFinite(number) && number > 0) {
      const max = control.dataset.setting === 'iterations' ? 100 : control.dataset.setting === 'concurrentUsers' ? 25 : control.dataset.setting === 'timeoutSeconds' ? 300 : control.dataset.setting === 'stepDelayMs' ? 5000 : Infinity;
      previewData[control.dataset.setting] = Math.min(number, max);
      control.value = String(previewData[control.dataset.setting]);
    }
  });
  previewData.pending = [...(previewData.platformPending || []), ...previewData.steps.filter(step => step.pending).map(step => ({ description: step.description, recommendation: '⚠️ PENDIENTE DE VALIDACIÓN MANUAL: No se pudo detectar este elemento automáticamente. Completar selector y acción manualmente si es necesario.' }))];
  if (previewData.testTypes.includes('regresion') && !isNegativeScenarioReady(previewData.negativeScenario)) previewData.pending.push({ description: 'Escenario negativo de regresión', recommendation: 'Definir datos inválidos y el mensaje esperado en la sección editable; actualmente se omitirá.' });
  if (isNegativeScenarioReady(previewData.negativeScenario)) previewData.warnings = previewData.warnings.filter(item => !item.startsWith('El caso negativo solo se ejecutará'));
  return true;
}
function isNegativeScenarioReady(scenario) {
  if (!scenario || !Array.isArray(scenario.steps) || scenario.steps.length < 2 || !clean(scenario.expected)) return false;
  const supported = ['navegar', 'desplazar', 'validar_contenido', 'escribir', 'limpiar', 'clic', 'doble_clic', 'presionar_tecla', 'validar', 'validar_oculto', 'validar_conteo', 'validar_marcado', 'validar_desmarcado', 'esperar'];
  return scenario.steps.every(step => supported.includes(step.action) && (['navegar', 'desplazar', 'validar_contenido'].includes(step.action) || Boolean(step.selector)));
}
function integrationQueries(data) {
  if (!data.testTypes.includes('integracion')) return [];
  return [{ id_validacion: 'BD-001', momento_ejecucion: 'después_del_flujo', descripcion: 'Validar el registro de persistencia relacionado con el escenario.', consulta_sql_sugerida: 'SELECT <columna> FROM <tabla> WHERE <clave> = ?', parametros: ['${variable_de_prueba}'], observacion: '⚠️ Plantilla sugerida: completar esquema, tablas y columnas del entorno. FlowBDD no ejecuta SQL.' }];
}
function buildJson(data) {
  const now = data.generatedAt;
  return {
    especificacion_flowbdd: { version_formato: '2.3', fecha_generacion: now, fuente_informacion: data.source, url_procesada: data.url || '', modo_entrada_utilizado: modeInput.value, plataforma_objetivo: data.targetPlatform || 'web', advertencias: data.warnings },
    informacion_prueba: { nombre_prueba: data.title, descripcion_escenario: data.goal, tipo_prueba_solicitada: data.testTypes, prioridad: 'Media' },
    configuracion_ejecucion: { url_base: data.url ? new URL(data.url).origin : '', ruta_especifica: data.path, plataforma_objetivo: data.targetPlatform || 'web', entorno_nativo: data.targetPlatform !== 'web' ? data.platformConfig : undefined, framework_automatizacion: data.targetPlatform === 'web' ? 'Python + Playwright' : 'Python + Appium', tiempo_espera_predeterminado_segundos: data.timeoutSeconds, iteraciones: Math.max(1, Math.min(data.iterations, 100)), usuarios_simultaneos: Math.max(1, Math.min(data.concurrentUsers, 25)), alcance_integracion: data.testTypes.includes('integracion') ? 'interfaz; API/BD requieren configuración explícita' : undefined },
    datos_prueba: data.testData,
    pasos_de_prueba: data.steps.map((step, index) => ({ numero_paso: index + 1, nombre_accion: step.name, tipo_accion: step.action, destino_url: step.action === 'navegar' ? (step.value || data.url) : undefined, selector: step.selector || undefined, tipo_selector: step.selectorType || undefined, selectores_alternativos: step.candidates, valor_a_ingresar: step.value || undefined, descripcion_elemento: step.description, validacion_esperada: step.expected ? { tipo: 'texto_visible', texto_esperado: step.expected } : undefined, pendiente_validacion_manual: Boolean(step.pending && !step.selector) })),
    mapa_pagina: data.pageMap || [],
    recomendaciones_superagente: data.aiSuggestions ? { escenarios_adicionales: data.aiSuggestions.extraScenarios, tipos_prueba_recomendados: data.aiSuggestions.recommendedTypes, revision_selectores: data.aiSuggestions.selectorAdvice, preguntas_pendientes: data.aiSuggestions.questions, comentarios_codigo: data.aiCodeComments || [] } : undefined,
    reconocimiento_ocr: data.ocrElements?.length ? { motor: 'Tesseract', requiere_revision_manual: true, elementos: data.ocrElements } : undefined,
    escenario_negativo: data.testTypes.includes('regresion') ? data.negativeScenario : undefined,
    validaciones_base_datos: integrationQueries(data),
    elementos_pendientes: data.pending,
    escenarios_gherkin: data.bdd || bddFor(data),
  };
}
function download(filename, type, content) {
  const blob = new Blob([content], { type });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}
function sanitizePythonSource(source) {
  let result = '';
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = source.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        result += source[index] + source[index + 1];
        index += 1;
      } else result += '\ufffd';
    } else if (code >= 0xdc00 && code <= 0xdfff) result += '\ufffd';
    else result += source[index];
  }
  return result;
}
async function confirmAndGenerate() {
  if (readPreviewEdits() === false) return;
  const button = result.querySelector('#confirm-generate');
  if (button) { button.disabled = true; button.textContent = 'Validando artefactos…'; }
  try {
    outputArtifacts = { json: buildJson(previewData) };
    if (document.querySelector('#want-python').checked) outputArtifacts.python = sanitizePythonSource(buildPython(previewData));
    if (document.querySelector('#want-java-selenium').checked) outputArtifacts.javaSelenium = buildJava(previewData, 'selenium');
    if (document.querySelector('#want-java-testng').checked) outputArtifacts.javaTestng = buildJava(previewData, 'testng');
    JSON.parse(JSON.stringify(outputArtifacts.json));
    if (outputArtifacts.python) {
      let validationUnavailable = '';
      try {
        const response = await fetch('/api/validate-python', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: outputArtifacts.python }) });
        if (response.status === 404) {
          validationUnavailable = 'El servidor activo todavía no ofrece la validación de sintaxis Python. Se generaron los archivos, pero revisa el script con Python antes de ejecutarlo.';
        } else {
          let validation;
          try { validation = await response.json(); }
          catch { throw new Error('El servidor devolvió una respuesta inválida al validar Python.'); }
          if (!response.ok || !validation.valid) {
            const validationError = String(validation.error || 'El script Python no pasó la validación de sintaxis.');
            if (/UnicodeEncodeError[\s\S]*surrogates not allowed/i.test(validationError)) {
              validationUnavailable = 'El validador Python del servidor está desactualizado y no admite caracteres Unicode aislados. El script se saneó y se generaron los archivos; reinicia FlowBDD para activar la validación corregida.';
            } else throw new Error(validationError);
          }
        }
      } catch (error) {
        if (error instanceof TypeError && /fetch|network|failed/i.test(error.message)) {
          validationUnavailable = 'No se pudo contactar al validador Python. Se generaron los archivos, pero revisa el script con Python antes de ejecutarlo.';
        } else {
          throw error;
        }
      }
      if (validationUnavailable && !previewData.warnings.includes(validationUnavailable)) previewData.warnings.push(validationUnavailable);
    }
    renderGeneratedOutputs('json');
    speak('¡Terminé! Tus archivos están listos para descargar. Buen trabajo.');
  } catch (error) {
    const errorBox = result.querySelector('#artifact-error');
    if (errorBox) {
      const shortMessage = String(error.message || error).split(/\r?\n/).filter(Boolean).at(-1) || 'Error desconocido.';
      errorBox.textContent = `No se pudieron generar los archivos: ${shortMessage}`;
      errorBox.hidden = false;
    }
    speak(`Encontré un inconveniente: ${error.message}. Revisá y volvé a intentar.`);
    if (button) { button.disabled = false; button.textContent = '✅ Confirmar y Generar'; }
  }
}
function renderGeneratedOutputs(active = 'json') {
  const wantsJson = document.querySelector('#want-json').checked;
  const wantsPython = document.querySelector('#want-python').checked;
  const wantsJavaSelenium = document.querySelector('#want-java-selenium').checked;
  const wantsJavaTestng = document.querySelector('#want-java-testng').checked;
  const pythonLabel = previewData?.targetPlatform === 'web' ? 'Python + Playwright' : 'Python + Appium';
  const available = [wantsJson && 'json', wantsPython && 'python', wantsJavaSelenium && 'javaSelenium', wantsJavaTestng && 'javaTestng'].filter(Boolean);
  const visibleTab = available.includes(active) ? active : available[0];
  const labels = { json: 'JSON profesional para QA Studio', python: pythonLabel, javaSelenium: 'Java + Selenium', javaTestng: 'Java + TestNG (suite Selenium)' };
  const tabs = available.map(name => `<button class="result-tab ${visibleTab === name ? 'active' : ''}" data-output="${name}">${labels[name]}</button>`).join('');
  const content = visibleTab === 'json' ? JSON.stringify(outputArtifacts.json, null, 2) : outputArtifacts[visibleTab] || '';
  const validationWarning = previewData?.warnings?.find(item => item.startsWith('El servidor activo todavía no ofrece la validación de sintaxis Python.') || item.startsWith('No se pudo contactar al validador Python.') || item.startsWith('El validador Python del servidor está desactualizado'));
  const validationNotice = validationWarning ? `<section class="preview-section" role="alert"><h3>Aviso de validación Python</h3><p>${escapeHtml(validationWarning)}</p></section>` : '';
  const executionSummary = previewData?.targetPlatform === 'web' ? 'FlowBDD preparó las salidas seleccionadas. Puedes revisar la ejecución en Chrome visible.' : 'FlowBDD preparó las salidas nativas. Ejecuta el script Python con Appium, el driver y la aplicación/dispositivo configurados.';
  result.innerHTML = `<div class="preview-header"><h2>03 · Archivos listos</h2><span>REVISÁ ANTES DE DESCARGAR</span></div><p class="preview-summary">${executionSummary}</p>${validationNotice}<div class="result-tabs">${tabs}</div><pre class="code-box">${escapeHtml(content)}</pre><section class="preview-section" id="visible-run-panel"><h3>Ejecución visual de QA</h3><p class="hint">Una sola ventana Chrome recorre las páginas, el desplazamiento y controles seguros. Las acciones de compra, publicación, borrado o cuenta requieren confirmación manual.</p><div class="run-settings"><label>Pausa entre acciones<select id="run-delay"><option value="850">850 ms · detallada</option><option value="1400">1,4 s · lenta</option><option value="1800" selected>1,8 s · muy lenta</option><option value="3000">3 s · pausada</option><option value="5000">5 s · muy pausada</option></select></label><label>Páginas a recorrer<select id="run-max-pages"><option value="6">6 páginas</option><option value="12">12 páginas</option><option value="18">18 páginas</option><option value="24" selected>24 páginas</option></select></label><label>Mantener Chrome abierto<select id="run-display-seconds"><option value="30">30 segundos</option><option value="60" selected>1 minuto</option><option value="120">2 minutos</option></select></label></div><div class="run-dashboard" id="run-dashboard"><div class="run-progress-heading"><strong id="run-stage">Esperando ejecución</strong><b id="run-percent">0%</b></div><progress id="run-progress" max="100" value="0"></progress><p id="run-current">Chrome recorrerá cada página antes de ejecutar los casos.</p><div class="run-stats"><span><b id="run-pages">0</b> páginas</span><span><b id="run-controls">0</b> controles</span><span><b id="run-passed">0</b> pasaron</span><span><b id="run-failed">0</b> fallaron</span><span><b id="run-skipped">0</b> omitidos</span><span><b id="run-elapsed">00:00</b> transcurrido</span></div><div id="run-cases" class="run-cases" aria-live="polite"></div></div><div class="preview-footer"><button class="generate" id="run-visible">▶ Iniciar recorrido y suite</button><button class="secondary-button" id="run-continue" hidden>Ya inicié sesión · Continuar</button><button class="secondary-button" id="run-skip" hidden>Omitir este caso</button><button class="secondary-button" id="run-stop" hidden>Detener suite</button><a class="secondary-button" id="run-report" target="_blank" rel="noopener" hidden>Ver reporte HTML</a></div><pre id="run-log" class="code-box" aria-live="polite">Esperando que inicies la ejecución…</pre></section><div class="preview-footer">${wantsJson ? '<button class="generate" id="download-json">Descargar JSON profesional</button>' : ''}${wantsPython ? `<button class="generate" id="download-python">Descargar ${escapeHtml(pythonLabel)}</button>` : ''}${wantsJavaSelenium ? '<button class="generate" id="download-java-selenium">Descargar Java + Selenium</button>' : ''}${wantsJavaTestng ? '<button class="generate" id="download-java-testng">Descargar Java + TestNG (suite)</button>' : ''}<button class="secondary-button" id="back-preview">Volver a la vista previa</button></div>`;
  result.querySelectorAll('[data-output]').forEach(button => button.addEventListener('click', () => renderGeneratedOutputs(button.dataset.output)));
  if (previewData?.targetPlatform !== 'web') result.querySelector('#visible-run-panel').hidden = true;
  result.querySelector('#download-json')?.addEventListener('click', () => download('flowbdd_qa_studio.json', 'application/json;charset=utf-8', JSON.stringify(outputArtifacts.json, null, 2)));
  result.querySelector('#download-python')?.addEventListener('click', () => download(`test_flowbdd_${previewData?.targetPlatform || 'web'}.py`, 'text/x-python;charset=utf-8', outputArtifacts.python));
  result.querySelector('#download-java-selenium')?.addEventListener('click', () => download('FlowBddGenerated.java', 'text/x-java;charset=utf-8', outputArtifacts.javaSelenium));
  result.querySelector('#download-java-testng')?.addEventListener('click', () => download('FlowBddGeneratedTest.java', 'text/x-java;charset=utf-8', outputArtifacts.javaTestng));
  result.querySelector('#run-visible').addEventListener('click', runVisibleSuite);
  result.querySelector('#run-stop').addEventListener('click', () => sendRunControl('stop'));
  result.querySelector('#run-continue').addEventListener('click', () => sendRunControl('continue'));
  result.querySelector('#run-skip').addEventListener('click', () => sendRunControl('skip'));
  result.querySelector('#back-preview').addEventListener('click', () => renderPreview(previewData));
}
async function runVisibleSuite() {
  const log = result.querySelector('#run-log');
  const start = result.querySelector('#run-visible');
  start.disabled = true;
  log.textContent = 'Preparando Playwright y abriendo Chrome…\n';
  result.querySelector('#run-progress').value = 0;
  result.querySelector('#run-percent').textContent = '0%';
  result.querySelector('#run-stage').textContent = 'Preparando suite';
  result.querySelector('#run-current').textContent = 'Abriendo Chrome y preparando el recorrido.';
  result.querySelector('#run-cases').innerHTML = '';
  for (const id of ['run-pages', 'run-controls', 'run-passed', 'run-failed', 'run-skipped']) result.querySelector(`#${id}`).textContent = '0';
  result.querySelector('#run-report').hidden = true;
  runStartedAt = Date.now();
  clearInterval(runTimerId);
  runTimerId = setInterval(() => {
    const elapsed = Math.floor((Date.now() - runStartedAt) / 1000);
    result.querySelector('#run-elapsed').textContent = `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`;
  }, 1000);
  if (runEventSource) runEventSource.close();
  const data = {
    title: previewData.title,
    url: previewData.url || previewData.steps.find(step => step.action === 'navegar')?.value || '',
    timeoutSeconds: previewData.timeoutSeconds,
    iterations: previewData.iterations,
    testTypes: previewData.testTypes,
    testData: previewData.testData,
    negativeScenario: previewData.negativeScenario,
    stepDelayMs: Number(result.querySelector('#run-delay').value),
    maxExplorePages: Number(result.querySelector('#run-max-pages').value),
    displaySeconds: Number(result.querySelector('#run-display-seconds').value),
    steps: previewData.steps.map(step => ({ name: step.name, description: step.description, action: step.action, selector: step.selector, selectorType: step.selectorType, candidates: step.candidates || {}, value: step.value, expected: step.expected })),
  };
  try {
    const response = await fetch('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data }) });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    activeRunId = body.runId;
    result.querySelector('#run-stop').hidden = false;
    runEventSource = new EventSource(body.eventsUrl);
    runEventSource.onmessage = ({ data: raw }) => {
      const event = JSON.parse(raw);
      if (event.type === 'progress') {
        result.querySelector('#run-progress').value = event.percent || 0;
        result.querySelector('#run-percent').textContent = `${event.percent || 0}%`;
        result.querySelector('#run-stage').textContent = event.stage || 'En ejecución';
        result.querySelector('#run-current').textContent = event.text || '';
        if (event.pages != null) result.querySelector('#run-pages').textContent = event.pages;
        if (event.controls != null) result.querySelector('#run-controls').textContent = event.controls;
      } else if (event.type === 'step') {
        result.querySelector('#run-current').textContent = event.text || 'Ejecutando paso';
        log.textContent += `${event.text}\n`;
      } else if (event.text) log.textContent += `${event.text}\n`;
      log.scrollTop = log.scrollHeight;
      if (event.type === 'auth_required') {
        result.querySelector('#run-continue').hidden = false;
        result.querySelector('#run-skip').hidden = false;
      }
      if (event.type === 'case' && event.status) {
        log.textContent += `Resultado ${event.case}: ${event.status}\n`;
        const item = document.createElement('div');
        item.className = `run-case ${String(event.status).toLowerCase()}`;
        item.innerHTML = `<span>${escapeHtml(event.case || 'Caso')}</span><b>${escapeHtml(event.status)}</b>`;
        result.querySelector('#run-cases').append(item);
        const statuses = [...result.querySelectorAll('.run-case b')].map(node => node.textContent);
        result.querySelector('#run-passed').textContent = statuses.filter(status => status === 'PASS').length;
        result.querySelector('#run-failed').textContent = statuses.filter(status => status === 'FAIL').length;
        result.querySelector('#run-skipped').textContent = statuses.filter(status => ['SKIP', 'PARTIAL', 'BLOCKED'].includes(status)).length;
      }
      if (event.type === 'done') {
        runEventSource.close();
        clearInterval(runTimerId);
        result.querySelector('#run-progress').value = 100;
        result.querySelector('#run-percent').textContent = '100%';
        result.querySelector('#run-stage').textContent = 'Suite finalizada';
        result.querySelector('#run-current').textContent = `Recorrido: ${event.pages || 0} páginas y ${event.controls || 0} controles. Chrome se cerró al completar la pausa configurada.`;
        result.querySelector('#run-stop').hidden = true;
        result.querySelector('#run-continue').hidden = true;
        result.querySelector('#run-skip').hidden = true;
        if (event.report_path) {
          const report = result.querySelector('#run-report');
          report.href = `/api/run/${activeRunId}/report`;
          report.hidden = false;
        }
        start.disabled = false;
      }
    };
    runEventSource.onerror = () => {
      if (runEventSource.readyState === EventSource.CLOSED) {
        clearInterval(runTimerId);
        log.textContent += 'Se perdió la conexión con el registro de ejecución.\n';
        result.querySelector('#run-stage').textContent = 'Conexión interrumpida';
        result.querySelector('#run-stop').hidden = true;
        start.disabled = false;
      }
    };
  } catch (error) {
    clearInterval(runTimerId);
    log.textContent += `No se pudo iniciar la suite: ${error.message}\n`;
    start.disabled = false;
  }
}
async function sendRunControl(action) {
  if (!activeRunId) return;
  try {
    const response = await fetch(`/api/run/${activeRunId}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'No se pudo enviar el control.');
    if (action !== 'stop') {
      result.querySelector('#run-continue').hidden = true;
      result.querySelector('#run-skip').hidden = true;
    }
  } catch (error) {
    result.querySelector('#run-log').textContent += `${error.message}\n`;
  }
}
function inferSelectorType(value) {
  if (value.startsWith('/') || value.startsWith('xpath=')) return 'XPath';
  if (value.startsWith('#')) return 'ID';
  return 'CSS';
}
function handleApiError(error) {
  return error?.message || 'No se pudo analizar la página.';
}
async function analyzeUrl(credentials = null) {
  const url = getUrl(input.value);
  if (!url) { urlInput.focus(); alert('Ingresá una URL http(s).'); return; }
  try {
    analyzeButton.disabled = true;
    analyzeButton.textContent = 'Analizando…';
    speak('Dame un momento, estoy analizando tu requerimiento…');
    const useOcr = document.querySelector('#use-ocr').checked;
    const response = await fetch('/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, credentials, useOcr }) });
    const data = await response.json();
    if (data.error) { alert(data.error); return; }
    pageAnalysis = data;
    if (data.auth_required) {
      if (!credentials) authDialog.showModal();
      else alert('La página sigue mostrando el formulario de acceso. Revisá las credenciales o completá la autenticación manualmente; no se generó ningún archivo.');
      return;
    }
    const ocrStatus = document.querySelector('#ocr-status');
    if (useOcr) {
      const found = data.ocr_elements?.length || 0;
      ocrStatus.textContent = data.ocr_available
        ? `Tesseract encontró ${found} fragmentos de texto en la captura. Validá cada elemento manualmente.`
        : (data.ocr_warning || 'OCR no disponible. La inspección DOM sigue funcionando.');
      ocrStatus.classList.toggle('ocr-ready', Boolean(data.ocr_available));
    }
    if (!data.elements?.length) {
      alert(data.warning || 'La página no expuso controles detectables. Se puede continuar, pero la vista previa marcará esos pasos para validación manual.');
    } else {
      alert(`Análisis terminado: ${data.elements.length} elementos visibles detectados en ${data.url}.`);
    }
    if (data.ocr_available) speak(`¡Listo! Detecté ${data.elements?.length || 0} controles y ${data.ocr_elements?.length || 0} fragmentos de texto OCR. Revisá cuando quieras.`);
  } catch (error) {
    alert(handleApiError(error));
  } finally {
    analyzeButton.disabled = false;
    analyzeButton.textContent = 'Analizar página con Playwright';
  }
}
analyzeButton.addEventListener('click', () => analyzeUrl());
previewButton.addEventListener('click', preparePreview);
updateMode();
updatePlatform();
updateCount();
const savedTheme = localStorage.getItem('flowbdd-theme');
if (savedTheme === 'dark') {
  document.body.classList.add('dark-theme');
  themeToggle.setAttribute('aria-pressed', 'true');
  themeToggle.textContent = '☀ Tema claro';
}
updateSuperAgent();
