// Serialize dynamic values as ASCII-only Python literals. JSON.stringify leaves
// Unicode (including lone UTF-16 surrogates) in the generated source; Python's
// AST validator then fails while encoding that source as UTF-8.
function pyString(value) {
  let literal = '"';
  for (const character of String(value ?? '')) {
    const codePoint = character.codePointAt(0);
    if (character === '"') literal += '\\"';
    else if (character === '\\') literal += '\\\\';
    else if (character === '\n') literal += '\\n';
    else if (character === '\r') literal += '\\r';
    else if (character === '\t') literal += '\\t';
    else if (codePoint < 0x20 || codePoint === 0x7f) literal += `\\x${codePoint.toString(16).padStart(2, '0')}`;
    else if (codePoint <= 0x7e) literal += character;
    else if (codePoint >= 0xd800 && codePoint <= 0xdfff) literal += '\\ufffd';
    else if (codePoint <= 0xffff) literal += `\\u${codePoint.toString(16).padStart(4, '0')}`;
    else literal += `\\U${codePoint.toString(16).padStart(8, '0')}`;
  }
  return `${literal}"`;
}

function py(value) {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'string') return pyString(value);
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'None';
  if (Array.isArray(value)) return `[${value.map(py).join(', ')}]`;
  if (typeof value === 'object') {
    return `{${Object.entries(value).map(([key, item]) => `${pyString(key)}: ${py(item)}`).join(', ')}}`;
  }
  return pyString(String(value));
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

