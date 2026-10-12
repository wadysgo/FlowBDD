"""FlowBDD's trusted visible Playwright runner. Input is JSON, never Python code."""
import json
import html
import os
import sys
import time
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

MAX_SCROLL_SEGMENTS = 14


def emit(kind, text="", **extra):
    print(json.dumps({"type": kind, "text": text, **extra}, ensure_ascii=False), flush=True)


class PendingStep(Exception):
    pass


def read_payload():
    payload = json.loads(sys.stdin.readline())
    if not isinstance(payload, dict) or not isinstance(payload.get("steps"), list):
        raise ValueError("El flujo no tiene una lista de pasos válida.")
    return payload


def locator_for(page, step):
    candidates = step.get("candidates") or {}
    selector = (step.get("selector") or "").strip()
    selector_type = step.get("selectorType") or "CSS"
    if selector and not candidates:
        candidates = {selector_type: selector}
    ordered = [("XPath", "xpath"), ("CSS", "css"), ("Name", "name"), ("ID", "id")]
    for kind, key in ordered:
        value = candidates.get(kind)
        if not value:
            continue
        if kind == "XPath":
            locator = page.locator(value if value.startswith("xpath=") else f"xpath={value}")
        elif kind == "Name":
            locator = page.locator(f'[name="{value}"]')
        elif kind == "ID":
            locator = page.locator(f"#{value}")
        else:
            locator = page.locator(value)
        if locator.count() and locator.first.is_visible():
            return locator if (step.get("action") or "").lower() == "validar_conteo" else locator.first
    if selector:
        if selector.startswith("//"):
            selector = f"xpath={selector}"
        return page.locator(selector)
    if (step.get("action") or "").lower() in ("validar", "verificar", "assert", "texto_visible") and step.get("expected"):
        return page.locator("body")
    raise PendingStep("Paso sin selector: complete XPath/CSS/Name/ID en la vista previa.")


def wait_for_user_if_login(page):
    password = page.locator('input[type="password"]')
    if not password.count() or not password.first.is_visible():
        return
    emit("auth_required", "Chrome muestra un inicio de sesión. Inicia sesión manualmente en la ventana y pulsa ‘Continuar’ aquí.")
    command = sys.stdin.readline().strip().lower()
    if command == "skip":
        raise InterruptedError("Caso omitido por el usuario durante la autenticación.")
    if command != "continue":
        raise RuntimeError("Se cerró el canal de control mientras se esperaba el inicio de sesión.")
    emit("log", "Continuando después del inicio de sesión manual.")


def has_scripted_login(steps):
    """Detecta credenciales y envío ya descritos para no interrumpir su ejecución."""
    actions = [(step.get("action") or "").lower() for step in steps]
    descriptions = " ".join((step.get("description") or step.get("name") or "").lower() for step in steps)
    has_user = any(any(term in text for term in ("usuario", "correo", "email", "username")) and action in ("escribir", "fill", "completar")
                   for step, action in zip(steps, actions) for text in [(step.get("description") or step.get("name") or "").lower()])
    has_password = any(any(term in ((step.get("description") or step.get("name") or "").lower()) for term in ("contrase", "password")) and action in ("escribir", "fill", "completar")
                       for step, action in zip(steps, actions))
    has_submit = any(action in ("clic", "click", "presionar") for action in actions) and any(term in descriptions for term in ("iniciar sesión", "iniciar sesion", "login", "ingresar"))
    return has_user and has_password and has_submit


def _irreversible_step(step):
    label = " ".join(str(step.get(key) or "") for key in ("name", "description", "selector")).casefold()
    return any(term in label for term in ("comprar", "purchase", "pagar", "pay now", "borrar", "eliminar", "delete", "publicar", "publish", "enviar mensaje", "send message", "finalizar pedido", "finalizar compra", "confirmar compra", "place order", "finish"))


