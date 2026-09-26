#!/usr/bin/env python3
"""Local CDP Host-header adapter for Chromium's DNS-rebinding check."""
import socket
import socketserver
import os
import threading

EXPECTED_HOST = os.environ.get("ABP_CDP_HOST", "").encode()

class Handler(socketserver.BaseRequestHandler):
    def handle(self):
        client = self.request
        client.settimeout(10)
        header = b''
        while b'\r\n\r\n' not in header and len(header) < 65536:
            part = client.recv(4096)
            if not part:
                return
            header += part
        if b'\r\n\r\n' not in header:
            return
        head, rest = header.split(b'\r\n\r\n', 1)
        lines = head.split(b'\r\n')
        # Only the Runtime addresses this browser as ABP_CDP_HOST; anything else
        # (another container name, an IP, a rebinding hostname) is refused.
        hosts = [line.split(b':', 1)[1].strip() for line in lines if line.lower().startswith(b'host:')]
        if EXPECTED_HOST and hosts != [EXPECTED_HOST]:
            client.sendall(b'HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
            return
        original_host = b'browser-a:9223'
        for i, line in enumerate(lines):
            if line.lower().startswith(b'host:'):
                original_host = line.split(b':', 1)[1].strip()
                lines[i] = b'Host: localhost:9222'
        with socket.create_connection(('127.0.0.1', 9222), timeout=10) as upstream:
            upstream.sendall(b'\r\n'.join(lines) + b'\r\n\r\n' + rest)
            response = b''
            while b'\r\n\r\n' not in response and len(response) < 65536:
                part = upstream.recv(4096)
                if not part:
                    return
                response += part
            if b'\r\n\r\n' not in response:
                return
            rh, rb = response.split(b'\r\n\r\n', 1)
            # Chromium answers "101 WebSocket Protocol Handshake", so match the status code, not the reason phrase.
            if rh.split(b'\r\n', 1)[0].split(b' ')[1:2] == [b'101']:
                # The handshake timeout must not apply to the long-lived CDP
                # websocket: an idle driver connection would otherwise drop.
                client.settimeout(None)
                upstream.settimeout(None)
                client.sendall(response)
                def pipe(src, dst):
                    try:
                        while data := src.recv(65536):
                            dst.sendall(data)
                    except OSError:
                        pass
                    try: dst.shutdown(socket.SHUT_WR)
                    except OSError: pass
                t = threading.Thread(target=pipe, args=(client, upstream), daemon=True)
                t.start()
                pipe(upstream, client)
                t.join(timeout=1)
                return
            length = None
            for line in rh.split(b'\r\n'):
                if line.lower().startswith(b'content-length:'):
                    length = int(line.split(b':', 1)[1].strip())
            if length is not None:
                while len(rb) < length:
                    chunk = upstream.recv(65536)
                    if not chunk: break
                    rb += chunk
                rb = rb[:length].replace(b'localhost:9222', original_host)
                rh = b'\r\n'.join(b'Content-Length: ' + str(len(rb)).encode() if line.lower().startswith(b'content-length:') else line for line in rh.split(b'\r\n'))
                client.sendall(rh + b'\r\n\r\n' + rb)
            else:
                client.sendall(response)
                while data := upstream.recv(65536): client.sendall(data)

class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
Server(('127.0.0.1', 9225), Handler).serve_forever()