export function buildPython(data) {
  if (data.targetPlatform && data.targetPlatform !== 'web') return buildAppiumPython(data);
  const steps = data.steps || [];
  const tests = data.testTypes || ['funcional'];
  const specs = steps.map((step, i) => `    {"number": ${i + 1}, "name": ${py(step.name)}, "action": ${py(step.action)}, "selector": ${py(step.selector)}, "selector_type": ${py(step.selectorType)}, "selectors": ${py(step.candidates || {})}, "value": ${py(step.value)}, "expected": ${py(step.expected)}, "description": ${py(step.description)}}`).join(',\n');
  const negative = data.negativeScenario || {};
  const negativeSteps = Array.isArray(negative.steps) ? negative.steps : [];
  const negativeSpecs = negativeSteps.map((step, i) => `    {"number": ${i + 1}, "name": ${py(step.name || step.description)}, "action": ${py(step.action)}, "selector": ${py(step.selector)}, "selector_type": ${py(step.selectorType)}, "selectors": ${py(step.candidates || {})}, "value": ${py(step.value)}, "expected": ${py(step.expected || (step.action === 'validar' ? negative.expected : ''))}, "description": ${py(step.description || step.name)}}`).join(',\n');
  const negativeActions = ['navegar', 'desplazar', 'validar_contenido', 'escribir', 'limpiar', 'seleccionar', 'clic', 'doble_clic', 'presionar_tecla', 'validar', 'validar_oculto', 'validar_conteo', 'validar_valor', 'validar_marcado', 'validar_desmarcado', 'esperar'];
  const negativeReady = negativeSteps.length >= 2 && Boolean(String(negative.expected || '').trim()) && negativeSteps.every(step => negativeActions.includes(step.action) && (['navegar', 'desplazar', 'validar_contenido'].includes(step.action) || Boolean(step.selector)));
  const aiCommentBlock = (data.aiCodeComments || []).map(comment => `# Sugerencia QA del SuperAgente (revisar): ${String(comment).replace(/[\r\n]+/g, ' ')}`).join('\n');
  // A smoke run must include at least one assertion after the essential action
  // (for example, confirming that login reached the inventory page).
  const smokeLimit = Math.min(5, steps.length);
  const cases = [];
  if (tests.includes('humo')) cases.push(`def test_humo(page: Page) -> None:\n    """Comprueba solo los primeros pasos esenciales."""\n    ejecutar_pasos(page, PASOS[:${smokeLimit}])`);
  if (tests.includes('funcional')) cases.push(`def test_flujo_funcional(page: Page) -> None:\n    """Flujo completo con las validaciones configuradas en la vista previa."""\n    ejecutar_pasos(page, PASOS)`);
  if (tests.includes('regresion')) cases.push(`@pytest.mark.parametrize("variante", ["positiva", "negativa"])\ndef test_regresion(page: Page, variante: str) -> None:\n    """La variante negativa verifica sus aserciones explícitas; si faltan, se omite."""\n    if variante == "positiva":\n        ejecutar_pasos(page, PASOS)\n    else:\n        if NEGATIVO_CONFIGURADO:\n            ejecutar_pasos(page, PASOS_NEGATIVOS)\n        else:\n            pytest.skip("Completar PASOS_NEGATIVOS y sus aserciones en la vista previa.")`);
  if (tests.includes('integracion')) cases.push(`def test_integracion_ui(page: Page) -> None:\n    """Valida el flujo de interfaz; las consultas SQL sugeridas no se ejecutan."""\n    ejecutar_pasos(page, PASOS)`);
  if (tests.includes('carga')) cases.push(`def test_carga_concurrente() -> None:\n    """Mide la respuesta de la página base con usuarios aislados en paralelo."""\n    from concurrent.futures import ThreadPoolExecutor, as_completed\n    from statistics import median\n    usuarios = max(1, min(USUARIOS_SIMULTANEOS, 25))\n    iteraciones = max(1, min(ITERACIONES, 100))\n    duraciones = []\n    errores = []\n    with ThreadPoolExecutor(max_workers=usuarios) as pool:\n        futures = [pool.submit(_ejecutar_usuario_carga, usuario, iteraciones) for usuario in range(1, usuarios + 1)]\n        for future in as_completed(futures):\n            try:\n                duraciones.extend(future.result())\n            except Exception as error:\n                errores.append(f"{type(error).__name__}: {error}")\n    if errores:\n        pytest.fail("Falló uno o más usuarios concurrentes: " + " | ".join(errores))\n    ordenadas = sorted(duraciones)\n    p95 = ordenadas[min(len(ordenadas) - 1, int(len(ordenadas) * 0.95))]\n    print(f"\\nCarga concurrente de página base: {usuarios} usuarios × {iteraciones} iteraciones; mediana={median(ordenadas):.2f}s; p95={p95:.2f}s")`);
  if (!cases.length) cases.push(`def test_flujo_funcional(page: Page) -> None:\n    ejecutar_pasos(page, PASOS)`);
  const source = `"""
Prueba generada por FlowBDD.
Plantilla para revisar. FlowBDD no ejecuta esta prueba.
"""
${aiCommentBlock}
import re
import os
try:
    import pytest
except ModuleNotFoundError:
    raise SystemExit("Falta pytest. Instala con: python -m pip install pytest")
try:
    from playwright.sync_api import Page, expect, sync_playwright
except ModuleNotFoundError:
    raise SystemExit("Falta Playwright. Instala con: python -m pip install playwright; python -m playwright install chromium")
from typing import Dict, List

URL_BASE = ${py(data.urlBase || (data.url ? new URL(data.url).origin : ''))}
RUTA_ESPECIFICA = ${py(data.path || '/')}
URL_PRUEBA = ${py(data.url || `${data.urlBase || ''}${data.path || '/'}`)}
NOMBRE_PRUEBA = ${py(data.title || 'Flujo funcional')}
FECHA_GENERACION = ${py(data.generatedAt || 'completar')}
TIEMPO_ESPERA_MS = ${Number(data.timeoutSeconds || 5) * 1000}
PAUSA_ENTRE_ACCIONES_MS = max(0, min(int(os.getenv("FLOWBDD_STEP_DELAY_MS", "${Number(data.stepDelayMs ?? 1800)}")), 5000))
TIMEOUT_NAVEGACION_MS = max(TIEMPO_ESPERA_MS, int(os.getenv("FLOWBDD_NAVIGATION_TIMEOUT_MS", "60000")))
TIMEOUT_CONTENIDO_MS = max(TIEMPO_ESPERA_MS, int(os.getenv("FLOWBDD_CONTENT_TIMEOUT_MS", "30000")))
REINTENTOS_NAVEGACION = max(1, min(int(os.getenv("FLOWBDD_NAVIGATION_RETRIES", "2")), 5))
HEADLESS = os.getenv("FLOWBDD_HEADLESS", "0").strip().lower() in {"1", "true", "yes", "si"}
BROWSER_CHANNEL = os.getenv("FLOWBDD_BROWSER_CHANNEL", "chrome").strip()
ITERACIONES = ${Number(data.iterations || 1)}
USUARIOS_SIMULTANEOS = ${Math.max(1, Math.min(Number(data.concurrentUsers || 1), 25))}
DATOS_PRUEBA = ${py(data.testData || {})}
BDD_GHERKIN = ${py(data.bdd || '')}
PASOS_NEGATIVOS = [
${negativeSpecs}
]
MENSAJE_NEGATIVO = ${py(negative.expected || '')}
NEGATIVO_CONFIGURADO = ${negativeReady ? 'True' : 'False'}
PASOS = [
${specs}
]

# Prioridad de localización requerida: XPath, CSS, atributo name, ID.
def obtener_localizador(page: Page, paso: dict):
    selector = (paso.get("selector") or "").strip()
    tipo = (paso.get("selector_type") or "").lower()
    candidates = paso.get("selectors") or {}
    if selector and not candidates:
        candidates = {paso.get("selector_type") or "CSS": selector}
    if not selector and not candidates and paso.get("expected"):
        return page.locator("body")
    if not selector and not candidates:
        pytest.skip("⚠️ PENDIENTE DE VALIDACIÓN MANUAL: completar selector y acción.")
    ordered = [("xpath", candidates.get("XPath")), ("css", candidates.get("CSS")), ("name", candidates.get("Name")), ("id", candidates.get("ID"))]
    if selector and not any(value for _, value in ordered):
        ordered = [(tipo or "css", selector)]
    for kind, value in ordered:
        if not value:
            continue
        if kind == "xpath":
            locator = page.locator(value if value.startswith("xpath=") else f"xpath={value}")
        elif kind == "name":
            locator = page.locator(f'[name="{value}"]')
        elif kind == "id":
            locator = page.locator(f'#{value}')
        else:
            locator = page.locator(value)
        if locator.count() and locator.first.is_visible():
            return locator if (paso.get("action") or "").lower() == "validar_conteo" else locator.first
    return page.locator(selector or next((value for _, value in ordered if value), ""))

def accion_irreversible(paso: dict) -> bool:
    texto = " ".join(str(paso.get(clave) or "") for clave in ("name", "description", "selector")).casefold()
    return any(term in texto for term in ("comprar", "purchase", "pagar", "pay now", "borrar", "eliminar", "delete", "publicar", "publish", "enviar mensaje", "send message", "finalizar pedido", "finalizar compra", "confirmar compra", "place order"))

def ejecutar_pasos(page: Page, pasos: List[Dict]) -> None:
    for paso in pasos:
        accion = (paso.get("action") or "manual").lower()
        if accion in ("navegar", "goto"):
            destino = paso.get("value") or URL_BASE + RUTA_ESPECIFICA
            if not destino:
                pytest.skip("Completar la URL base en la vista previa.")
            response = None
            ultimo_error = None
            for intento in range(1, REINTENTOS_NAVEGACION + 1):
                try:
                    # Esperar DOM listo permite localizar body sin esperar imágenes ni anuncios.
                    response = page.goto(destino, wait_until="domcontentloaded", timeout=TIMEOUT_NAVEGACION_MS)
                    ultimo_error = None
                    break
                except Exception as error:
                    ultimo_error = error
                    if intento < REINTENTOS_NAVEGACION:
                        page.wait_for_timeout(min(1000 * intento, 3000))
            if ultimo_error is not None:
                raise AssertionError(
                    f"No se pudo abrir {destino} tras {REINTENTOS_NAVEGACION} intento(s). "
                    f"Último error: {type(ultimo_error).__name__}: {ultimo_error}"
                ) from ultimo_error
            assert response is None or response.status < 400, f"HTTP {response.status if response else 'sin respuesta'}"
            page.locator("body").wait_for(state="visible", timeout=TIMEOUT_CONTENIDO_MS)
            page.wait_for_timeout(PAUSA_ENTRE_ACCIONES_MS)
            continue
        if accion in ("desplazar", "scroll"):
            page.evaluate("window.scrollBy(0, Math.max(window.innerHeight * 0.8, 400))")
            page.wait_for_timeout(PAUSA_ENTRE_ACCIONES_MS)
            continue
        if accion in ("validar_contenido", "validar contenido"):
            body = page.locator("body")
            expect(body).to_be_visible()
            page.wait_for_function("document.body && document.body.innerText.trim().length > 0", timeout=TIMEOUT_CONTENIDO_MS)
            assert page.locator("body").inner_text().strip(), "La página cargó sin contenido visible"
            page.wait_for_timeout(PAUSA_ENTRE_ACCIONES_MS)
            continue
        locator = obtener_localizador(page, paso)
        if accion == "validar_oculto":
            expect(locator).to_be_hidden()
            page.wait_for_timeout(PAUSA_ENTRE_ACCIONES_MS)
            continue
        if accion == "validar_conteo":
            esperado = int(paso.get("expected", "0"))
            actual = locator.count()
            assert actual == esperado, f"Se esperaban {esperado} elementos y se encontraron {actual}: {paso.get('name')}"
            page.wait_for_timeout(PAUSA_ENTRE_ACCIONES_MS)
            continue
        locator.wait_for(state="visible", timeout=TIEMPO_ESPERA_MS)
        if accion in ("escribir", "fill", "completar"):
            value = str(paso.get("value", ""))
            if value.startswith("\${") and value.endswith("}"):
                key = value[2:-1]
                resolved = DATOS_PRUEBA.get(key, value)
                if not resolved or resolved == value:
                    pytest.skip(f"Completar el dato {key} en DATOS_PRUEBA.")
                value = str(resolved)
            locator.fill(value)
        elif accion == "limpiar":
            locator.fill("")
        elif accion == "presionar_tecla":
            locator.press(str(paso.get("value") or "Enter"))
        elif accion == "doble_clic":
            locator.dblclick()
        elif accion in ("seleccionar", "select"):
            locator.select_option(str(paso.get("value", "")))
        elif accion in ("clic", "click", "presionar"):
            if accion_irreversible(paso):
                pytest.skip(f"Acción irreversible bloqueada para confirmación manual: {paso.get('name') or paso.get('description')}")
            locator.click()
        elif accion in ("validar", "verificar", "assert", "texto_visible"):
            expect(locator).to_be_visible()
            if paso.get("expected"):
                expect(locator).to_contain_text(paso["expected"])
        elif accion == "validar_valor":
            expect(locator).to_have_value(str(paso.get("expected", "")))
        elif accion in ("validar_marcado", "validar_desmarcado"):
            expect(locator).to_be_checked() if accion == "validar_marcado" else expect(locator).not_to_be_checked()
        elif accion in ("esperar", "wait"):
            locator.wait_for(state="visible", timeout=TIEMPO_ESPERA_MS)
        else:
            pytest.skip(f"Acción pendiente de definir: {accion}")
        page.wait_for_timeout(PAUSA_ENTRE_ACCIONES_MS)

def _ejecutar_usuario_carga(usuario: int, iteraciones: int) -> List[float]:
    """Cada usuario mide la página base con navegador y contexto propios."""
    from time import perf_counter
    muestras = []
    with sync_playwright() as playwright:
        # La concurrencia usa Chromium headless para no abrir hasta 25 ventanas.
        try:
            # Use installed Chrome for the concurrent run when Playwright's bundled
            # headless shell has not been installed on this machine.
            browser = playwright.chromium.launch(headless=True, channel=BROWSER_CHANNEL) if BROWSER_CHANNEL else playwright.chromium.launch(headless=True)
        except Exception:
            browser = playwright.chromium.launch(headless=True)
        try:
            context = browser.new_context(viewport={"width": 1280, "height": 720})
            page = context.new_page()
            page.set_default_timeout(max(TIEMPO_ESPERA_MS, TIMEOUT_CONTENIDO_MS))
            page.set_default_navigation_timeout(TIMEOUT_NAVEGACION_MS)
            for _ in range(iteraciones):
                inicio = perf_counter()
                response = page.goto(URL_PRUEBA, wait_until="domcontentloaded", timeout=TIMEOUT_NAVEGACION_MS)
                assert response is None or response.status < 400, f"HTTP {response.status if response else 'sin respuesta'}"
                page.wait_for_function("document.body && document.body.innerText.trim().length > 0", timeout=TIMEOUT_CONTENIDO_MS)
                muestras.append(perf_counter() - inicio)
            context.close()
        finally:
            browser.close()
    return muestras

@pytest.fixture
def page() -> Page:
    """Abre Chrome visible si está instalado; si no, usa Chromium visible de Playwright."""
    with sync_playwright() as playwright:
        launch_options = {"headless": HEADLESS}
        if BROWSER_CHANNEL:
            launch_options["channel"] = BROWSER_CHANNEL
        try:
            browser = playwright.chromium.launch(**launch_options)
        except Exception as error:
            if BROWSER_CHANNEL.lower() != "chrome" or HEADLESS:
                raise
            print(f"Chrome no está disponible ({error}); se abrirá Chromium de Playwright.")
            browser = playwright.chromium.launch(headless=False)
        context = browser.new_context(viewport={"width": 1280, "height": 720})
        current_page = context.new_page()
        current_page.set_default_timeout(TIEMPO_ESPERA_MS)
        current_page.set_default_navigation_timeout(TIMEOUT_NAVEGACION_MS)
        try:
            yield current_page
        finally:
            context.close()
            browser.close()

${cases.join('\n\n')}

if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v"]))
`;
  return replaceLoneSurrogates(source);
}

