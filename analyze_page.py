"""Inspect a URL for FlowBDD without executing any test actions."""
import json
import re
import sys
import csv
import io
import shutil
import subprocess
import tempfile
from urllib.parse import urlparse


def fail(message):
    print(json.dumps({"error": message}, ensure_ascii=False))
    raise SystemExit(0)


try:
    from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError
except ModuleNotFoundError as exc:
    fail("Playwright no está disponible en el intérprete activo. Instala con: python -m pip install playwright; python -m playwright install chromium")

request = json.load(sys.stdin)
url = str(request.get("url", "")).strip()
parsed = urlparse(url)
if parsed.scheme not in ("http", "https") or not parsed.netloc:
    fail("La URL debe comenzar con http:// o https://")


def recognize_screen_text(page):
    """Optional Tesseract CLI fallback; OCR coordinates are suggestions for manual review."""
    executable = shutil.which("tesseract")
    if not executable:
        return [], False, "Tesseract no está instalado o no está disponible en PATH."
    try:
        with tempfile.TemporaryDirectory(prefix="flowbdd-ocr-") as folder:
            image_path = f"{folder}/viewport.png"
            page.screenshot(path=image_path, full_page=False, timeout=15000)
            command = [executable, image_path, "stdout", "-l", "spa+eng", "tsv"]
            result = subprocess.run(command, capture_output=True, text=True, timeout=20, check=False)
            if result.returncode != 0:
                result = subprocess.run([executable, image_path, "stdout", "-l", "eng", "tsv"], capture_output=True, text=True, timeout=20, check=False)
            if result.returncode != 0:
                return [], False, "Tesseract está instalado, pero no pudo reconocer esta página."
            recognized = []
            for row in csv.DictReader(io.StringIO(result.stdout), delimiter="\t"):
                text = " ".join((row.get("text") or "").split())
                try:
                    confidence = float(row.get("conf") or -1)
                except ValueError:
                    confidence = -1
                if text and confidence >= 35:
                    recognized.append({"text": text[:160], "x": int(row["left"]), "y": int(row["top"]), "width": int(row["width"]), "height": int(row["height"]), "confidence": round(confidence, 1)})
            return recognized[:150], True, ""
    except (OSError, subprocess.TimeoutExpired, ValueError) as error:
        return [], False, f"No se pudo ejecutar Tesseract: {type(error).__name__}."


def xpath_literal(value):
    if "'" not in value:
        return "'" + value + "'"
    if '"' not in value:
        return '"' + value + '"'
    return "concat(" + ", \"'\", ".join("'" + part + "'" for part in value.split("'")) + ")"


try:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        response = page.goto(url, wait_until="domcontentloaded", timeout=25000)
        page.wait_for_timeout(500)
        credentials = request.get("credentials") or {}
        auth_required = bool(response and response.status in (401, 403))
        if credentials.get("username") and credentials.get("password"):
            user = page.locator("input[type='email'], input[autocomplete='username'], input[name*='user' i], input[name*='email' i]").first
            password = page.locator("input[type='password']").first
            if user.count() and password.count():
                user.fill(credentials["username"])
                password.fill(credentials["password"])
                submit = page.locator("button[type='submit'], input[type='submit']").first
                if submit.count():
                    submit.click()
                    try:
                        page.wait_for_load_state("domcontentloaded", timeout=10000)
                    except PlaywrightTimeoutError:
                        pass
                    page.wait_for_timeout(1200)
                else:
                    auth_required = True

        elements = page.locator("a,button,input,textarea,select,[role='button'],[role='link'],label").evaluate_all("els => els.slice(0, 300).map(el => ({tag: el.tagName.toLowerCase(), text: (el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim().replace(/\\s+/g,' ').slice(0,160), id: el.id || '', name: el.getAttribute('name') || '', test_id: el.getAttribute('data-testid') || el.getAttribute('data-test') || '', type: el.getAttribute('type') || '', role: el.getAttribute('role') || '', aria: el.getAttribute('aria-label') || '', placeholder: el.getAttribute('placeholder') || '', href: el.getAttribute('href') || '', disabled: !!el.disabled, visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length)}))")
        described = []
        for item in elements:
            if not item["visible"]:
                continue
            tag, element_id, name, text = item["tag"], item["id"], item["name"], item["text"] or item["aria"] or item["placeholder"]
            test_id = item["test_id"]
            if element_id:
                xpath = "//" + tag + "[@id=" + xpath_literal(element_id) + "]"
                css = tag + "#" + re.sub(r"([^a-zA-Z0-9_-])", r"\\\1", element_id)
            elif test_id:
                xpath = "//" + tag + "[@data-testid=" + xpath_literal(test_id) + " or @data-test=" + xpath_literal(test_id) + "]"
                css = tag + "[data-testid=" + json.dumps(test_id, ensure_ascii=False) + "], " + tag + "[data-test=" + json.dumps(test_id, ensure_ascii=False) + "]"
            elif name:
                xpath = "//" + tag + "[@name=" + xpath_literal(name) + "]"
                css = tag + "[name=" + json.dumps(name, ensure_ascii=False) + "]"
            elif text and tag in ("button", "a", "label"):
                xpath = "//" + tag + "[normalize-space(.)=" + xpath_literal(text) + "]"
                css = tag
            else:
                xpath = ""
                css = tag
            described.append({**item, "xpath": xpath, "css": css})
        login_form = page.locator("input[type='password']").count() > 0
        ocr_elements, ocr_available, ocr_warning = recognize_screen_text(page) if request.get("useOcr") else ([], False, "")
        output = {
            "url": page.url,
            "status": response.status if response else None,
            "title": page.title(),
            "auth_required": auth_required or login_form,
            "elements": described,
            "manual_review": not bool(described),
            "ocr_available": ocr_available,
            "ocr_elements": ocr_elements,
            "ocr_warning": ocr_warning,
        }
        browser.close()
        print(json.dumps(output, ensure_ascii=False))
except Exception as exc:
    fail(f"No se pudo inspeccionar la página: {type(exc).__name__}: {exc}")