def execute_steps(page, steps, payload, case_name, on_step_done=None):
    timeout = int(payload.get("timeoutSeconds", 10)) * 1000
    navigation_timeout = max(timeout, int(os.getenv("FLOWBDD_NAVIGATION_TIMEOUT_MS", "60000")))
    delay_ms = int(payload.get("stepDelayMs", 850))
    page.set_default_timeout(timeout)
    page.set_default_navigation_timeout(navigation_timeout)
    skipped_steps = 0
    for index, step in enumerate(steps, 1):
        action = (step.get("action") or "manual").lower()
        description = step.get("description") or step.get("name") or f"Paso {index}"
        emit("step", f"{case_name}: paso {index}/{len(steps)} — {description}", case=case_name, step=index, total=len(steps))
        if action in ("navegar", "goto"):
            destination = step.get("value") or payload.get("url")
            if not destination:
                raise LookupError("Falta la URL del paso de navegación.")
            response = page.goto(destination, wait_until="commit", timeout=navigation_timeout)
            if response is not None and response.status >= 400:
                raise AssertionError(f"La URL respondió HTTP {response.status}: {destination}")
            page.wait_for_timeout(delay_ms)
            if on_step_done:
                on_step_done(description)
            continue
        if action in ("desplazar", "scroll"):
            page.evaluate("window.scrollBy(0, Math.max(window.innerHeight * 0.8, 400))")
            page.wait_for_timeout(delay_ms)
            if on_step_done:
                on_step_done(description)
            continue
        if action in ("validar_contenido", "validar contenido"):
            body = page.locator("body")
            body.wait_for(state="visible", timeout=timeout)
            page.wait_for_function("document.body && document.body.innerText.trim().length > 0", timeout=timeout)
            if not body.inner_text().strip():
                raise AssertionError("La página cargó sin contenido visible.")
            page.wait_for_timeout(delay_ms)
            if on_step_done:
                on_step_done(description)
            continue
        if action == "manual":
            skipped_steps += 1
            emit("step_skipped", f"Pendiente de completar manualmente: {description}", case=case_name, step=index)
            if on_step_done:
                on_step_done(description)
            continue
        if action in ("clic", "click", "presionar") and _irreversible_step(step):
            skipped_steps += 1
            emit("step_skipped", f"Acción irreversible pendiente de confirmación manual: {description}", case=case_name, step=index)
            if on_step_done:
                on_step_done(description)
            continue
        try:
            locator = locator_for(page, step)
        except PendingStep as error:
            skipped_steps += 1
            emit("step_skipped", f"Paso omitido por falta de datos/selectores: {error}", case=case_name, step=index)
            if on_step_done:
                on_step_done(description)
            continue
        if action == "validar_oculto":
            if locator.is_visible():
                raise AssertionError(f"Se esperaba que el elemento estuviera oculto: {description}")
            page.wait_for_timeout(delay_ms)
            if on_step_done:
                on_step_done(description)
            continue
        if action == "validar_conteo":
            expected_count = int(step.get("expected") or step.get("value") or 0)
            actual_count = locator.count()
            if actual_count != expected_count:
                raise AssertionError(f"Se esperaban {expected_count} elementos y se encontraron {actual_count}: {description}")
            page.wait_for_timeout(delay_ms)
            if on_step_done:
                on_step_done(description)
            continue
        locator.wait_for(state="visible", timeout=timeout)
        if action in ("escribir", "fill", "completar"):
            value = str(step.get("value") or "")
            if value.startswith("${") and value.endswith("}"):
                key = value[2:-1]
                value = str((payload.get("testData") or {}).get(key) or "")
                if not value:
                    skipped_steps += 1
                    emit("step_skipped", f"Paso omitido: falta completar el dato de prueba {key}.", case=case_name, step=index)
                    if on_step_done:
                        on_step_done(description)
                    continue
            locator.fill(value)
        elif action == "limpiar":
            locator.fill("")
        elif action == "presionar_tecla":
            locator.press(str(step.get("value") or "Enter"))
        elif action == "doble_clic":
            locator.dblclick()
        elif action in ("clic", "click", "presionar"):
            locator.click()
        elif action in ("validar", "verificar", "assert", "texto_visible"):
            if not locator.is_visible():
                raise AssertionError(f"No está visible el elemento: {description}")
            expected = step.get("expected")
            actual_text = " ".join(locator.inner_text().split())
            expected_text = " ".join(expected.split()) if expected else ""
            if expected_text and expected_text not in actual_text:
                raise AssertionError(f"Texto esperado no encontrado: {expected}")
        elif action in ("validar_marcado", "validar_desmarcado"):
            checked = locator.is_checked()
            expected_checked = action == "validar_marcado"
            if checked != expected_checked:
                raise AssertionError(f"Estado marcado esperado={expected_checked}, actual={checked}: {description}")
        elif action in ("esperar", "wait"):
            locator.wait_for(state="visible", timeout=timeout)
        elif action == "manual":
            raise PendingStep(f"Paso pendiente de acción manual: {description}")
        else:
            raise ValueError(f"Acción desconocida '{action}' en {description}.")
        page.wait_for_timeout(delay_ms)
        if on_step_done:
            on_step_done(description)
    return skipped_steps


