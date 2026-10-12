import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const publicDir = join(root, 'public');
const port = Number(process.env.PORT || 4173);
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const visibleRuns = new Map();

function emitRunEvent(run, event) {
  run.events.push(event);
  const frame = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of run.clients) if (!client.destroyed) {
    client.write(frame);
    if (event.type === 'done') {
      client.end();
      run.clients.delete(client);
    }
  }
}

function localOriginAllowed(req) {
  try {
    const origin = new URL(req.headers.origin);
    return ['127.0.0.1', 'localhost'].includes(origin.hostname) && Number(origin.port) === port;
  } catch { return false; }
}

async function readJsonBody(req, limit) {
  let body = '';
  req.setEncoding('utf8');
  for await (const chunk of req) {
    body += chunk;
    if (body.length > limit) throw new Error('BODY_TOO_LARGE');
  }
  return JSON.parse(body || '{}');
}

function inspectUrl(payload) {
  const fallback = () => analyzeStaticHtml(payload.url, payload.credentials).catch((error) => ({
    url: payload.url,
    status: 0,
    title: '',
    auth_required: false,
    elements: [],
    manual_review: true,
    analysis_method: 'unavailable',
    warning: describeFetchFailure(payload.url, error),
  }));
  return new Promise((resolve) => {
    const python = spawn(process.env.FLOWBDD_PYTHON || 'python', [join(root, 'analyze_page.py')], {
      cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => python.kill(), 35000);
    python.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    python.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    python.on('error', (error) => {
      clearTimeout(timer);
      resolve({ error: `No se encontró Python (${error.message}). Define FLOWBDD_PYTHON con la ruta a python.exe.` });
    });
    python.on('close', (code) => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
        if (parsed.error && /spawn EPERM|browserType\.launch|Executable doesn't exist/i.test(parsed.error)) {
          fallback().then(resolve);
        } else {
          resolve(parsed);
        }
      } catch {
        fallback().then((result) => {
          if (result.analysis_method === 'unavailable') result.warning += ` El analizador Playwright terminó con código ${code}.`;
          resolve(result);
        });
      }
    });
    python.stdin.end(JSON.stringify(payload));
  });
}

function replaceLoneSurrogates(value) {
  let result = '';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        result += value[index] + value[index + 1];
        index += 1;
      } else result += '\ufffd';
    } else if (code >= 0xdc00 && code <= 0xdfff) result += '\ufffd';
    else result += value[index];
  }
  return result;
}

function validatePythonSyntax(source) {
  // A malformed UTF-16 surrogate in pasted requirements must never reach
  // Python's UTF-8 stdin decoder or ast.parse as an unencodable code point.
  const safeSource = replaceLoneSurrogates(source);
  return new Promise((resolve) => {
    const validator = `import ast,sys
source=sys.stdin.buffer.read().decode("utf-8", errors="replace")
try:
    ast.parse(source, filename="test_flowbdd.py")
except SyntaxError as error:
    print(f"SyntaxError en línea {error.lineno}, columna {error.offset}: {error.msg}", file=sys.stderr)
    sys.exit(1)
except Exception as error:
    print(f"{type(error).__name__}: {error}", file=sys.stderr)
    sys.exit(1)
print("OK")`;
    const python = spawn(process.env.FLOWBDD_PYTHON || 'python', ['-c', validator], {
      cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    });
    let stdout = '';
    let stderr = '';
    python.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    python.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    python.on('error', error => resolve({ valid: false, error: `No se encontró Python para validar sintaxis: ${error.message}` }));
    python.on('close', code => resolve(code === 0
      ? { valid: true }
      : { valid: false, error: (stderr || stdout || `Python terminó con código ${code}`).trim() }));
    python.stdin.end(safeSource, 'utf8');
  });
}

function describeFetchFailure(rawUrl, error) {
  const code = error?.cause?.code || error?.code || '';
  const reason = code ? ` (${code})` : '';
  return `No se pudo conectar con ${rawUrl}${reason}. Verifica que la URL exista y que la red, VPN o firewall permitan el acceso. FlowBDD sigue sin análisis automático; puedes continuar con selectores manuales y validarlos en la vista previa.`;
}

function decodeHtml(value) {
  return value.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, number) => String.fromCodePoint(Number(number)));
}

