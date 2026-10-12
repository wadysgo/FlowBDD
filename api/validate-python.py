"""Python syntax validation endpoint for FlowBDD Vercel."""

import ast
import json
from http.server import BaseHTTPRequestHandler

MAX_SOURCE_CHARS = 180_000

class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        try:
            length = int(self.headers.get("content-length", "0"))
            if length <= 0 or length > 200_000:
                return self._send(413, {"valid": False, "error": "El código supera el tamaño permitido."})
            payload = json.loads(self.rfile.read(length).decode("utf-8", errors="replace"))
            source = payload.get("source")
            if not isinstance(source, str) or len(source) > MAX_SOURCE_CHARS:
                return self._send(400, {"valid": False, "error": "Código Python no válido."})
            source = source.encode("utf-8", errors="replace").decode("utf-8")
            try:
                ast.parse(source, filename="test_flowbdd.py")
            except SyntaxError as error:
                return self._send(422, {"valid": False, "error": f"SyntaxError en línea {error.lineno}, columna {error.offset}: {error.msg}"})
            return self._send(200, {"valid": True})
        except (UnicodeError, json.JSONDecodeError, ValueError):
            return self._send(400, {"valid": False, "error": "Solicitud JSON no válida."})

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Allow", "POST, OPTIONS")
        self.end_headers()

    def _send(self, status, payload):
        body = json.dumps(payload, ensure_ascii=True).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