function buildAppiumPython(data) {
  const platform = data.targetPlatform === 'desktop' ? 'Windows' : (data.platformConfig?.mobileOs || 'Android');
  const automationName = platform === 'Windows' ? 'Windows' : platform === 'iOS' ? 'XCUITest' : 'UiAutomator2';
  const config = data.platformConfig || {};
  const steps = data.steps || [];
  const specs = steps.map((step, index) => `    {"number": ${index + 1}, "name": ${py(step.name)}, "action": ${py(step.action)}, "selector": ${py(step.selector)}, "selector_type": ${py(step.selectorType)}, "value": ${py(step.value)}, "expected": ${py(step.expected)}}`).join(',\n');
  const negative = data.negativeScenario || {};
  const negativeSteps = Array.isArray(negative.steps) ? negative.steps : [];
  const negativeSpecs = negativeSteps.map((step, index) => `    {"number": ${index + 1}, "name": ${py(step.name || step.description)}, "action": ${py(step.action)}, "selector": ${py(step.selector)}, "selector_type": ${py(step.selectorType)}, "value": ${py(step.value)}, "expected": ${py(step.expected)}}`).join(',\n');
  const negativeReady = negativeSteps.length >= 2 && Boolean(String(negative.expected || '').trim()) && negativeSteps.every(step => ['navegar', 'validar_contenido', 'escribir', 'limpiar', 'seleccionar', 'clic', 'doble_clic', 'presionar_tecla', 'validar', 'validar_oculto', 'validar_conteo', 'validar_marcado', 'validar_desmarcado', 'esperar', 'manual'].includes(step.action));
  const cases = [];
  if ((data.testTypes || []).includes('humo')) cases.push(`    def test_humo(self):\n        self.execute_steps(PASOS[:4])`);
  if ((data.testTypes || []).includes('funcional')) cases.push(`    def test_flujo_funcional(self):\n        self.execute_steps(PASOS)`);
  if ((data.testTypes || []).includes('regresion')) cases.push(`    def test_regresion_positiva(self):\n        self.execute_steps(PASOS)\n\n    def test_regresion_negativa(self):\n        if not NEGATIVO_CONFIGURADO:\n            self.skipTest("Completa el escenario negativo y sus aserciones antes de ejecutar.")\n        self.execute_steps(PASOS_NEGATIVOS)`);
  if ((data.testTypes || []).includes('integracion')) cases.push(`    def test_integracion_ui(self):\n        self.execute_steps(PASOS)  # Agrega aquí validaciones API/BD si están disponibles.`);
  if ((data.testTypes || []).includes('carga')) cases.push(`    def test_carga_no_implementada_en_appium(self):\n        self.skipTest("Appium no genera una prueba de carga concurrente. Mide API/backend con una herramienta de carga dedicada.")`);
  if (!cases.length) cases.push(`    def test_flujo_funcional(self):\n        self.execute_steps(PASOS)`);
  const source = `"""Plantilla FlowBDD para automatización nativa con Appium.
Revisar selectores de accesibilidad y configurar Appium, driver y aplicación/dispositivo.
"""
import os
import sys
import time
import unittest
try:
    from appium import webdriver
    from appium.options.common import AppiumOptions
    from appium.webdriver.common.appiumby import AppiumBy
    from selenium.common.exceptions import NoSuchElementException
    from selenium.webdriver.common.action_chains import ActionChains
    from selenium.webdriver.common.keys import Keys
    from selenium.webdriver.support.ui import Select
except ModuleNotFoundError as error:
    raise SystemExit("Falta Appium Python Client. Instala con: python -m pip install Appium-Python-Client") from error

PLATFORM = ${py(platform)}
AUTOMATION_NAME = ${py(automationName)}
APPIUM_SERVER_URL = os.getenv("FLOWBDD_APPIUM_URL", ${py(config.appiumServerUrl || 'http://127.0.0.1:4723')})
DEVICE_NAME = os.getenv("FLOWBDD_DEVICE_NAME", ${py(config.deviceName || (platform === 'Windows' ? 'WindowsPC' : 'Android Emulator'))})
APP_PATH = os.getenv("FLOWBDD_APP_PATH", ${py(platform === 'Windows' ? (config.desktopAppPath || '') : (config.mobileAppPath || ''))})
APP_ID = os.getenv("FLOWBDD_APP_ID", ${py(platform === 'Windows' ? '' : (config.mobileAppId || ''))})
APP_ACTIVITY = os.getenv("FLOWBDD_APP_ACTIVITY", ${py(config.appActivity || '')})
PAUSA_ENTRE_ACCIONES = max(0, min(float(os.getenv("FLOWBDD_STEP_DELAY_SECONDS", "0.8")), 5.0))
PASOS = [
${specs}
]
PASOS_NEGATIVOS = [
${negativeSpecs}
]
NEGATIVO_CONFIGURADO = ${negativeReady ? 'True' : 'False'}

def crear_opciones():
    options = AppiumOptions()
    options.set_capability("platformName", PLATFORM)
    options.set_capability("appium:automationName", AUTOMATION_NAME)
    options.set_capability("appium:deviceName", DEVICE_NAME)
    if APP_PATH:
        options.set_capability("appium:app", APP_PATH)
    if APP_ID and PLATFORM == "Android":
        options.set_capability("appium:appPackage", APP_ID)
        if APP_ACTIVITY:
            options.set_capability("appium:appActivity", APP_ACTIVITY)
    elif APP_ID and PLATFORM == "iOS":
        options.set_capability("appium:bundleId", APP_ID)
    return options

def validar_configuracion():
    missing = []
    if not APPIUM_SERVER_URL:
        missing.append("FLOWBDD_APPIUM_URL")
    if PLATFORM == "Windows" and not APP_PATH:
        missing.append("FLOWBDD_APP_PATH (ruta .exe o ID UWP)")
    if PLATFORM == "Android" and not (APP_PATH or APP_ID):
        missing.append("FLOWBDD_APP_PATH (.apk) o FLOWBDD_APP_ID (package Android)")
    if PLATFORM == "iOS" and not (APP_PATH or APP_ID):
        missing.append("FLOWBDD_APP_PATH (.app/.ipa) o FLOWBDD_APP_ID (bundle ID)")
    if PLATFORM == "iOS" and sys.platform != "darwin":
        missing.append("iOS requiere Appium/XCUITest ejecutándose en macOS")
    if missing:
        raise SystemExit("Configura antes de ejecutar: " + "; ".join(missing))

class FlowBDDNativeTests(unittest.TestCase):
    def setUp(self):
        self.driver = webdriver.Remote(APPIUM_SERVER_URL, options=crear_opciones())

    def tearDown(self):
        if getattr(self, "driver", None):
            self.driver.quit()

    def find(self, step):
        selector = str(step.get("selector") or "").strip()
        kind = str(step.get("selector_type") or "XPath").casefold()
        if not selector:
            self.skipTest("PENDIENTE: completar un selector de accesibilidad para este control nativo.")
        strategies = {"xpath": AppiumBy.XPATH, "id": AppiumBy.ID, "name": AppiumBy.NAME,
                      "accessibility id": AppiumBy.ACCESSIBILITY_ID, "accessibility_id": AppiumBy.ACCESSIBILITY_ID,
                      "automationid": AppiumBy.ACCESSIBILITY_ID, "class name": AppiumBy.CLASS_NAME,
                      "classname": AppiumBy.CLASS_NAME}
        by = strategies.get(kind)
        if not by:
            self.skipTest(f"Selector {kind} no es nativo. Usa XPath, ID, Name, Class Name o Accessibility ID.")
        return self.driver.find_element(by, selector)

    def execute_steps(self, steps):
        for step in steps:
            action = str(step.get("action") or "manual").casefold()
            if action in ("navegar", "goto"):
                target = str(step.get("value") or "")
                if target.startswith("http"):
                    self.driver.get(target)
                # La aplicación nativa se abre mediante app/package en las capacidades de Appium.
                time.sleep(PAUSA_ENTRE_ACCIONES)
                continue
            if action == "validar_contenido":
                self.assertTrue(self.driver.page_source.strip(), "La aplicación no expuso contenido accesible.")
                continue
            if action == "desplazar":
                self.skipTest("Completa el gesto de desplazamiento específico para el dispositivo objetivo.")
            if action == "manual":
                self.skipTest("Paso pendiente de automatización manual.")
            if action == "validar_conteo":
                selector = step.get("selector") or ""
                kind = (step.get("selector_type") or "ID").casefold()
                strategies = {"xpath": AppiumBy.XPATH, "id": AppiumBy.ID, "name": AppiumBy.NAME,
                              "accessibility id": AppiumBy.ACCESSIBILITY_ID, "class name": AppiumBy.CLASS_NAME}
                by = strategies.get(kind)
                if not by:
                    self.skipTest(f"No hay estrategia nativa para el selector {kind}.")
                actual = len(self.driver.find_elements(by, selector))
                self.assertEqual(actual, int(step.get("expected") or step.get("value") or 0), step.get("name"))
                continue
            try:
                element = self.find(step)
                if action == "validar_oculto":
                    self.assertFalse(element.is_displayed(), step.get("name"))
                elif action == "validar_marcado":
                    self.assertTrue(element.is_selected(), step.get("name"))
                elif action == "validar_desmarcado":
                    self.assertFalse(element.is_selected(), step.get("name"))
                elif action in ("escribir", "limpiar"):
                    element.clear()
                    if action == "escribir":
                        element.send_keys(str(step.get("value") or ""))
                elif action == "presionar_tecla":
                    key = str(step.get("value") or "Enter").casefold()
                    element.send_keys(Keys.ENTER if key in ("enter", "return") else key)
                elif action in ("clic", "click", "presionar"):
                    element.click()
                elif action == "doble_clic":
                    ActionChains(self.driver).double_click(element).perform()
                elif action == "seleccionar":
                    Select(element).select_by_value(str(step.get("value") or ""))
                elif action == "validar":
                    self.assertTrue(element.is_displayed(), step.get("name"))
                    if step.get("expected"):
                        self.assertIn(str(step["expected"]), element.text)
                elif action == "esperar":
                    time.sleep(PAUSA_ENTRE_ACCIONES)
                elif action == "validar_valor":
                    self.assertEqual(element.get_attribute("value"), str(step.get("expected") or ""), step.get("name"))
                else:
                    self.skipTest(f"Acción nativa aún no mapeada: {action}")
            except NoSuchElementException:
                if action == "validar_oculto":
                    continue
                raise
            time.sleep(PAUSA_ENTRE_ACCIONES)

${cases.join('\n\n')}

if __name__ == "__main__":
    validar_configuracion()
    unittest.main(verbosity=2)
`;
  return replaceLoneSurrogates(source);
}






