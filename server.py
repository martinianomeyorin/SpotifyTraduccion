"""Servidor local para Verso, con fallback de la ruta OAuth /callback."""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import os


ROOT = Path(__file__).resolve().parent
os.chdir(ROOT)


class VersoHandler(SimpleHTTPRequestHandler):
    def do_GET(self):
        # Spotify redirects to /callback?code=...; serve the app so it can
        # exchange the authorization code in the browser.
        if self.path.split("?", 1)[0].rstrip("/") == "/callback":
            self.path = "/index.html" + ("?" + self.path.split("?", 1)[1] if "?" in self.path else "")
        super().do_GET()


if __name__ == "__main__":
    address = ("127.0.0.1", 8888)
    print(f"Verso listo en http://{address[0]}:{address[1]}")
    print("Dejá esta ventana abierta mientras usás la app. Ctrl+C para cerrar.")
    ThreadingHTTPServer(address, VersoHandler).serve_forever()
