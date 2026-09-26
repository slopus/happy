#!/usr/bin/env python3
from http.server import BaseHTTPRequestHandler, HTTPServer
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != '/instance':
            self.send_error(404)
            return
        try:
            with open('/run/abp/instance.json', 'rb') as f:
                data = f.read()
        except FileNotFoundError:
            self.send_error(503)
            return
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)
    def log_message(self, *args):
        pass
HTTPServer(('0.0.0.0', 9224), Handler).serve_forever()
