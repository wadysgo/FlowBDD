"""Static HTML analyzer for FlowBDD Vercel deployment."""
import base64
import html
import ipaddress
import json
import re
import socket
from html.parser import HTMLParser
from http.server import BaseHTTPRequestHandler
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

MAX_BODY, MAX_HTML, MAX_ELEMENTS = 16000, 2000000, 300

def _public_url(value):
    parsed = urlsplit(value)
    if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("Usa una URL http(s) pública, sin credenciales incrustadas.")
    host = parsed.hostname.rstrip(".")
    if host.lower() == "localhost" or host.lower().endswith(".localhost"):
        raise ValueError("El análisis remoto no puede acceder a localhost ni a redes privadas.")
    try:
        addresses = [ipaddress.ip_address(host)]
    except ValueError:
        addresses = [ipaddress.ip_address(item[4][0]) for item in socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)]
    if not addresses or any(not address.is_global for address in addresses):
        raise ValueError("El análisis remoto solo admite destinos públicos.")
    return parsed

class _Redirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        target = urljoin(req.full_url, newurl)
        _public_url(target)
        return super().redirect_request(req, fp, code, msg, headers, target)

class _Page(HTMLParser):
    TRACKED = {"a", "button", "input", "textarea", "select", "label"}
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.elements, self.title, self.current, self.parts = [], "", None, []
        self.in_title, self.password_form = False, False
    def handle_starttag(self, tag, attrs):
        attrs = {key.lower(): value or "" for key, value in attrs}
        if tag == "title": self.in_title = True
        if tag == "input" and attrs.get("type", "").lower() == "password": self.password_form = True
        if tag in self.TRACKED and len(self.elements) < MAX_ELEMENTS:
            self.current, self.parts = (tag, attrs), []
            if tag in {"input", "textarea", "select"}: self._finish()
    def handle_endtag(self, tag):
        if tag == "title": self.in_title = False
        if self.current and tag == self.current[0]: self._finish()
    def handle_data(self, data):
        if self.in_title: self.title += data
        if self.current: self.parts.append(data)
    def _finish(self):
        if not self.current: return
        tag, attrs = self.current
        self.current = None
        text = re.sub(r"\s+", " ", " ".join(self.parts)).strip()[:160]
        label = text or attrs.get("aria-label") or attrs.get("placeholder") or attrs.get("value") or ""
        element_id, name = attrs.get("id", ""), attrs.get("name", "")
        xpath, css = "", tag
        if element_id:
            xpath = "//{}[@id='{}']".format(tag, element_id.replace("'", "&apos;"))
            escaped = re.sub(r"([^a-zA-Z0-9_-])", lambda m: "\\" + m.group(1), element_id)
            css = "{}#{}".format(tag, escaped)
        elif name:
            xpath = "//{}[@name='{}']".format(tag, name.replace("'", "&apos;"))
            css = '{}[name="{}"]'.format(tag, name)
        elif label and tag in {"a", "button", "label"}:
            xpath = "//{}[normalize-space(.)='{}']".format(tag, label.replace("'", "&apos;"))
        if label or element_id or name or attrs.get("type"):
            self.elements.append({"tag":tag,"text":label,"id":element_id,"name":name,"type":attrs.get("type",""),"aria":attrs.get("aria-label",""),"placeholder":attrs.get("placeholder",""),"href":attrs.get("href",""),"disabled":"disabled" in attrs,"visible":True,"xpath":xpath,"css":css})

class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        try:
            length = int(self.headers.get("content-length", "0"))
            if length <= 0 or length > MAX_BODY: return self._send(413, {"error":"La solicitud supera el tamaño permitido."})
            payload = json.loads(self.rfile.read(length).decode("utf-8", errors="replace"))
            url = payload.get("url")
            if not isinstance(url, str): raise ValueError("URL no válida.")
            _public_url(url)
            headers = {"User-Agent":"FlowBDD-Vercel-HTML-analyzer/1.0"}
            credentials = payload.get("credentials") or {}
            if credentials.get("username") and credentials.get("password"):
                token = base64.b64encode((credentials["username"] + ":" + credentials["password"]).encode()).decode("ascii")
                headers["Authorization"] = "Basic " + token
            response = build_opener(_Redirect()).open(Request(url, headers=headers), timeout=12)
            final_url = response.geturl()
            _public_url(final_url)
            markup = response.read(MAX_HTML + 1)[:MAX_HTML].decode(response.headers.get_content_charset() or "utf-8", errors="replace")
            page = _Page(); page.feed(markup)
            return self._send(200, {"url":final_url,"status":response.status,"title":html.unescape(page.title).strip(),"auth_required":response.status in (401,403) or page.password_form,"elements":page.elements,"manual_review":True,"analysis_method":"html_fallback","warning":"Vercel analizó solo el HTML inicial; no ejecutó JavaScript ni OCR. Validá selectores de contenido dinámico manualmente.","ocr_available":False,"ocr_warning":"Tesseract no está disponible en la versión alojada en Vercel."})
        except HTTPError as error:
            return self._send(200, {"url":locals().get("url",""),"status":error.code,"title":"","auth_required":error.code in (401,403),"elements":[],"manual_review":True,"analysis_method":"html_fallback","warning":"El sitio respondió con un error HTTP; revisá acceso o autenticación."})
        except (ValueError, json.JSONDecodeError, URLError, TimeoutError, OSError) as error:
            return self._send(400, {"error":str(error) or "No se pudo analizar la página."})
    def do_OPTIONS(self):
        self.send_response(204); self.send_header("Allow","POST, OPTIONS"); self.end_headers()
    def _send(self, status, payload):
        body = json.dumps(payload, ensure_ascii=True).encode("utf-8")
        self.send_response(status); self.send_header("Content-Type","application/json; charset=utf-8"); self.send_header("Cache-Control","no-store"); self.send_header("Content-Length",str(len(body))); self.end_headers(); self.wfile.write(body)
