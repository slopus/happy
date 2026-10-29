"""fakellm.py PORT [WORK]: the perf gym's fake model, an OpenAI-compatible endpoint for
its throwaway daemon (`gym.py up` starts it; WORK only names whose it is).

The person's last message picks the reply:
  "stream P W"  -> P markdown sections (paragraph, list, table, code), W ms a word
anything else -> one short line at once (titles and other internal asks).
"""
import json, re, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 24823

PARA = ("The reply streams one word at a time so the transcript grows under the reader "
        "while they scroll, fling and drag through a long history full of tables, lists and code.")


def section(i):
    return (
        f"### Part {i + 1}\n\n{PARA}\n\n"
        f"- first point of part {i + 1} with `inline code`\n- second point, **bold** and *italic*\n\n"
        f"| Column | Value | Note |\n| --- | --- | --- |\n| a{i} | {i * 3} | streamed |\n| b{i} | {i * 7} | table row |\n\n"
        f"```swift\nlet part = {i}\nprint(\"streaming part \\(part)\")\n```\n\n"
    )


def last_user_text(body):
    for message in reversed(body.get("messages") or []):
        if message.get("role") != "user":
            continue
        content = message.get("content")
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            return " ".join(p.get("text", "") for p in content if isinstance(p, dict))
    return ""


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def do_GET(self):
        body = json.dumps({"object": "list", "data": [{"id": "fake-stream", "object": "model"}]}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def chunk(self, delta, finish=None):
        payload = {"id": "fake", "object": "chat.completion.chunk", "created": int(time.time()), "model": "fake-stream",
                   "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
        data = f"data: {json.dumps(payload)}\n\n".encode()
        self.wfile.write(f"{len(data):x}\r\n".encode() + data + b"\r\n")
        self.wfile.flush()

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}")
        text = last_user_text(body)
        m = re.search(r"stream (\d+) (\d+)", text)
        if m:
            reply, delay = "".join(section(i) for i in range(int(m.group(1)))), int(m.group(2)) / 1000
        else:
            reply, delay = "Gym reply.", 0
        if not body.get("stream"):
            out = json.dumps({"id": "fake", "object": "chat.completion", "model": "fake-stream",
                              "choices": [{"index": 0, "message": {"role": "assistant", "content": reply}, "finish_reason": "stop"}],
                              "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(out)))
            self.end_headers()
            self.wfile.write(out)
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()
        try:
            self.chunk({"role": "assistant", "content": ""})
            for word in re.findall(r"\S+\s*", reply):
                self.chunk({"content": word})
                if delay:
                    time.sleep(delay)
            self.chunk({}, "stop")
            data = b"data: [DONE]\n\n"
            self.wfile.write(f"{len(data):x}\r\n".encode() + data + b"\r\n0\r\n\r\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass


ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
