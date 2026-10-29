#!/usr/bin/env python3
"""The iOS performance gym (docs/PERF-GYM.md): long Stem Cells conversations on a
throwaway Happy Agent, the app on a simulator against it, scripted scroll workloads
measured by the app's own frame meter, and budgets that fail a regression.

  gym.py synth                  synthetic long chats (no real content) as fixtures
  gym.py export AGENT_ID...     READ-ONLY copy of chats from this Mac's own Happy Agent
  gym.py up [--fixtures DIR]    throwaway daemon in the work folder, fixtures loaded
  gym.py build [--dd NAME]      the gym's build of the app and its UI tests
  gym.py run [WORKLOAD...]      workloads on the simulator; results checked against budgets
  gym.py check RESULTS.json     results against budgets.json
  gym.py compare A.json B.json  two runs side by side
  gym.py down                   stops the throwaway daemon and the fake model

Everything lives in the work folder (GYM_WORK, default <repo>/.context/gym), never in
~/.happy: the daemon's home, its configuration, fixtures, derived data and results.
`export` only ever sends GET requests to the person's own daemon; what it copies stays in
the work folder, which is gitignored, and must never be committed or sent anywhere.
"""
import argparse, base64, filecmp, hashlib, http.client, json, os, random, re, shutil, signal, socket, sqlite3, struct
import subprocess, sys, threading, time, urllib.parse, zlib

HERE = os.path.dirname(os.path.abspath(__file__))
IOS = os.path.dirname(os.path.dirname(HERE))
ROOT = os.path.dirname(os.path.dirname(IOS))
WORK = os.path.abspath(os.environ.get("GYM_WORK") or os.path.join(ROOT, ".context", "gym"))
HOME = os.path.join(WORK, "h")
DAEMON = os.path.join(WORK, "d")
SOCK = os.path.join(HOME, "agent", "server.sock")
MAP = os.path.join(WORK, "map.json")
CONNECTOR_PORT = int(os.environ.get("GYM_CONNECTOR_PORT", "24821"))
FAKE_PORT = int(os.environ.get("GYM_FAKE_PORT", "24823"))
SIMULATOR = os.environ.get("GYM_SIMULATOR", "Happy Perf Gym")
BUNDLE = "com.slopus.happy.dev"
FAKE_MODE = {"providerId": "fake", "modelId": "fake-stream", "effort": "low", "serviceTier": None, "permissionMode": "auto"}

# The synthetic chats, by title: the long one, and the one heavy with pictures.
SYNTHETIC = {"long": "Gym Long Chat", "images": "Gym Pictures"}

# Each workload: its UI test, and the chat it needs forgotten on the phone first.
WORKLOADS = {
    "open-cold": ("testOpenCold", None),
    "open-warm": ("testOpenWarm", None),
    "fling-to-top": ("testFlingToTop", None),
    "fling-to-bottom": ("testFlingToBottom", None),
    "slow-drag": ("testSlowDrag", None),
    "image-heavy": ("testImageHeavy", None),
    "scroll-while-streaming": ("testScrollWhileStreaming", None),
    "sidebar": ("testSidebar", None),
    # Last: it leaves the long chat only partly on the phone.
    "history-paging": ("testHistoryPaging", "paging"),
}


def say(*parts):
    print("gym:", *parts, flush=True)


# MARK: Synthetic fixtures

WORDS = ("layout frame row view text table list code image scroll page history reply message window "
         "screen cache plan measure draw render apply update stream token budget metric thread queue "
         "decode bitmap column header cell width height offset inset margin gesture fling drag frame "
         "the a of to and in for with on as is it that this from by at an be are was").split()
NAMES = "planner meter layout stack window loader cache pager stream reader".split()


class Ids:
    def __init__(self, rng):
        self.rng = rng

    def __call__(self):
        # A cuid2: the daemon refuses ids that don't start with a letter.
        return self.rng.choice("abcdefghijklmnopqrstuvwxyz") + "".join(self.rng.choice("abcdefghijklmnopqrstuvwxyz0123456789") for _ in range(23))


def sentence(rng, n=None):
    words = [rng.choice(WORDS) for _ in range(n or rng.randint(8, 22))]
    return words[0].capitalize() + " " + " ".join(words[1:]) + "."


def paragraph(rng):
    return " ".join(sentence(rng) for _ in range(rng.randint(2, 6)))


def markdown(rng):
    """An answer of a few blocks, now and then a report of dozens."""
    parts = []
    for _ in range(rng.randint(30, 60) if rng.random() < 0.05 else rng.randint(3, 12)):
        kind = rng.choice(["p", "p", "list", "numbers", "table", "code", "heading"])
        if kind == "p":
            parts.append(paragraph(rng))
        elif kind == "heading":
            parts.append("### " + sentence(rng, 4)[:-1])
        elif kind == "list":
            parts.append("\n".join(f"- {sentence(rng)} `{rng.choice(NAMES)}`" for _ in range(rng.randint(2, 7))))
        elif kind == "numbers":
            parts.append("\n".join(f"{i + 1}. **{rng.choice(NAMES)}**: {sentence(rng)}" for i in range(rng.randint(2, 6))))
        elif kind == "table":
            columns = rng.randint(2, 5)
            rows = [" | ".join(rng.choice(NAMES).capitalize() for _ in range(columns)), " | ".join("---" for _ in range(columns))]
            for _ in range(rng.randint(2, 9)):
                rows.append(" | ".join(rng.choice([str(rng.randint(0, 9999)), rng.choice(WORDS), sentence(rng, 3)[:-1]]) for _ in range(columns)))
            parts.append("\n".join(f"| {row} |" for row in rows))
        else:
            lines = []
            for i in range(rng.randint(4, 28)):
                name = rng.choice(NAMES)
                lines.append(rng.choice([
                    f"let {name}{i} = {rng.choice(NAMES)}.{rng.choice(WORDS)}({rng.randint(0, 99)})",
                    f"    if {name}.isEmpty {{ return {rng.randint(0, 9)} }}",
                    f"func {name}{i}(_ value: Int) -> CGFloat {{",
                    f"    // {sentence(rng, 6)}",
                    "}",
                ]))
            parts.append("```swift\n" + "\n".join(lines) + "\n```")
    return "\n\n".join(parts)