def _progress(percent, stage, current, pages=0, controls=0, completed=0, total=0):
    emit("progress", current, percent=max(0, min(100, round(percent))), stage=stage,
         pages=pages, controls=controls, completed=completed, total=total)


def _label_is_risky(label, href=""):
    text = f"{label} {href}".lower()
    risky = ("logout", "log out", "sign out", "cerrar sesión", "cerrar sesion", "delete", "eliminar", "borrar",
             "remove", "purchase", "checkout", "pagar", "comprar", "suscrib", "subscribe", "unsubscribe",
             "like", "dislike", "report", "denunciar", "upload", "subir", "crear playlist", "create playlist",
             "add to playlist", "agregar a playlist", "guardar", "save", "comment", "comentar", "publicar",
             "publish", "enviar", "send", "compartir", "share", "watch", "/shorts/")
    return any(word in text for word in risky)


def _allowed_origin(url, start_url):
    candidate = urlsplit(url)
    origin = urlsplit(start_url)
    if candidate.scheme not in ("http", "https"):
        return False
    if candidate.netloc.lower() == origin.netloc.lower():
        return True
    youtube_hosts = {"youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"}
    return origin.hostname in youtube_hosts and candidate.hostname in youtube_hosts


def _page_controls(page):
    return page.evaluate("""() => {
      const all = [...document.querySelectorAll('a[href],button,input,select,textarea,[role="button"],[role="tab"],summary')];
      const visible = all.filter(el => {
        const s = getComputedStyle(el);
        return el.getClientRects().length > 0 && s.visibility !== 'hidden' && s.display !== 'none';
      });
      return { total: all.length, visible: visible.length, items: visible.slice(0, 500).map(el => ({
        label: (el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || '').trim().replace(/\\s+/g, ' ').slice(0, 100),
        href: el.tagName.toLowerCase() === 'a' ? el.href : '',
        target: el.tagName.toLowerCase() === 'a' ? (el.target || '') : '',
        tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || '',
        id: el.id || '', name: el.getAttribute('name') || '',
        aria: el.getAttribute('aria-label') || '', placeholder: el.getAttribute('placeholder') || '',
        test_id: el.getAttribute('data-testid') || el.getAttribute('data-test') || '',
        selector_candidates: (() => {
          const tag = el.tagName.toLowerCase();
          const candidates = [];
          if (el.id) candidates.push({type:'XPath', selector:`//*[@id=${JSON.stringify(el.id)}]`}, {type:'CSS', selector:`#${CSS.escape(el.id)}`});
          if (el.getAttribute('name')) candidates.push({type:'Name', selector:el.getAttribute('name')});
          if (el.getAttribute('data-testid')) candidates.push({type:'CSS', selector:`${tag}[data-testid=${JSON.stringify(el.getAttribute('data-testid'))}]`});
          if (el.getAttribute('data-test')) candidates.push({type:'CSS', selector:`${tag}[data-test=${JSON.stringify(el.getAttribute('data-test'))}]`});
          if (!candidates.length) candidates.push({type:'CSS', selector:tag, needs_review:true});
          return candidates;
        })(),
        expanded: el.getAttribute('aria-expanded'), disabled: !!el.disabled,
        type: el.getAttribute('type') || ''
      })) };
    }""")