function htmlAttributes(source) {
  const attrs = {};
  for (const match of source.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    attrs[match[1].toLowerCase()] = decodeHtml(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attrs;
}

async function analyzeStaticHtml(rawUrl, credentials = null) {
  const headers = { 'User-Agent': 'FlowBDD-local-page-analyzer/2.1' };
  if (credentials?.username && credentials?.password) {
    headers.Authorization = `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`;
  }
  let response;
  try {
    response = await fetch(rawUrl, { signal: AbortSignal.timeout(12000), redirect: 'follow', headers });
  } catch (error) {
    error.message = describeFetchFailure(rawUrl, error);
    throw error;
  }
  const html = (await response.text()).slice(0, 2_000_000);
  const elements = [];
  const tags = /<(a|button|input|textarea|select|label)\b([^>]*?)(?:\/?>)(?:([\s\S]*?)<\/\1\s*>)?/gi;
  for (const match of html.matchAll(tags)) {
    if (elements.length >= 300) break;
    const tag = match[1].toLowerCase();
    const attrs = htmlAttributes(match[2]);
    const text = decodeHtml((match[3] || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, 160);
    const label = text || attrs['aria-label'] || attrs.placeholder || attrs.value || '';
    let xpath = '';
    let css = tag;
    if (attrs.id) { xpath = `//${tag}[@id='${attrs.id.replaceAll("'", "&apos;")}']`; css = `${tag}#${attrs.id.replace(/([^a-zA-Z0-9_-])/g, '\\$1')}`; }
    else if (attrs.name) { xpath = `//${tag}[@name='${attrs.name.replaceAll("'", "&apos;")}']`; css = `${tag}[name="${attrs.name}"]`; }
    else if (label && ['a', 'button', 'label'].includes(tag)) xpath = `//${tag}[normalize-space(.)='${label.replaceAll("'", "&apos;")}']`;
    if (!label && !attrs.id && !attrs.name && !attrs.type) continue;
    elements.push({ tag, text: label, id: attrs.id || '', name: attrs.name || '', type: attrs.type || '', aria: attrs['aria-label'] || '', placeholder: attrs.placeholder || '', href: attrs.href || '', disabled: Object.hasOwn(attrs, 'disabled'), visible: true, xpath, css });
  }
  const loginForm = [...html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form\s*>/gi)].some(([, attrs, body]) =>
    /<input\b[^>]*type\s*=\s*["']password["']/i.test(body) && !/method\s*=\s*["']dialog["']|id\s*=\s*["']auth-form["']/i.test(attrs));
  return { url: response.url, status: response.status, title: decodeHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || ''), auth_required: [401, 403].includes(response.status) || loginForm, elements, manual_review: true, analysis_method: 'html_fallback', warning: 'Se analizó HTML estático como respaldo. No se ejecutó JavaScript; validar los selectores dinámicos manualmente.' };
}

async function interpretWithLlm(payload) {
  const endpoint = process.env.FLOWBDD_LLM_ENDPOINT;
  const apiKey = process.env.FLOWBDD_LLM_API_KEY;
  const model = process.env.FLOWBDD_LLM_MODEL;
  if (!endpoint || !apiKey || !model) {
    return { status: 503, body: { error: 'IA no configurada. Define FLOWBDD_LLM_ENDPOINT, FLOWBDD_LLM_API_KEY y FLOWBDD_LLM_MODEL; o desactiva la opción de IA para usar el generador local.' } };
  }
  let endpointUrl;
  try { endpointUrl = new URL(endpoint); } catch { return { status: 500, body: { error: 'FLOWBDD_LLM_ENDPOINT no es una URL válida.' } }; }
  if (!['https:', 'http:'].includes(endpointUrl.protocol) || endpointUrl.username || endpointUrl.password) {
    return { status: 500, body: { error: 'El endpoint LLM debe ser una URL http(s) sin credenciales incrustadas.' } };
  }
  const system = 'Eres un analista QA. Devuelve solo un objeto JSON con claves title, role, goal, outcome, rules y steps. steps es una lista de objetos con name, action (navegar, escribir, clic, validar, esperar o manual), value y expected. No inventes selectores; deja value/expected vacíos si no están especificados. Conserva nombres y datos textuales. No escribas código ni ejecutes pruebas.';
  try {
    const response = await fetch(endpointUrl, {
      method: 'POST', signal: AbortSignal.timeout(30000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, temperature: 0, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify({ modo: payload.mode, url: payload.url || '', requerimiento: payload.text }) }] }),
    });
    if (!response.ok) return { status: 502, body: { error: `El proveedor LLM respondió HTTP ${response.status}.` } };
    const result = await response.json();
    const content = result.choices?.[0]?.message?.content;
    if (typeof content !== 'string') return { status: 502, body: { error: 'El proveedor LLM no devolvió el formato esperado.' } };
    const parsed = JSON.parse(content.replace(/^```(?:json)?\s*|\s*```$/g, ''));
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.steps)) return { status: 502, body: { error: 'La respuesta LLM no contiene una lista de pasos válida.' } };
    return { status: 200, body: { interpretation: parsed, model } };
  } catch (error) {
    return { status: 502, body: { error: `Falló la solicitud al LLM: ${error.name === 'TimeoutError' ? 'tiempo de espera agotado' : error.message}` } };
  }
}