def png(width, height, rng):
    """An opaque picture of coloured bands and blocks, as screenshots compress, and its
    ThumbHash (the daemon stores one with every presented image)."""
    rows = []
    band = None
    for y in range(height):
        if band is None or y % rng.randint(40, 400) == 0:
            colour = bytes(rng.randint(0, 255) for _ in range(3))
            block = bytes(rng.randint(0, 255) for _ in range(3))
            start = rng.randint(0, width // 2)
            band = b"\x00" + colour * start + block * (width // 3) + colour * (width - start - width // 3)
        rows.append(band)
    raw = b"".join(rows)

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    data = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b"")
    scale = max(width, height) / 32
    w, h = max(1, round(width / scale)), max(1, round(height / scale))
    pixels = [rows[int((y + 0.5) * height / h)][1 + 3 * int((x + 0.5) * width / w):][:3] for y in range(h) for x in range(w)]
    return data, thumbhash(w, h, pixels)


def thumbhash(w, h, pixels):
    """ThumbHash's encoder (github.com/evanw/thumbhash) for opaque RGB pixels, base64."""
    from math import cos, pi
    count = w * h
    r = [p[0] / 255 for p in pixels]
    g = [p[1] / 255 for p in pixels]
    b = [p[2] / 255 for p in pixels]
    l = [(r[i] + g[i] + b[i]) / 3 for i in range(count)]
    p = [(r[i] + g[i]) / 2 - b[i] for i in range(count)]
    q = [r[i] - g[i] for i in range(count)]
    lx = max(1, round(7 * w / max(w, h)))
    ly = max(1, round(7 * h / max(w, h)))

    def encode(channel, nx, ny):
        dc, ac, scale = 0.0, [], 0.0
        for cy in range(ny):
            cx = 0
            while cx * ny < nx * (ny - cy):
                fx = [cos(pi / w * cx * (x + 0.5)) for x in range(w)]
                f = 0.0
                for y in range(h):
                    fy = cos(pi / h * cy * (y + 0.5))
                    for x in range(w):
                        f += channel[x + y * w] * fx[x] * fy
                f /= count
                if cx or cy:
                    ac.append(f)
                    scale = max(scale, abs(f))
                else:
                    dc = f
                cx += 1
        if scale:
            ac = [0.5 + 0.5 / scale * f for f in ac]
        return dc, ac, scale

    l_dc, l_ac, l_scale = encode(l, max(3, lx), max(3, ly))
    p_dc, p_ac, p_scale = encode(p, 3, 3)
    q_dc, q_ac, q_scale = encode(q, 3, 3)
    landscape = w > h
    header24 = round(63 * l_dc) | (round(31.5 + 31.5 * p_dc) << 6) | (round(31.5 + 31.5 * q_dc) << 12) | (round(31 * l_scale) << 18)
    header16 = (ly if landscape else lx) | (round(63 * p_scale) << 3) | (round(63 * q_scale) << 9) | (int(landscape) << 15)
    out = [header24 & 255, (header24 >> 8) & 255, header24 >> 16, header16 & 255, header16 >> 8]
    index = 0
    for f in l_ac + p_ac + q_ac:
        if 5 + (index >> 1) >= len(out):
            out.append(0)
        out[5 + (index >> 1)] |= round(15 * f) << ((index & 1) << 2)
        index += 1
    return base64.b64encode(bytes(out)).decode()


def synthetic_chat(out, title, runs, seed, pictures=0.0, sent=0.0):
    """`runs` turns: the person asks, the agent thinks, works with tools nobody sees,
    and answers in Markdown; `pictures` of the turns present screenshots, `sent` of the
    person's messages carry a photo."""
    rng = random.Random(seed)
    ids = Ids(rng)
    os.makedirs(os.path.join(out, "media"), exist_ok=True)
    at = 1_760_000_000_000
    history = []
    media = 0
    for _ in range(runs):
        at += rng.randint(60_000, 3_600_000)
        run = {"id": ids(), "status": "completed", "reason": None, "startedAt": at, "messages": []}
        content = [{"type": "text", "text": " ".join(sentence(rng) for _ in range(rng.randint(1, 4)))}]
        if rng.random() < sent:
            data, _ = png(rng.choice([1179, 1206]), rng.choice([2556, 2622]), rng)
            content.append({"type": "image", "data": base64.b64encode(data).decode(), "mimeType": "image/png"})
        run["messages"].append({"id": ids(), "role": "user", "createdAt": at, "content": content, "metadata": {}, "status": "completed", "delivery": "queue", "profile": None, "mode": FAKE_MODE})
        blocks = [{"type": "reasoning", "text": paragraph(rng)}]
        for _ in range(rng.randint(0, 4)):
            blocks.append({"type": "tool_call", "id": ids(), "name": "Read", "status": "completed",
                           "arguments": {"file_path": f"/tmp/gym/{rng.choice(NAMES)}.swift"}, "result": {"output": paragraph(rng)}})
        if rng.random() < pictures:
            call = ids()
            items = []
            for i in range(rng.choice([1, 1, 2, 2, 3, 4])):
                width, height = rng.choice([(1206, 2622), (1206, 2622), (1600, 1000), (900, 900)])
                data, hash_ = png(width, height, rng)
                open(os.path.join(out, "media", f"{call}-{i}"), "wb").write(data)
                name = f"gym-{call[:6]}-{i}.png"
                items.append({"kind": "image", "name": name, "size": len(data), "mimeType": "image/png", "width": width, "height": height, "thumbhash": hash_,
                              "source": {"path": name, "absolutePath": f"/tmp/gym/{name}"}})
                media += 1
            presentation = {"type": "media", "items": items}
            if len(items) > 1:
                presentation["layout"] = {"type": "columns", "columns": 2}
            blocks.append({"type": "tool_call", "id": call, "name": "present_files", "status": "completed", "arguments": {"filepaths": [i["source"]["absolutePath"] for i in items]},
                           "result": {"output": "Presented."}, "presentation": presentation})
        blocks.append({"type": "text", "text": markdown(rng)})
        at += rng.randint(5_000, 600_000)
        run["messages"].append({"id": ids(), "role": "agent", "createdAt": at, "content": blocks, "metadata": {"providerId": "fake", "modelId": "fake-stream"}})
        run["endedAt"] = at
        history.append(run)
    json.dump({"runs": history}, open(os.path.join(out, "history.json"), "w"))
    json.dump({"title": title, "runs": runs, "media": media, "synthetic": True}, open(os.path.join(out, "stats.json"), "w"))
    say(f"{title}: {runs} runs, {media} pictures, {os.path.getsize(os.path.join(out, 'history.json')) // 1024} KB of history")


def cmd_synth(args):
    out = args.out or os.path.join(WORK, "fixtures", "synthetic")
    shutil.rmtree(out, ignore_errors=True)
    synthetic_chat(os.path.join(out, "long"), SYNTHETIC["long"], 270, 1, pictures=0.12, sent=0.05)
    synthetic_chat(os.path.join(out, "images"), SYNTHETIC["images"], 90, 2, pictures=0.8)


# MARK: Read-only export from this Mac's own daemon

class UnixHTTP(http.client.HTTPConnection):
    def __init__(self, path):
        super().__init__("h", timeout=120)
        self.path = path

    def connect(self):
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(120)
        sock.connect(self.path)
        self.sock = sock


def request(sock, token, method, path, body=None, raw=False):
    connection = UnixHTTP(sock)
    headers = {"Authorization": f"Bearer {token}"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    connection.request(method, path, body=json.dumps(body) if body is not None else None, headers=headers)
    response = connection.getresponse()
    data = response.read()
    connection.close()
    if response.status >= 300:
        raise RuntimeError(f"{method} {path} -> {response.status}")
    return data if raw else json.loads(data or b"{}")


def q(text):
    return urllib.parse.quote(text, safe="")


def cmd_export(args):
    live = os.path.expanduser("~/.happy/agent")
    token = open(os.path.join(live, "token")).read().strip()
    sock = os.path.join(live, "h.sock") if os.path.exists(os.path.join(live, "h.sock")) else os.path.join(live, "server.sock")

    def get(path, raw=False):
        # Only GET, ever: nothing on the person's own computer changes.
        return request(sock, token, "GET", path, raw=raw)

    out = args.out or os.path.join(WORK, "fixtures", "live")
    for agent in args.agents:
        folder = os.path.join(out, agent)
        os.makedirs(os.path.join(folder, "media"), exist_ok=True)
        boot = get(f"/v0/agents/{q(agent)}/bootstrap")
        pages = [get(f"/v0/agents/{q(agent)}/messages?limit=50&omitToolData=true")]
        while pages[-1].get("hasMore") and pages[-1].get("runs"):
            pages.append(get(f"/v0/agents/{q(agent)}/messages?limit=50&omitToolData=true&before={q(pages[-1]['runs'][0]['id'])}"))
        runs = [run for page in reversed(pages) for run in page.get("runs") or []]
        json.dump({"runs": runs}, open(os.path.join(folder, "history.json"), "w"))
        media = 0
        for run in runs:
            for message in run.get("messages") or []:
                for block in message.get("content") or []:
                    presentation = block.get("presentation") or {}
                    if block.get("type") != "tool_call" or presentation.get("type") != "media":
                        continue
                    for index, _ in enumerate(presentation.get("items") or []):
                        path = os.path.join(folder, "media", f"{block['id']}-{index}")
                        if os.path.exists(path):
                            continue
                        try:
                            open(path, "wb").write(get(f"/v0/agents/{q(agent)}/tool-calls/{q(block['id'])}/media/{index}", raw=True))
                            media += 1
                        except RuntimeError:
                            pass
        title = (boot.get("agent") or {}).get("title") or agent
        json.dump({"title": title, "runs": len(runs), "media": media}, open(os.path.join(folder, "stats.json"), "w"))
        say(f"{agent}: {len(runs)} runs, {media} pictures, {os.path.getsize(os.path.join(folder, 'history.json')) // 1024} KB")


# MARK: The throwaway daemon

def token():
    return open(os.path.join(HOME, "agent", "token")).read().strip()


def api(method, path, body=None):
    return request(SOCK, token(), method, path, body)


def healthy():
    try:
        return api("GET", "/v0/health").get("ready") is True
    except Exception:
        return False


# The daemon the baselines were measured on. A fixed one, so a run compares the
# app and not the daemon; from 0.4.110-preview.9 the mobile connector sends a
# 100-run history page whole.
AGENT_VERSION = "0.4.110-preview.11"
# The gym's own copy: Happy Agent's updater prunes old versions from ~/.happy/dist.
AGENTS = os.path.join(os.path.dirname(WORK), "gym-agents")


def agent_binary(args):
    if getattr(args, "agent", None):
        return args.agent
    if os.environ.get("HAPPY_AGENT_BIN"):
        return os.environ["HAPPY_AGENT_BIN"]
    kept = os.path.join(AGENTS, AGENT_VERSION, "happy-agent")
    installed = os.path.expanduser(f"~/.happy/dist/version/{AGENT_VERSION}/happy-agent")
    if not os.path.exists(kept) and os.path.exists(installed):
        os.makedirs(os.path.dirname(kept), exist_ok=True)
        shutil.copy2(installed, kept)
    if not os.path.exists(kept):
        sys.exit(f"gym: no happy-agent {AGENT_VERSION} (looked in {installed} and {kept}); "
                 "put that version at either, or pass --agent / HAPPY_AGENT_BIN")
    version = subprocess.run([kept, "--version"], capture_output=True, text=True).stdout.strip()
    if not version.endswith(AGENT_VERSION):
        sys.exit(f"gym: {kept} says {version!r}, not {AGENT_VERSION}")
    return kept


def write_config():
    config = os.path.join(WORK, "Happy", "Config")
    os.makedirs(config, exist_ok=True)
    open(os.path.join(config, "happy.toml"), "w").write(f"""# The perf gym's throwaway computer: only the fake model, nothing of the person's.
[settings]
happy_integration = false

[defaults]
provider = "fake"
model = "fake-stream"
effort = "low"

[feature.mobile_connector]
enabled = true
port = {CONNECTOR_PORT}

[providers.fake]
type = "openai_compatible"
name = "Fake"
enabled = true
base_url = "http://127.0.0.1:{FAKE_PORT}/v1"
api_key = "fake"
models = ["fake-stream"]
model_metadata = false
""")
    runtime = os.path.join(HOME, "agent", "runtime.toml")
    if not os.path.exists(runtime):
        os.makedirs(os.path.dirname(runtime), exist_ok=True)
        open(runtime, "w").write('[node]\nname = "Happy Perf Gym"\n\n' + "".join(f"[providers.{p}]\nauto_enable = false\n\n" for p in ("bedrock", "claude", "codex", "grok")))


def ours(pid):
    """The process is the gym's own daemon or fake model, never anything else."""
    try:
        command = subprocess.check_output(["ps", "-o", "command=", "-p", str(pid)], text=True).strip()
    except subprocess.CalledProcessError:
        return False
    return command.startswith(os.path.join(DAEMON, "happy-agent")) or (WORK in command and "fakellm.py" in command)


def start_fake():
    try:
        urllib_get(f"http://127.0.0.1:{FAKE_PORT}/v1/models")
        return
    except Exception:
        pass
    log = open(os.path.join(WORK, "fakellm.log"), "a")
    process = subprocess.Popen([sys.executable, os.path.join(HERE, "fakellm.py"), str(FAKE_PORT), WORK], stdout=log, stderr=log, start_new_session=True)
    open(os.path.join(WORK, "fakellm.pid"), "w").write(str(process.pid))


def urllib_get(url):
    import urllib.request
    return urllib.request.urlopen(url, timeout=2).read()


def start_daemon(args):
    if healthy():
        return
    os.makedirs(DAEMON, exist_ok=True)
    binary = os.path.join(DAEMON, "happy-agent")
    source = agent_binary(args)
    # Another version asked for than the one copied before: that one.
    if not os.path.exists(binary) or not filecmp.cmp(source, binary):
        shutil.copy2(source, binary)
    for sub in ("projects", "workspaces", "tmp"):
        os.makedirs(os.path.join(DAEMON, sub), exist_ok=True)
    env = dict(os.environ, HAPPY_HOME_DIR=HOME, HAPPY_AGENT_PROJECTS_DIRECTORY=os.path.join(DAEMON, "projects"),
               HAPPY_AGENT_WORKSPACES_DIRECTORY=os.path.join(DAEMON, "workspaces"), GIT_CEILING_DIRECTORIES=DAEMON, TMPDIR=os.path.join(DAEMON, "tmp"))
    log = open(os.path.join(DAEMON, "stdout.log"), "a")
    subprocess.Popen([binary, "run"], cwd=DAEMON, env=env, stdout=log, stderr=log, start_new_session=True)
    for _ in range(120):
        if healthy():
            return
        time.sleep(0.5)
    sys.exit(f"gym: the throwaway daemon never came up; see {DAEMON}/stdout.log")


def stop_daemon():
    path = os.path.join(HOME, "agent", "daemon.pid")
    pid = int(open(path).read().strip()) if os.path.exists(path) else None
    if not pid or not ours(pid):
        return
    os.kill(pid, signal.SIGTERM)
    for _ in range(100):
        if not ours(pid):
            return
        time.sleep(0.2)


def cmd_down(args):
    stop_daemon()
    path = os.path.join(WORK, "fakellm.pid")
    if os.path.exists(path):
        pid = int(open(path).read())
        if ours(pid):
            os.kill(pid, signal.SIGTERM)
        os.remove(path)
    say("down")


def text_of(blocks):
    return "".join(b.get("text") or b.get("thinking") or "" for b in blocks if b.get("type") in ("text", "thinking"))


def records(folder):
    """An export's runs as the daemon's own history records, every send on the fake model."""
    runs = json.load(open(os.path.join(folder, "history.json")))["runs"]
    out_runs, out_records, calls = [], [], []
    for run in runs:
        messages = run.get("messages") or []
        status = run["status"] if run["status"] != "running" else "completed"
        ended = run.get("endedAt") or (messages[-1]["createdAt"] if messages else run["startedAt"])
        out_runs.append((run["id"], status, run.get("reason"), run["startedAt"], ended))
        for message in messages:
            meta = message.get("metadata") or {}
            record = {"at": message["createdAt"], "recordId": message["id"], "runId": run["id"]}
            blocks = []
            if message["role"] == "user":
                record["role"] = "user"
                for key in ("delivery", "profile", "clientMetadata"):
                    if key in message:
                        record[key] = message[key]
                if "mode" in message:
                    record["mode"] = FAKE_MODE
                for block in message.get("content") or []:
                    if block.get("type") == "text":
                        blocks.append({"text": block.get("text") or "", "type": "text"})
                    elif block.get("type") == "image":
                        blocks.append({"data": block["data"], "mediaType": block.get("mimeType") or block.get("mediaType"), "type": "image"})
            elif message["role"] == "agent" and meta.get("senderAgentId"):
                record["role"] = "agent"
                record["senderAgentId"] = meta["senderAgentId"]
                if meta.get("senderAgentExplanation"):
                    record["senderAgentExplanation"] = meta["senderAgentExplanation"]
                blocks = [b for b in message.get("content") or [] if b.get("type") == "text"]
            elif message["role"] == "agent":
                record["role"] = "assistant"
                record["provider"] = "fake"
                record["model"] = "fake-stream"
                for block in message.get("content") or []:
                    kind = block.get("type")
                    if kind == "reasoning":
                        blocks.append({"type": "thinking", "thinking": block.get("text") or ""})
                    elif kind == "text":
                        blocks.append({"type": "text", "text": block.get("text") or ""})
                    elif kind == "tool_call":
                        blocks.append({"type": "tool_call", "callId": block["id"], "name": block["name"], "arguments": block.get("arguments") or {}})
                        calls.append((block["id"], message["id"]))
                        if block.get("status") == "running":
                            continue
                        result = block.get("result") or {}
                        output = result.get("output")
                        tool_result = {"type": "tool_result", "callId": block["id"], "display": f"Tool {block['name']} returned.",
                                       "output": output if isinstance(output, str) else json.dumps(output or ""), "toolName": block["name"], "isError": block.get("status") == "failed"}
                        presentation = block.get("presentation")
                        # Only what Stem Cells draws keeps its presentation; the rest
                        # (exec_command, file_diff...) is derived by the API and never stored.
                        if presentation and presentation.get("type") in ("media", "artifact"):
                            presentation = json.loads(json.dumps(presentation))
                            for index, item in enumerate(presentation.get("items") or [] if presentation["type"] == "media" else []):
                                source = os.path.join(folder, "media", f"{block['id']}-{index}")
                                if not os.path.exists(source):
                                    continue
                                data = open(source, "rb").read()
                                sha = hashlib.sha256(data).hexdigest()
                                target = os.path.join(HOME, "agent", "media", sha[:2], sha)
                                os.makedirs(os.path.dirname(target), exist_ok=True)
                                if not os.path.exists(target):
                                    shutil.copyfile(source, target)
                                item["sha256"] = sha
                                item["size"] = len(data)
                            tool_result["presentation"] = presentation
                        blocks.append(tool_result)
            else:
                record["role"] = message["role"]
                # Configuration changes name the person's providers; never drawn.
                blocks = [b for b in message.get("content") or [] if b.get("type") != "configuration"]
            if blocks:
                record["blocks"] = blocks
                out_records.append(record)
    return out_runs, out_records, calls


def load(fixtures):
    """One task per fixture, made through the API, then its history written straight into
    the throwaway daemon's database while it is stopped."""
    mapping = json.load(open(MAP)) if os.path.exists(MAP) else {}
    folders = sorted(os.path.join(fixtures, f) for f in os.listdir(fixtures) if os.path.exists(os.path.join(fixtures, f, "history.json")))
    for folder in folders:
        if folder in mapping:
            continue
        title = json.load(open(os.path.join(folder, "stats.json")))["title"]
        task = api("POST", "/v0/tasks", {"name": title})["task"]
        mapping[folder] = {"agentId": task["agent"]["id"], "title": title}
    json.dump(mapping, open(MAP, "w"), indent=1)
    stop_daemon()
    database = sqlite3.connect(os.path.join(HOME, "agent", "agent.sqlite"))
    for folder in folders:
        agent = mapping[folder]["agentId"]
        runs, recs, calls = records(folder)
        for table in ("happy_agent_module_history", "happy_agent_module_history_runs", "happy_agent_module_history_tool_calls"):
            database.execute(f"DELETE FROM {table} WHERE agent_id=?", (agent,))
        for position, (run_id, status, reason, started, ended) in enumerate(runs):
            database.execute("INSERT INTO happy_agent_module_history_runs VALUES (?,?,?,?,?,?,?)", (agent, position, run_id, status, reason, started, ended))
        for position, record in enumerate(recs):
            blocks = record["blocks"]
            text = text_of(blocks)
            database.execute(
                "INSERT INTO happy_agent_module_history (agent_id, position, record_id, role, message_json, search_text, assistant_messages, user_messages,"
                " text_characters, thinking_blocks, tool_calls, tool_results, run_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (agent, position, record["recordId"], record["role"], json.dumps(record), text.lower()[:20000], int(record["role"] == "assistant"),
                 int(record["role"] == "user"), len(text.encode("utf-16-le")) // 2, sum(b.get("type") == "thinking" for b in blocks),
                 sum(b.get("type") == "tool_call" for b in blocks), sum(b.get("type") == "tool_result" for b in blocks), record["runId"]))
        for call, record_id in calls:
            database.execute("INSERT OR REPLACE INTO happy_agent_module_history_tool_calls VALUES (?,?,?)", (agent, call, record_id))
        say(f"loaded {mapping[folder]['title']}: {len(runs)} runs, {len(recs)} records")
    database.commit()
    database.close()


# The sidebar's other work: short synthetic tasks, each with a status its agent set, so
# the sidebar has story rows enough to scroll. None for the last, which shows the empty mark.
SIDEBAR = {
    "Release notes": "Shipped to preview",
    "Landing page copy": "Two headlines drafted; waiting on the pricing table before the hero section can be written",
    "Bug triage": "● ● [●] ○ Sorting 14 new reports",
    "Perf budget": "Rows hold 120 fps while flinging; the open is 56 ms on a cold start",
    "Android build": "Stuck on the signing key",
    "Docs cleanup": "Merged the setup pages into one guide and removed the old screenshots",
    "Onboarding flow": "On main",
    "Billing webhook": "Retries are idempotent now; next is the refund path",
    "Search index": "Reindexing 2,400 chats",
    "Design review": "Visualization ready",
    "Weekly report": "Draft is in the shared doc for a read before Friday",
    "Icon set": None,
}


def send(agent, text):
    """A message to the agent in the daemon's default mode (the fake model)."""
    mode = dict(api("GET", "/v0/config")["config"]["defaults"], serviceTier=None)
    ident = random.choice("abcdefghijklmnopqrstuvwxyz") + "".join(random.choice("abcdefghijklmnopqrstuvwxyz0123456789") for _ in range(23))
    api("POST", f"/v0/agents/{q(agent)}/send", {"id": ident, "text": text, "delivery": "steer", "mode": mode})


def seed_sidebar():
    """Stories on (story rows), and the sidebar's other tasks with their statuses."""
    api("PUT", "/v0/user-settings/happy-desktop.experiments.stories", {"value": True})
    tasks = {task["name"]: task for task in api("GET", "/v0/tasks")["tasks"]}
    for name, status in SIDEBAR.items():
        task = tasks.get(name) or api("POST", "/v0/tasks", {"name": name})["task"]
        if status and ((task["agent"].get("statusLine") or {}).get("text") != status):
            send(task["agent"]["id"], f"status {status}")
            time.sleep(1)


def post_story(title, log):
    """A story posted live to the ring of the task titled `title`, as SHIP BOSS's was:
    an html artifact the agent made, as its one frame."""
    agent = next(task["agent"]["id"] for task in api("GET", "/v0/tasks")["tasks"] if task["name"] == title)
    made = lambda: [a for a in api("GET", "/v0/artifacts")["artifacts"] if (a.get("createdBy") or {}).get("agentId") == agent]
    if not made():
        send(agent, "tool create_artifact " + json.dumps({"type": "html", "title": "Gym page"}))
        for _ in range(40):
            if made():
                break
            time.sleep(0.5)
    artifact = made()[0]["id"]
    send(agent, "tool post_story " + json.dumps({"caption": "A live story", "frames": [{"artifactId": artifact}]}))
    log.write(f"GYM_DRIVER posted a story to {title}\n")


def cmd_up(args):
    if len(SOCK.encode()) > 100:
        sys.exit(f"gym: {SOCK} is too long for a unix socket; set GYM_WORK to a shorter folder")
    fixtures = os.path.abspath(args.fixtures or os.path.join(WORK, "fixtures", "synthetic"))
    if not os.path.isdir(fixtures):
        say("no fixtures yet: making the synthetic ones")
        cmd_synth(argparse.Namespace(out=fixtures))
    os.makedirs(WORK, exist_ok=True)
    write_config()
    start_fake()
    start_daemon(args)
    load(fixtures)
    start_daemon(args)
    seed_sidebar()
    json.dump({"fixtures": fixtures}, open(os.path.join(WORK, "state.json"), "w"))
    say("up:", ", ".join(row["title"] for folder, row in json.load(open(MAP)).items() if folder.startswith(fixtures)))


# MARK: Building and running

def simulator():
    devices = json.loads(subprocess.check_output(["xcrun", "simctl", "list", "devices", "-j"]))["devices"]
    for runtime, list_ in devices.items():
        for device in list_:
            if device["name"] == SIMULATOR and device.get("isAvailable", True):
                if device["state"] != "Booted":
                    subprocess.run(["xcrun", "simctl", "boot", device["udid"]], check=False)
                    subprocess.run(["xcrun", "simctl", "bootstatus", device["udid"], "-b"], check=False, stdout=subprocess.DEVNULL)
                return device["udid"]
    runtimes = [r for r in json.loads(subprocess.check_output(["xcrun", "simctl", "list", "runtimes", "-j"]))["runtimes"] if r["platform"] == "iOS" and r["isAvailable"]]
    udid = subprocess.check_output(["xcrun", "simctl", "create", SIMULATOR, "iPhone 17 Pro", runtimes[-1]["identifier"]], text=True).strip()
    subprocess.run(["xcrun", "simctl", "boot", udid], check=False)
    subprocess.run(["xcrun", "simctl", "bootstatus", udid, "-b"], check=False, stdout=subprocess.DEVNULL)
    return udid


def derived(name):
    return os.path.join(WORK, name or "dd")


def cmd_build(args):
    udid = simulator()
    dd = derived(args.dd)
    subprocess.run(["xcodegen", "-q"], cwd=IOS, check=True)
    # ultraview's NodeTransitionAnimator doesn't compile under -O with Xcode 26; patched in the checkout only.
    for attempt in range(2):
        patch = os.path.join(dd, "SourcePackages", "checkouts", "ultraview", "Sources", "UltraCore", "UIKit", "NodeTransitionAnimator.swift")
        if os.path.exists(patch):
            os.chmod(patch, 0o644)
            source = open(patch).read().replace("\n            let layer = view.layer\n", "\n            nonisolated(unsafe) let layer = view.layer\n")
            open(patch, "w").write(source)
        log = os.path.join(WORK, f"build-{os.path.basename(dd)}.log")
        status = subprocess.run(["xcodebuild", "build-for-testing", "-project", "Happy.xcodeproj", "-scheme", "HappyDirectUI", "-configuration", "Debug",
                                 "-destination", f"id={udid}", "-derivedDataPath", dd, "-disableAutomaticPackageResolution",
                                 "SWIFT_OPTIMIZATION_LEVEL=-O", "SWIFT_COMPILATION_MODE=wholemodule", "-quiet"],
                                cwd=IOS, stdout=open(log, "w"), stderr=subprocess.STDOUT).returncode
        if status == 0:
            say("built into", dd)
            return
        if attempt == 0 and not os.path.exists(patch):
            continue
        errors = [line for line in open(log) if " error:" in line][:5]
        sys.exit("gym: build failed\n" + "".join(errors) + f"see {log}")


def cpu_seconds(pid):
    if not pid:
        return 0.0
    try:
        text = subprocess.check_output(["ps", "-o", "time=", "-p", str(pid)], text=True).strip()
    except subprocess.CalledProcessError:
        return 0.0
    parts = [float(p) for p in re.split(r"[:]", text)]
    return sum(value * 60 ** i for i, value in enumerate(reversed(parts)))


def processes(udid):
    """The simulator's render server (its backboardd) and the app."""
    table = subprocess.check_output(["ps", "-axo", "pid=,ppid=,command="], text=True).splitlines()
    rows = [line.split(None, 2) for line in table if len(line.split(None, 2)) == 3]
    launchd = next((pid for pid, _, command in rows if f"Devices/{udid}/data/var/run/launchd_bootstrap" in command), None)
    render = next((pid for pid, ppid, command in rows if ppid == launchd and command.endswith("backboardd")), None)
    app = [pid for pid, _, command in rows if udid in command and "/Happy.app/Happy" in command]
    return render, (app[-1] if app else None)


def pair(udid, log):
    pairing = api("POST", "/v0/mobile-connector/pairing", {})["mobileConnector"]["pairing"]
    subprocess.run(["xcrun", "simctl", "openurl", udid, pairing["qr"]], check=False)
    for _ in range(240):
        current = api("GET", "/v0/mobile-connector")["mobileConnector"].get("pairing") or {}
        if current.get("emoji"):
            break
        time.sleep(0.5)
    time.sleep(2)
    api("POST", "/v0/mobile-connector/pairing/confirm", {"pairingId": pairing["id"]})
    log.write("GYM_DRIVER paired\n")


def forget(udid, title):
    """The phone forgets what it kept of the chat titled `title`, so it pages in again."""
    agent = next((row["agentId"] for row in json.load(open(MAP)).values() if row["title"] == title), None)
    if not agent:
        return
    subprocess.run(["xcrun", "simctl", "terminate", udid, BUNDLE], check=False, stderr=subprocess.DEVNULL)
    time.sleep(1)
    try:
        container = subprocess.check_output(["xcrun", "simctl", "get_app_container", udid, BUNDLE, "data"], text=True, stderr=subprocess.DEVNULL).strip()
    except subprocess.CalledProcessError:
        return
    base = os.path.join(container, "Library", "Application Support", "StemCells")
    for folder in os.listdir(base) if os.path.isdir(base) else []:
        path = os.path.join(base, folder, "direct.sqlite")
        if os.path.exists(path):
            database = sqlite3.connect(path)
            database.execute("DELETE FROM checkpoint WHERE name = ?", (f"conversation:{agent}",))
            database.commit()
            database.close()


def run_test(udid, dd, test, label, env, results_dir):
    """One UI test, the desktop side of pairing played as it asks; its GYM_RESULT lines."""
    os.makedirs(results_dir, exist_ok=True)
    bundle = os.path.join(results_dir, f"{label}-{test}.xcresult")
    shutil.rmtree(bundle, ignore_errors=True)
    log = open(os.path.join(results_dir, f"{label}-{test}.log"), "w", buffering=1)
    command = ["xcodebuild", "test-without-building", "-project", "Happy.xcodeproj", "-scheme", "HappyDirectUI", "-destination", f"id={udid}",
               "-derivedDataPath", dd, "-resultBundlePath", bundle, f"-only-testing:HappyDirectUITests/ScrollPerfGymTests/{test}"]
    process = subprocess.Popen(command, cwd=IOS, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                               env=dict(os.environ, **{f"TEST_RUNNER_{k}": v for k, v in env.items()}))
    results, xct, start = [], {}, None
    for line in process.stdout:
        log.write(line)
        if "STEM_PAIR_READY" in line:
            threading.Thread(target=pair, args=(udid, log), daemon=True).start()
        elif line.startswith("GYM_POST_STORY "):
            threading.Thread(target=post_story, args=(line.split(" ", 1)[1].strip(), log), daemon=True).start()
        elif "GYM_MARK start" in line:
            render, app = processes(udid)
            start = (render, app, cpu_seconds(render), cpu_seconds(app))
        elif line.startswith("GYM_RESULT"):
            parts = line.split()
            # `key=value` pairs; the transcript's own come comma-joined (`first=true,ms=113`)
            # and a list value is commas without `=` (`changed=1,0,1`).
            pairs = []
            for piece in ",".join(parts[2:]).replace(" ", ",").split(","):
                if "=" in piece:
                    pairs.append(list(piece.split("=", 1)))
                elif pairs:
                    pairs[-1][1] += "," + piece
            values = {}
            for key, value in pairs:
                try:
                    values[key] = float(value)
                except ValueError:
                    values[key] = value
            if start:
                values["renderCpu"] = round(cpu_seconds(start[0]) - start[2], 2)
                values["appCpu"] = round(cpu_seconds(start[1]) - start[3], 2)
            results.append((parts[1], values))
        elif "measured [" in line:
            match = re.search(r"measured \[(.+?)\] average: ([\d.]+)", line)
            if match:
                xct[match.group(1)] = float(match.group(2))
    status = process.wait()
    log.close()
    return status, results, xct


def cmd_run(args):
    if not healthy():
        say("the throwaway daemon is down: bringing it up")
        cmd_up(argparse.Namespace(fixtures=json.load(open(os.path.join(WORK, "state.json")))["fixtures"] if os.path.exists(os.path.join(WORK, "state.json")) else None, agent=None))
    udid = simulator()
    dd = derived(args.dd)
    if not os.path.isdir(os.path.join(dd, "Build", "Products")):
        cmd_build(args)
    titles = {"long": args.chat or SYNTHETIC["long"], "images": args.images or SYNTHETIC["images"]}
    titles["paging"] = args.paging or titles["long"]
    env = {"GYM_CHAT": titles["long"], "GYM_IMAGES": titles["images"], "GYM_PAGING": titles["paging"], "GYM_STREAM": titles["long"],
           "GYM_ITERATIONS": str(args.iterations)}
    label = args.label or time.strftime("%Y%m%d-%H%M%S")
    results_dir = os.path.join(WORK, "results")
    names = args.workloads or list(WORKLOADS)
    unknown = [n for n in names if n not in WORKLOADS]
    if unknown:
        sys.exit(f"gym: no workload {', '.join(unknown)}; there are {', '.join(WORKLOADS)}")
    if not args.no_prime:
        say("priming: reading the chats back to their first message")
        run_test(udid, dd, "testPrime", label, env, results_dir)
    agent = subprocess.run([os.path.join(DAEMON, "happy-agent"), "--version"], capture_output=True, text=True).stdout.strip()
    out = {"label": label, "date": time.strftime("%Y-%m-%dT%H:%M:%S"), "commit": git("rev-parse", "--short", "HEAD"), "agent": agent,
           "simulator": SIMULATOR, "chats": titles, "workloads": {}}
    for name in names:
        test, forgets = WORKLOADS[name]
        if forgets:
            forget(udid, titles[forgets])
        if not healthy():
            start_daemon(args)
        say(f"{name} ({test})")
        status, results, xct = run_test(udid, dd, test, label, env, results_dir)
        for workload, values in results:
            values["xctest"] = xct
            values["passed"] = status == 0
            out["workloads"][workload] = values
            say("  " + " ".join(f"{k}={values.get(k)}" for k in ("hitchRatio", "dropped", "p95", "max", "mainMax", "applyMax", "peakMB", "views")))
        if not results:
            out["workloads"][name] = {"passed": False}
            say(f"  no result; see {results_dir}/{label}-{test}.log")
    path = os.path.join(results_dir, f"{label}.json")
    json.dump(out, open(path, "w"), indent=1)
    say("results:", path)
    sys.exit(check(out, args.budgets))


def git(*command):
    try:
        return subprocess.check_output(["git", *command], cwd=IOS, text=True, stderr=subprocess.DEVNULL).strip()
    except subprocess.CalledProcessError:
        return ""


def check(results, budgets_path=None):
    """1 if any workload is over a budget or failed, else 0."""
    budgets = json.load(open(budgets_path or os.path.join(HERE, "budgets.json")))
    failed = 0
    for name, values in results["workloads"].items():
        budget = budgets.get(name, {})
        over = [f"{key} {values.get(key)} > {limit}" for key, limit in budget.items() if not key.startswith("_") and isinstance(values.get(key), (int, float)) and values[key] > limit]
        if not values.get("passed", False):
            over.append("the test failed")
        missing = [key for key in budget if not key.startswith("_") and key not in values]
        print(f"{'FAIL' if over else 'PASS'} {name}" + (": " + "; ".join(over) if over else "") + (f" (not measured: {', '.join(missing)})" if missing and values.get("passed") else ""))
        failed |= bool(over)
    for name in budgets:
        if not name.startswith("_") and name not in results["workloads"]:
            print(f"SKIP {name}")
    return 1 if failed else 0


def cmd_check(args):
    sys.exit(check(json.load(open(args.results)), args.budgets))


def cmd_compare(args):
    a, b = json.load(open(args.a)), json.load(open(args.b))
    keys = ["hitchRatio", "dropped", "p95", "p99", "max", "mainP95", "mainMax", "applyMax", "peakMB", "views", "renderCpu", "appCpu"]
    print(f"{'workload':24s} {'metric':11s} {a['label']:>14s} {b['label']:>14s}")
    for name in a["workloads"]:
        if name not in b["workloads"]:
            continue
        for key in keys:
            x, y = a["workloads"][name].get(key), b["workloads"][name].get(key)
            if isinstance(x, (int, float)) and isinstance(y, (int, float)):
                print(f"{name:24s} {key:11s} {x:14.2f} {y:14.2f}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("synth"); p.add_argument("--out"); p.set_defaults(func=cmd_synth)
    p = sub.add_parser("export"); p.add_argument("agents", nargs="+"); p.add_argument("--out"); p.set_defaults(func=cmd_export)
    p = sub.add_parser("up"); p.add_argument("--fixtures"); p.add_argument("--agent"); p.set_defaults(func=cmd_up)
    p = sub.add_parser("down"); p.set_defaults(func=cmd_down)
    p = sub.add_parser("build"); p.add_argument("--dd"); p.set_defaults(func=cmd_build)
    p = sub.add_parser("run")
    p.add_argument("workloads", nargs="*")
    p.add_argument("--dd"); p.add_argument("--label"); p.add_argument("--budgets"); p.add_argument("--agent")
    p.add_argument("--chat", help="the long chat's title (default the synthetic one)")
    p.add_argument("--images", help="the chat heavy with pictures"); p.add_argument("--paging", help="the chat paged in (default the long one)")
    p.add_argument("--iterations", type=int, default=1, help="XCTest metric iterations")
    p.add_argument("--no-prime", action="store_true", help="the chats are already read back to their first message")
    p.set_defaults(func=cmd_run)
    p = sub.add_parser("check"); p.add_argument("results"); p.add_argument("--budgets"); p.set_defaults(func=cmd_check)
    p = sub.add_parser("compare"); p.add_argument("a"); p.add_argument("b"); p.set_defaults(func=cmd_compare)
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