def _scan_safe_disclosures(page, payload, route_label, interactions):
    """Exercise only view-local tabs and explicit disclosure controls."""
    delay_ms = int(payload.get("stepDelayMs", 850))
    tabs = page.locator('[role="tab"]')
    try:
        tab_count = min(tabs.count(), 8)
        for index in range(tab_count):
            tab = page.locator('[role="tab"]').nth(index)
            try:
                if not tab.is_visible() or not tab.is_enabled():
                    continue
                label = (tab.inner_text() or tab.get_attribute("aria-label") or "Pestaña").strip()[:80]
                if _label_is_risky(label):
                    continue
                emit("step", f"Interacción segura: pestaña «{label}» en {route_label}.", case="Exploración segura de interfaz")
                tab.click(timeout=4000)
                page.wait_for_timeout(delay_ms)
                interactions.append({"page": route_label, "control": label, "result": "clic seguro en pestaña"})
            except Exception as error:
                interactions.append({"page": route_label, "control": f"pestaña {index + 1}", "result": f"no verificada: {type(error).__name__}"})
    except Exception:
        pass

    # Reveal only controls clearly labelled as menus, navigation or expanders.
    try:
        controls = page.locator('button[aria-expanded="false"], [role="button"][aria-expanded="false"], summary')
        count = min(controls.count(), 20)
        for index in range(count):
            control = page.locator('button[aria-expanded="false"], [role="button"][aria-expanded="false"], summary').nth(index)
            try:
                if not control.is_visible() or not control.is_enabled():
                    continue
                label = (control.inner_text() or control.get_attribute("aria-label") or control.get_attribute("title") or "").strip()[:80]
                label_key = label.lower()
                safe_disclosure = any(token in label_key for token in ("menu", "menú", "navegación", "navigation", "guide", "guía", "expand", "mostrar más", "ver más", "show more", "more"))
                if not safe_disclosure or _label_is_risky(label):
                    continue
                emit("step", f"Interacción segura: abrir «{label or 'menú desplegable'}».", case="Exploración segura de interfaz")
                control.click(timeout=4000)
                page.wait_for_timeout(delay_ms)
                interactions.append({"page": route_label, "control": label or "menú desplegable", "result": "abierto para inspección"})
                break
            except Exception:
                continue
    except Exception:
        pass


def _scroll_entire_page(page, payload, route_label, progress_state):
    delay_ms = int(payload.get("stepDelayMs", 850))
    segments = 0
    viewport_counts = []
    for _ in range(MAX_SCROLL_SEGMENTS):
        metrics = page.evaluate("""() => ({ y: window.scrollY, h: window.innerHeight, total: document.documentElement.scrollHeight })""")
        if metrics["y"] + metrics["h"] >= metrics["total"] - 8:
            break
        page.evaluate("window.scrollBy(0, Math.max(window.innerHeight * 0.82, 350))")
        page.wait_for_timeout(delay_ms)
        segments += 1
        viewport_counts.append(_page_controls(page)["visible"])
        progress_state["scrolls"] += 1
        percent = min(38, 4 + progress_state["pages"] * 2 + progress_state["scrolls"] * 0.7)
        _progress(percent, "Recorriendo páginas", f"{route_label}: desplazamiento {segments}",
                  pages=progress_state["pages"], controls=progress_state["controls"])
        emit("step", f"Recorrido de página: {route_label} · zona {segments + 1}.", case="Exploración segura de interfaz")
    metrics = page.evaluate("""() => ({ y: window.scrollY, h: window.innerHeight, total: document.documentElement.scrollHeight })""")
    reached_bottom = metrics["y"] + metrics["h"] >= metrics["total"] - 8
    page.evaluate("window.scrollTo(0, 0)")
    page.wait_for_timeout(max(200, min(delay_ms, 500)))
    return {"scroll_segments": segments, "reached_bottom": reached_bottom,
            "page_height": metrics["total"], "viewport_control_counts": viewport_counts}