http.createServer(async (req, res) => {
  let path;
  try {
    path = decodeURIComponent(new URL(req.url, `http://${req.headers.host}`).pathname);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Solicitud inválida');
    return;
  }
  const runEventsMatch = path.match(/^\/api\/run\/([a-f0-9]{32})\/events$/);
  const runReportMatch = path.match(/^\/api\/run\/([a-f0-9]{32})\/report$/);
  const runControlMatch = path.match(/^\/api\/run\/([a-f0-9]{32})\/(continue|skip|stop)$/);
  if (req.method === 'POST' && path === '/api/run') {
    if (!localOriginAllowed(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'La ejecución solo se acepta desde FlowBDD en este equipo.' }));
      return;
    }
    try {
      const payload = await readJsonBody(req, 250000);
      const data = payload.data;
      const validTypes = new Set(['humo', 'funcional', 'regresion', 'integracion', 'carga']);
      const validActions = new Set(['navegar', 'goto', 'desplazar', 'scroll', 'escribir', 'fill', 'completar', 'limpiar', 'clic', 'click', 'presionar', 'presionar_tecla', 'doble_clic', 'validar', 'verificar', 'assert', 'texto_visible', 'validar_contenido', 'validar_oculto', 'validar_conteo', 'validar_marcado', 'validar_desmarcado', 'esperar', 'wait', 'manual']);
      if (!data || !Array.isArray(data.steps) || !data.steps.length || data.steps.length > 200) throw new Error('El flujo debe tener entre 1 y 200 pasos.');
      if (!Array.isArray(data.testTypes) || !data.testTypes.length || data.testTypes.some((type) => !validTypes.has(type))) throw new Error('Selecciona al menos un tipo de prueba válido.');
      for (const step of data.steps) {
        if (!step || !validActions.has(String(step.action || '').toLowerCase())) throw new Error('El flujo contiene una acción no válida.');
        for (const value of [step.selector, step.value, step.expected]) if (value != null && (typeof value !== 'string' || value.length > 5000)) throw new Error('Un selector o dato de paso supera el límite de 5000 caracteres.');
      }
      if (data.stepDelayMs != null && (!Number.isInteger(data.stepDelayMs) || data.stepDelayMs < 200 || data.stepDelayMs > 5000)) throw new Error('La pausa entre pasos debe estar entre 200 y 5000 ms.');
      if (data.maxExplorePages != null && (!Number.isInteger(data.maxExplorePages) || data.maxExplorePages < 1 || data.maxExplorePages > 24)) throw new Error('El recorrido puede incluir entre 1 y 24 páginas.');
      if (data.displaySeconds != null && (!Number.isInteger(data.displaySeconds) || data.displaySeconds < 5 || data.displaySeconds > 120)) throw new Error('La pausa final debe estar entre 5 y 120 segundos.');
      const startUrl = data.url || data.steps.find((step) => ['navegar', 'goto'].includes(String(step.action).toLowerCase()))?.value;
      if (!startUrl || !['http:', 'https:'].includes(new URL(startUrl).protocol)) throw new Error('Falta una URL http(s) válida en el flujo.');
      const active = [...visibleRuns.values()].find((run) => !run.finished);
      if (active) throw new Error('Ya hay una suite ejecutándose. Espera a que termine o detenla.');
      const id = randomUUID().replaceAll('-', '');
      const run = { id, events: [], clients: new Set(), finished: false, child: null };
      visibleRuns.set(id, run);
      const python = spawn(process.env.FLOWBDD_PYTHON || 'python', [join(root, 'visible_runner.py')], {
        cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      });
      run.child = python;
      python.stdin.on('error', () => {});
      let stdoutBuffer = '';
      python.stdout.setEncoding('utf8').on('data', (chunk) => {
        stdoutBuffer += chunk;
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() || '';
        for (const line of lines) {
          try { emitRunEvent(run, JSON.parse(line)); }
          catch { emitRunEvent(run, { type: 'log', text: line }); }
        }
      });
      python.stderr.setEncoding('utf8').on('data', (chunk) => emitRunEvent(run, { type: 'log', text: chunk.trim() }));
      python.on('error', (error) => {
        emitRunEvent(run, { type: 'fatal', text: `No se pudo iniciar Python: ${error.message}. Define FLOWBDD_PYTHON con la ruta de python.exe.` });
        run.finished = true;
        emitRunEvent(run, { type: 'done', results: [] });
      });
      python.on('close', (code) => {
        if (stdoutBuffer.trim()) {
          try { emitRunEvent(run, JSON.parse(stdoutBuffer)); }
          catch { emitRunEvent(run, { type: 'log', text: stdoutBuffer.trim() }); }
        }
        run.finished = true;
        if (!run.events.some((event) => event.type === 'done')) emitRunEvent(run, { type: 'done', exitCode: code, results: [] });
      });
      python.stdin.write(`${JSON.stringify({ ...data, runId: id })}\n`);
      setTimeout(() => { if (run.finished) visibleRuns.delete(id); }, 30 * 60 * 1000).unref();
      res.writeHead(202, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ runId: id, eventsUrl: `/api/run/${id}/events` }));
    } catch (error) {
      const status = error.message === 'BODY_TOO_LARGE' ? 413 : 400;
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: error.message === 'BODY_TOO_LARGE' ? 'El flujo supera el tamaño máximo.' : error.message || 'Solicitud de ejecución no válida.' }));
    }
    return;
  }
  if (req.method === 'GET' && runEventsMatch) {
    const run = visibleRuns.get(runEventsMatch[1]);
    if (!run) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Ejecución no encontrada o vencida.');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('retry: 1500\n\n');
    for (const event of run.events) res.write(`data: ${JSON.stringify(event)}\n\n`);
    if (!run.finished) {
      run.clients.add(res);
      res.on('close', () => run.clients.delete(res));
    } else res.end();
    return;
  }
  if (req.method === 'GET' && runReportMatch) {
    const run = visibleRuns.get(runReportMatch[1]);
    if (!run) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('El reporte todavía no está disponible.');
      return;
    }
    try {
      const report = await readFile(join(root, 'reportes', 'ejecuciones_visibles', run.id, 'reporte.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(report);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('No se encontró el reporte de esta ejecución.');
    }
    return;
  }
  if (req.method === 'POST' && runControlMatch) {
    req.resume();
    if (!localOriginAllowed(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Origen local no válido.' }));
      return;
    }
    const run = visibleRuns.get(runControlMatch[1]);
    if (!run || run.finished) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'La ejecución ya terminó.' }));
      return;
    }
    const command = runControlMatch[2];
    if (command === 'stop') run.child?.kill();
    else run.child?.stdin.write(`${command}\n`);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.method === 'POST' && path === '/api/analyze') {
    let body = '';
    req.setEncoding('utf8');
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 16000) {
        res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'La solicitud supera el tamaño permitido.' }));
        return;
      }
    }
    try {
      const payload = JSON.parse(body || '{}');
      const url = new URL(payload.url);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
      const result = await inspectUrl(payload);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(result));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'URL o cuerpo no válido. Usa una URL http(s) sin credenciales incrustadas.' }));
    }
    return;
  }
  if (req.method === 'POST' && path === '/api/validate-python') {
    try {
      const payload = await readJsonBody(req, 200000);
      if (typeof payload.source !== 'string' || payload.source.length > 180000) throw new Error('Código Python no válido.');
      const result = await validatePythonSyntax(payload.source);
      res.writeHead(result.valid ? 200 : 422, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(result));
    } catch (error) {
      const status = error.message === 'BODY_TOO_LARGE' ? 413 : 400;
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ valid: false, error: error.message || 'No se pudo validar el script.' }));
    }
    return;
  }
  if (req.method === 'POST' && path === '/api/interpret') {
    let body = '';
    req.setEncoding('utf8');
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 30000) {
        res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'El requerimiento supera el tamaño permitido.' }));
        return;
      }
    }
    try {
      const payload = JSON.parse(body || '{}');
      if (typeof payload.text !== 'string' || payload.text.length < 20) throw new Error();
      const result = await interpretWithLlm(payload);
      res.writeHead(result.status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(result.body));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Solicitud de interpretación no válida.' }));
    }
    return;
  }
  const file = path === '/' ? 'index.html' : normalize(path.replace(/^\/+/, ''));
  if (file.startsWith('..') || file.includes(':')) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Ruta no permitida');
    return;
  }
  try {
    const body = await readFile(join(publicDir, file));
    res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('No encontrado');
  }
}).listen(port, '127.0.0.1', () => console.log(`FlowBDD listo en http://127.0.0.1:${port}`));