def explore_interface(page, start_url, payload, report_dir):
    """Walk same-site pages in the same visible Chrome tab and audit safe UI controls."""
    max_pages = max(1, min(int(payload.get("maxExplorePages", 12)), 24))
    delay_ms = int(payload.get("stepDelayMs", 850))
    navigation_timeout = max(int(payload.get("timeoutSeconds", 10)) * 1000,
                             int(os.getenv("FLOWBDD_NAVIGATION_TIMEOUT_MS", "60000")))
    page_details = []
    interactions = []
    visited = set()
    queue = [(start_url, "Inicio", "")]
    total_controls = 0
    progress_state = {"pages": 0, "controls": 0, "scrolls": 0}
    scripted_login = has_scripted_login(payload.get("steps") or [])
    _progress(1, "Abriendo navegador", "Chrome listo; comienza el recorrido.")

    while queue and len(visited) < max_pages:
        url, label, parent = queue.pop(0)
        parts = urlsplit(url)
        canonical = urlunsplit((parts.scheme, parts.netloc, parts.path, parts.query, ""))
        if canonical in visited:
            continue
        visited.add(canonical)
        try:
            if page.url.rstrip("/") != canonical.rstrip("/"):
                message = f"Abriendo {label}: {canonical}" if label != "Inicio" else f"Abriendo página: {canonical}"
                emit("step", message, case="Exploración segura de interfaz")
                response = page.goto(canonical, wait_until="commit", timeout=navigation_timeout)
                if response is not None and response.status >= 400:
                    page_details.append({"url": canonical, "label": label, "status": "FAIL", "detail": f"HTTP {response.status}"})
                    continue
                page.wait_for_timeout(delay_ms)
                if not scripted_login:
                    wait_for_user_if_login(page)
            elif page.url == "about:blank":
                response = page.goto(canonical, wait_until="commit", timeout=navigation_timeout)
                if response is not None and response.status >= 400:
                    raise AssertionError(f"HTTP {response.status}")
                page.wait_for_timeout(delay_ms)
                if not scripted_login:
                    wait_for_user_if_login(page)

            title = page.title()
            _scan_safe_disclosures(page, payload, label, interactions)
            scroll = _scroll_entire_page(page, payload, label, progress_state)
            inventory = _page_controls(page)
            items = inventory["items"]
            visible_controls = inventory["visible"]
            total_controls += visible_controls
            progress_state["pages"] = len(visited)
            progress_state["controls"] = total_controls
            screenshot = report_dir / f"pagina_{len(page_details) + 1:02d}.png"
            try:
                page.screenshot(path=str(screenshot), full_page=False)
            except Exception:
                screenshot = None
            page_details.append({"url": canonical, "label": label, "title": title,
                                 "status": "PASS", "controls_visible": visible_controls,
                                 "controls_detected": inventory["total"], "controles": items, "scroll": scroll,
                                 "screenshot": str(screenshot) if screenshot else ""})
            emit("log", f"Página revisada: {title or label} — {visible_controls} controles visibles; "
                         f"{scroll['scroll_segments']} zonas recorridas; "
                         f"{'llegó al final' if scroll['reached_bottom'] else 'límite de recorrido alcanzado'}.")
            _progress(min(40, 4 + len(visited) * 2 + progress_state["scrolls"] * 0.7),
                      "Recorriendo páginas", f"Página {len(visited)}/{max_pages}: {title or label}",
                      pages=len(visited), controls=total_controls)

            links = []
            for item in items:
                href = item["href"]
                item_label = item["label"] or href
                if not href or item.get("target") == "_blank" or _label_is_risky(item_label, href):
                    continue
                if not _allowed_origin(href, start_url):
                    continue
                parsed = urlsplit(href)
                candidate = urlunsplit((parsed.scheme, parsed.netloc, parsed.path, parsed.query, ""))
                if candidate in visited or candidate.rstrip("/") == canonical.rstrip("/"):
                    continue
                links.append((candidate, item_label[:80], canonical))
            links.sort(key=lambda entry: (0 if any(token in (entry[0] + " " + entry[1]).lower() for token in
                                                  ("history", "historial", "library", "biblioteca", "music", "música", "playlist", "listas")) else 1))
            for link in links:
                if len(queue) + len(visited) >= max_pages:
                    break
                if link[0] not in visited and all(existing[0] != link[0] for existing in queue):
                    queue.append(link)
        except InterruptedError:
            raise
        except Exception as error:
            page_details.append({"url": canonical, "label": label, "status": "FAIL",
                                 "detail": f"{type(error).__name__}: {error}"})
            emit("log", f"No se pudo completar el recorrido de {canonical}: {type(error).__name__}: {error}")

    if not page_details:
        raise AssertionError("No se pudo inspeccionar ninguna página.")
    return {"pages": page_details, "interactions": interactions,
            "controls_total": total_controls, "routes_visited": len(visited),
            "max_pages": max_pages}


def main():
    try:
        payload = read_payload()
        from playwright.sync_api import sync_playwright
    except Exception as error:
        emit("fatal", f"No se pudo iniciar el runner: {type(error).__name__}: {error}")
        return 2

    run_id = str(payload.get("runId") or "run")
    report_dir = Path(__file__).resolve().parent / "reportes" / "ejecuciones_visibles" / run_id
    report_dir.mkdir(parents=True, exist_ok=True)
    steps = payload["steps"]
    types = payload.get("testTypes") or ["funcional"]
    start_url = payload.get("url") or next((item.get("value") for item in steps if (item.get("action") or "").lower() in ("navegar", "goto")), "")
    tests = []
    if "humo" in types:
        tests.append(("Humo", steps[:4], 1))
    if "funcional" in types:
        tests.append(("Funcional", steps, 1))
    if "regresion" in types:
        negative = payload.get("negativeScenario") or {}
        negative_steps = negative.get("steps") if isinstance(negative, dict) else None
        supported_negative_actions = {"navegar", "desplazar", "validar_contenido", "escribir", "limpiar", "clic", "doble_clic", "presionar_tecla", "validar", "validar_oculto", "validar_conteo", "validar_marcado", "validar_desmarcado", "esperar"}
        negative_ready = (
            isinstance(negative_steps, list) and len(negative_steps) >= 2
            and bool(str(negative.get("expected") or "").strip())
            and all(
                (step.get("action") or "") in supported_negative_actions
                and (
                    (step.get("action") or "") in ("navegar", "desplazar", "validar_contenido")
                    or bool(step.get("selector"))
                )
                for step in negative_steps
            )
        )
        tests.extend([("Regresión positiva", steps, 1),
                      ("Regresión negativa", negative_steps if negative_ready else None, 1)])
    if "integracion" in types:
        tests.append(("Integración de interfaz", steps, 1))
    if "carga" in types:
        tests.append(("Carga secuencial", steps, max(1, min(int(payload.get("iterations", 1)), 1000))))
    if not tests:
        tests.append(("Funcional", steps, 1))

    results = []
    exploration = {"pages": [], "interactions": [], "controls_total": 0, "routes_visited": 0}
    navigation_blocked = False
    blocked_reason = ""
    delay_ms = max(200, min(int(payload.get("stepDelayMs", 850)), 5000))
    navigation_timeout_ms = max(int(payload.get("timeoutSeconds", 10)) * 1000,
                                int(os.getenv("FLOWBDD_NAVIGATION_TIMEOUT_MS", "60000")))
    display_seconds = max(5, min(int(payload.get("displaySeconds", 25)), 120))
    work_total = sum(max(1, len(case_steps)) * repeat if case_steps is not None else 1 for _, case_steps, repeat in tests)
    work_done = 0
    case_total = len(tests) + 1
    case_number = 0

    def on_step_done(description, case_name):
        nonlocal work_done
        work_done += 1
        percent = 40 + 56 * work_done / max(work_total, 1)
        _progress(percent, "Ejecutando pruebas", f"{case_name}: {description}",
                  pages=exploration.get("routes_visited", 0), controls=exploration.get("controls_total", 0),
                  completed=work_done, total=work_total)

    def reset_test_state(page, url):
        """Start each independently reported case with a clean browser state."""
        if not url:
            return
        response = page.goto(url, wait_until="commit", timeout=navigation_timeout_ms)
        if response is not None and response.status >= 400:
            raise AssertionError(f"No se pudo preparar el estado inicial: HTTP {response.status} en {url}")
        page.context.clear_cookies()
        page.evaluate("() => { localStorage.clear(); sessionStorage.clear(); }")
        page.goto(url, wait_until="commit", timeout=navigation_timeout_ms)
        page.wait_for_timeout(delay_ms)

    emit("log", f"Iniciando suite visible para {start_url or 'la URL definida en los pasos'}.")
    emit("log", f"Recorrido extendido: hasta {min(int(payload.get('maxExplorePages', 12)), 24)} páginas, desplazamiento completo y {delay_ms} ms entre acciones.")
    emit("log", "Chrome permanecerá en una sola ventana mientras se revisan páginas y pruebas.")
    try:
        with sync_playwright() as playwright:
            launch = {"headless": False}
            browser_channel = os.getenv("FLOWBDD_BROWSER_CHANNEL", "chrome").strip()
            if browser_channel:
                launch["channel"] = browser_channel
            try:
                browser = playwright.chromium.launch(**launch)
                browser_name = "Chrome" if browser_channel else "Chromium de Playwright"
            except Exception as error:
                if browser_channel.lower() != "chrome":
                    raise
                emit("log", f"Chrome no está disponible ({error}); se abrirá Chromium de Playwright.")
                browser = playwright.chromium.launch(headless=False)
                browser_name = "Chromium de Playwright"

            context = browser.new_context(viewport={"width": 1440, "height": 900})
            page = context.new_page()
            page.set_default_navigation_timeout(navigation_timeout_ms)
            emit("log", f"Navegador abierto: {browser_name}.")
            started = time.time()
            try:
                exploration = explore_interface(page, start_url, payload, report_dir)
                page_failures = [item for item in exploration["pages"] if item["status"] == "FAIL"]
                passed_pages = exploration["routes_visited"] - len(page_failures)
                explore_status = "PASS" if not page_failures else ("PARTIAL" if passed_pages else "FAIL")
                detail = (f"{passed_pages} páginas visitadas; {exploration['controls_total']} controles revisados; "
                          f"{len(exploration['interactions'])} pestañas/menús seguros probados.")
                if page_failures and passed_pages:
                    detail += f" {len(page_failures)} ruta(s) no disponible(s)."
                if not passed_pages:
                    navigation_blocked = True
                    blocked_reason = page_failures[0].get("detail", "No se pudo cargar la página inicial")
            except InterruptedError as error:
                explore_status, detail = "SKIP", str(error)
                navigation_blocked, blocked_reason = True, str(error)
            except Exception as error:
                explore_status, detail = "FAIL", f"{type(error).__name__}: {error}"
                navigation_blocked, blocked_reason = True, detail
            duration = round(time.time() - started, 2)
            case_number += 1
            results.append({"case": "Exploración segura de interfaz", "status": explore_status,
                            "detail": detail, "duration_seconds": duration})
            emit("case", detail, case="Exploración segura de interfaz", status=explore_status,
                 case_index=case_number, case_total=case_total, duration_seconds=duration)
            _progress(40, "Iniciando tipos de prueba", f"Preparados {len(tests)} casos.",
                      pages=exploration.get("routes_visited", 0), controls=exploration.get("controls_total", 0),
                      completed=work_done, total=work_total)

            for case_name, case_steps, repeat in tests:
                started = time.time()
                skipped_steps = 0
                if navigation_blocked:
                    case_status = "BLOCKED"
                    detail = f"No ejecutada porque el acceso inicial a la página está bloqueado: {blocked_reason}"
                elif case_steps is None:
                    case_status = "SKIP"
                    detail = "Omitida: falta definir datos negativos y el resultado de error esperado."
                    work_done += 1
                else:
                    case_status, detail = "PASS", ""
                    try:
                        for iteration in range(1, repeat + 1):
                            if repeat > 1:
                                emit("log", f"{case_name}: iteración {iteration}/{repeat}.")
                            emit("log", f"{case_name}: reiniciando estado local para aislar el caso.")
                            reset_test_state(page, start_url)
                            has_navigation = any((step.get("action") or "").lower() in ("navegar", "goto") for step in case_steps)
                            if not has_navigation:
                                response = page.goto(start_url, wait_until="commit", timeout=navigation_timeout_ms)
                                if response is not None and response.status >= 400:
                                    raise AssertionError(f"La URL respondió HTTP {response.status}: {start_url}")
                                page.wait_for_timeout(delay_ms)
                            skipped_steps += execute_steps(page, case_steps, payload, case_name,
                                                           on_step_done=lambda description, name=case_name: on_step_done(description, name))
                    except InterruptedError as error:
                        case_status, detail = "SKIP", str(error)
                    except PendingStep as error:
                        case_status, detail = "SKIP", str(error)
                    except Exception as error:
                        case_status, detail = "FAIL", f"{type(error).__name__}: {error}"
                        if "Page.goto" in detail and ("net::ERR_" in detail or "Timeout" in detail):
                            navigation_blocked = True
                            blocked_reason = detail.splitlines()[0]
                        try:
                            capture = report_dir / f"fallo_{len(results) + 1}.png"
                            page.screenshot(path=str(capture), full_page=True)
                            detail += f" | Captura: {capture}"
                        except Exception:
                            pass
                    if case_status == "PASS" and skipped_steps:
                        case_status = "PARTIAL"
                        detail = f"Se omitieron {skipped_steps} pasos por falta de datos o selectores."

                duration = round(time.time() - started, 2)
                case_number += 1
                results.append({"case": case_name, "status": case_status, "detail": detail,
                                "duration_seconds": duration})
                emit("case", detail or f"{case_name}: {case_status} ({duration}s)", case=case_name,
                     status=case_status, case_index=case_number, case_total=case_total,
                     duration_seconds=duration)
                if not navigation_blocked:
                    page.wait_for_timeout(max(300, delay_ms // 2))

            emit("log", "Integración revisa la interfaz, no ejecuta SQL. Carga repite en serie, sin simular concurrencia.")
            emit("log", f"Chrome seguirá abierto {display_seconds} segundos para revisar la pantalla y el resultado.")
            _progress(99, "Suite completada", "Preparando el informe; Chrome sigue abierto.",
                      pages=exploration.get("routes_visited", 0), controls=exploration.get("controls_total", 0),
                      completed=work_done, total=work_total)
            time.sleep(display_seconds)
            context.close()
            browser.close()
    except Exception as error:
        emit("fatal", f"No se pudo ejecutar Playwright: {type(error).__name__}: {error}")
        return 2

    counts = {status: sum(1 for item in results if item["status"] == status)
              for status in ("PASS", "PARTIAL", "FAIL", "SKIP", "BLOCKED")}
    report = {"run_id": run_id, "url": start_url, "results": results, "exploration": exploration,
              "summary": counts, "step_delay_ms": delay_ms}
    report_path = report_dir / "reporte.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    rows = "".join(f"<tr><td>{html.escape(item['case'])}</td><td>{html.escape(item['status'])}</td><td>{item.get('duration_seconds', 0)}s</td><td>{html.escape(item.get('detail', ''))}</td></tr>" for item in results)
    page_rows = "".join(f"<tr><td>{html.escape(item.get('label', ''))}</td><td><a href=\"{html.escape(item.get('url', ''), quote=True)}\">{html.escape(item.get('url', ''))}</a></td><td>{html.escape(item.get('title', ''))}</td><td>{item.get('controls_visible', 0)}</td><td>{item.get('scroll', {}).get('scroll_segments', 0)}</td><td>{html.escape(item.get('status', ''))}</td></tr>" for item in exploration.get("pages", []))
    html_doc = ("<!doctype html><meta charset='utf-8'><title>FlowBDD QA</title>"
                "<style>body{font:14px Arial;margin:24px}table{border-collapse:collapse;width:100%;margin:12px 0 28px}th,td{border:1px solid #ccc;padding:8px;text-align:left}th{background:#eef1e8}</style>"
                f"<h1>Reporte de ejecución</h1><p>URL: {html.escape(start_url)} · Pausa: {delay_ms} ms</p>"
                f"<p>Páginas: {exploration.get('routes_visited', 0)} · Controles: {exploration.get('controls_total', 0)} · Interacciones seguras: {len(exploration.get('interactions', []))}</p>"
                f"<h2>Casos QA</h2><table><tr><th>Prueba</th><th>Estado</th><th>Duración</th><th>Detalle</th></tr>{rows}</table>"
                f"<h2>Recorrido del sitio</h2><table><tr><th>Sección</th><th>URL</th><th>Página</th><th>Controles</th><th>Zonas</th><th>Estado</th></tr>{page_rows}</table>")
    (report_dir / "reporte.html").write_text(html_doc, encoding="utf-8")
    _progress(100, "Finalizada", "Suite completa; revisa el resumen y el reporte.",
              pages=exploration.get("routes_visited", 0), controls=exploration.get("controls_total", 0),
              completed=len(results), total=case_total)
    emit("done", f"Suite terminada. Reporte: {report_dir / 'reporte.html'}", results=results,
         report_path=str(report_dir / 'reporte.html'), summary=counts,
         pages=exploration.get("routes_visited", 0), controls=exploration.get("controls_total", 0))
    return int(any(item["status"] == "FAIL" for item in results))

if __name__ == "__main__":
    raise SystemExit(main())
