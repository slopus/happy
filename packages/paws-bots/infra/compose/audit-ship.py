#!/usr/bin/env python3
"""Ship SSH, sudo, identity and watched-file events to an HTTP sink so they outlive the host.

The sink is any endpoint that accepts a JSON array of events with a bearer token. Offsets advance
only after the sink accepts a pass, so delivery is at least once.
"""

import datetime
import ipaddress
import json
import os
import re
import socket
import sys
import tempfile
import time
import urllib.parse
import urllib.request
from pathlib import Path

AUTH_LOG = "/var/log/auth.log"
AUDIT_LOG = "/var/log/audit/audit.log"
# Keys from the audit rules that harden-host.sh installs.
WATCH_KEYS = frozenset(
    {
        "sshd_config",
        "sudoers",
        "identity",
        "ssh_keys",
        "rakazo_config",
        "app_secrets",
        "host_scripts",
        "persistence",
        "docker_config",
    }
)
IDENTITY_PROGRAMS = frozenset(
    {"useradd", "userdel", "usermod", "groupadd", "groupdel", "groupmod", "passwd", "chpasswd", "gpasswd"}
)
MAX_READ = 4 * 1024 * 1024
BATCH_SIZE = 500
IDLE_SECONDS = 10
MAX_BACKOFF = 300
# A quiet host still proves the shipper is alive, so "no events" alerts don't depend on activity.
DEFAULT_HEARTBEAT_SECONDS = 3 * 60 * 60

# RFC3339 (rsyslog's high-precision default) or the traditional "Oct 22 22:43:54" format.
SYSLOG = re.compile(r"^(\S+T\S+|[A-Z][a-z]{2} [ \d]\d \d\d:\d\d:\d\d) (\S+) ([^\s\[:]+)(?:\[\d+\])?: (.*)$", re.S)
ACCEPTED = re.compile(r"^Accepted (\S+) for (\S+) from (\S+) port \d+(?: [^\s:]+)?(?:: (\S+) (\S+))?")
FAILED = re.compile(r"^Failed \S+ for (?:invalid user )?(\S*) from (\S+) port")
INVALID = re.compile(r"^Invalid user (\S*) from (\S+)")
SUDO = re.compile(r"^\s*(\S+) : .*?USER=(\S+) ; COMMAND=(.*)$", re.S)
AUDIT_HEADER = re.compile(r"\bmsg=audit\((\d+(?:\.\d+)?):(\d+)\)")
AUDIT_SERIAL = re.compile(rb"\bmsg=audit\([\d.]+:(\d+)\)")
AUDIT_FIELD = re.compile(r'\b(type|key|exe|comm|auid|uid|name|nametype)=("[^"]*"|\S+)')


REDACTED = "[Redacted]"
EMAIL_CANDIDATE = re.compile(r"\b[A-Z0-9._%+-]+(?:@[A-Z0-9.-]+\.[A-Z]{2,}\b)?", re.I)
PEM_PRIVATE_KEY = re.compile(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)")
URL_USERINFO = re.compile(r"([a-z][a-z0-9+.-]*://)[^\s/\"'<>@]+@", re.I)
QUERY_SECRET = re.compile(r"([?&](?:token|access_token|refresh_token|id_token|code|key|api_key|apikey|secret|password|sig|signature|X-Amz-Signature|auth)=)[^\s&#\"'<>]*", re.I)
BEARER = re.compile(r"\bBearer\s+[^\s\"',;&]+", re.I)
SECRET_NAME = r"[A-Za-z0-9_]*(?:password|passwd|secret|token|key|credential|authorization)[A-Za-z0-9_]*"
SECRET_VALUE = r"""(?:"(?:\\.|[^"\\])*(?:"|$)|'[^']*(?:'|$)|[^\s;"'&]+)"""
SECRET_ASSIGNMENT = re.compile(r"\b(" + SECRET_NAME + r"\s*[:=]\s*)" + SECRET_VALUE, re.I)
SECRET_FLAG = re.compile(
    r"(--[a-z0-9_-]*(?:password|passwd|secret|token|key|credential)[a-z0-9_-]*(?:=|\s+))"
    + SECRET_VALUE, re.I
)
JSON_SECRET_FIELD = re.compile(
    r'("' + SECRET_NAME + r'"\s*:\s*)"(?:\\.|[^"\\])*(?:"|$)', re.I
)
BARE_SECRET = re.compile(
    r"\b(?:sk-(?:or-v1-)?[A-Za-z0-9_-]{8,}|(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]+|"
    r"xox[abprs]-[A-Za-z0-9-]+|AKIA[A-Z0-9]{16}|"
    r"eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b"
)


def redact_sensitive_text(text):
    text = PEM_PRIVATE_KEY.sub(REDACTED, text)
    text = URL_USERINFO.sub(lambda m: m[1] + REDACTED + "@", text)
    text = QUERY_SECRET.sub(lambda m: m[1] + REDACTED, text)
    text = JSON_SECRET_FIELD.sub(lambda m: m[1] + '"' + REDACTED + '"', text)
    text = BEARER.sub("Bearer " + REDACTED, text)
    text = SECRET_ASSIGNMENT.sub(lambda m: m[1] + REDACTED, text)
    text = SECRET_FLAG.sub(lambda m: m[1] + REDACTED, text)
    text = BARE_SECRET.sub(REDACTED, text)
    return EMAIL_CANDIDATE.sub(lambda m: REDACTED if "@" in m[0] else m[0], text)


def parse_known_keys(text):
    """Map SHA256 fingerprints to names from space-separated fingerprint=name pairs."""
    names = {}
    for pair in (text or "").split():
        fingerprint, _, name = pair.rpartition("=")
        if fingerprint and name:
            names[fingerprint] = name
    return names


def _event(kind, source, host, message, **fields):
    return {"event": kind, "source": source, "host": host, "message": redact_sensitive_text(message)[:1000], **fields}


def syslog_time(timestamp, now=None):
    """Return an RFC3339 time; traditional timestamps are local time without a year."""
    if "T" in timestamp:
        return timestamp
    now = now or datetime.datetime.now()
    try:
        moment = datetime.datetime.strptime(str(now.year) + " " + timestamp, "%Y %b %d %H:%M:%S")
    except ValueError:
        return timestamp
    if moment > now + datetime.timedelta(days=1):
        # A December record read in January.
        moment = moment.replace(year=now.year - 1)
    # Resolve the local offset for the record's own date, which differs across a DST change.
    return moment.astimezone().isoformat()


def parse_auth_line(line, host, known_keys):
    match = SYSLOG.match(line)
    if not match:
        return None
    timestamp, _, program, message = match.groups()
    fields = {"_time": syslog_time(timestamp)}
    if program in ("sshd", "sshd-session"):
        if accepted := ACCEPTED.match(message):
            method, user, ip, key_type, fingerprint = accepted.groups()
            fields.update(user=user, ip=ip, method=method)
            if fingerprint:
                fields.update(
                    key_type=key_type,
                    key_fingerprint=fingerprint,
                    key_name=known_keys.get(fingerprint, "unknown"),
                )
            return _event("ssh.login", "auth.log", host, message, **fields)
        if failed := FAILED.match(message) or INVALID.match(message):
            user, ip = failed.groups()
            return _event("ssh.failed", "auth.log", host, message, user=user, ip=ip, **fields)
        return None
    if program == "sudo":
        if sudo := SUDO.match(message):
            user, as_user, command = sudo.groups()
            return _event(
                "sudo.command", "auth.log", host, message, user=user, as_user=as_user, command=redact_sensitive_text(command)[:500], **fields
            )
        return None
    if program in IDENTITY_PROGRAMS:
        return _event("identity.change", "auth.log", host, message, program=program, **fields)
    if program == "su":
        return _event("su", "auth.log", host, message, **fields)
    return None


def parse_auth_lines(lines, host, known_keys):
    return [event for event in (parse_auth_line(line, host, known_keys) for line in lines) if event]


def _audit_value(raw):
    return raw[1:-1] if raw.startswith('"') else raw


def parse_audit_lines(lines, host):
    """Turn keyed SYSCALL records into file.change events, adding paths from their PATH records."""
    events = []
    by_serial = {}
    for line in lines:
        # ENRICHED logs append translated names after a group separator; the raw fields suffice.
        line = line.split("\x1d", 1)[0]
        header = AUDIT_HEADER.search(line)
        if not header:
            continue
        fields = {name: _audit_value(value) for name, value in AUDIT_FIELD.findall(line)}
        serial = header.group(2)
        if fields.get("type") == "SYSCALL" and fields.get("key") in WATCH_KEYS:
            moment = datetime.datetime.fromtimestamp(float(header.group(1)), datetime.timezone.utc)
            event = _event(
                "file.change",
                "audit.log",
                host,
                line,
                _time=moment.isoformat(),
                audit_serial=int(serial),
                watch=fields["key"],
                **{name: fields[name] for name in ("exe", "comm", "auid", "uid") if name in fields},
            )
            events.append(event)
            by_serial[serial] = event
        elif fields.get("type") == "PATH" and serial in by_serial and fields.get("nametype") != "PARENT":
            if "name" in fields:
                by_serial[serial].setdefault("paths", []).append(fields["name"])
    return events


def audit_group_start(data):
    """Return where the last audit event's records begin, so a cut read keeps them together."""
    lines = data.splitlines(keepends=True)
    serial = AUDIT_SERIAL.search(lines[-1])
    start = len(data)
    for line in reversed(lines):
        match = AUDIT_SERIAL.search(line)
        if not serial or not match or match.group(1) != serial.group(1):
            break
        start -= len(line)
    return start


def _open_unread(path, saved):
    """Open the log, or its rotated predecessor while that still has lines past the saved offset."""
    handle = open(path, "rb")
    if saved is None or os.fstat(handle.fileno()).st_ino == saved["inode"]:
        return handle
    try:
        rotated = open(str(path) + ".1", "rb")
    except FileNotFoundError:
        return handle
    info = os.fstat(rotated.fileno())
    if info.st_ino == saved["inode"] and info.st_size > saved["offset"]:
        handle.close()
        return rotated
    rotated.close()
    return handle


def read_new(path, saved, start_at_end, group_start=None):
    """Return complete new lines, the position after them, and whether more data is waiting."""
    try:
        handle = _open_unread(path, saved)
    except FileNotFoundError:
        return b"", saved, False
    with handle:
        info = os.fstat(handle.fileno())
        if saved is None:
            offset = info.st_size if start_at_end else 0
        elif saved["inode"] != info.st_ino or info.st_size < saved["offset"]:
            # Rotated and drained, or truncated: the current file starts over.
            offset = 0
        else:
            offset = saved["offset"]
        handle.seek(offset)
        data = handle.read(MAX_READ)
        rotated = handle.name != str(path)
    full = len(data) == MAX_READ
    end = data.rfind(b"\n") + 1
    # A partial last line waits for its newline, unless one line fills the whole read or the file
    # was rotated away and will not grow.
    if not ((full and not end) or (rotated and not full)):
        data = data[:end]
    if full and group_start and data:
        data = data[: group_start(data) or len(data)]
    return data, {"inode": info.st_ino, "offset": offset + len(data)}, full or rotated


def load_state(path):
    try:
        return json.loads(Path(path).read_text())
    except (FileNotFoundError, ValueError):
        return {}


def save_state(path, state):
    path = Path(path)
    fd, name = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as output:
            json.dump(state, output)
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)


def check_sink_url(url):
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme == "https":
        return
    if parsed.scheme == "http":
        try:
            if parsed.hostname == "localhost" or ipaddress.ip_address(parsed.hostname or "").is_loopback:
                return
        except ValueError:
            pass
    raise ValueError("RAKAZO_AUDIT_SINK_URL must use https")


class _RejectRedirects(urllib.request.HTTPRedirectHandler):
    # Following a redirect would forward the bearer token and drop the POST body.
    def redirect_request(self, *args, **kwargs):
        return None


def sender(url, token_file, timeout=20):
    check_sink_url(url)
    opener = urllib.request.build_opener(_RejectRedirects)

    def send(events):
        # Read the token per request so it can be rotated without a restart.
        token = Path(token_file).read_text().strip()
        request = urllib.request.Request(
            url,
            json.dumps(events).encode(),
            {"Content-Type": "application/json", "Authorization": "Bearer " + token},
            method="POST",
        )
        with opener.open(request, timeout=timeout) as response:
            if not 200 <= response.status < 300:
                raise RuntimeError("Audit sink returned HTTP " + str(response.status))

    return send


def ship_once(sources, state_path, state, send):
    """Ship one pass over every source. Returns whether a source has more data waiting."""
    pending = False
    for name, path, parse, start_at_end, group_start in sources:
        data, position, more = read_new(path, state.get(name), start_at_end, group_start)
        events = parse(data.decode("utf-8", "replace").splitlines())
        for start in range(0, len(events), BATCH_SIZE):
            send(events[start : start + BATCH_SIZE])
        if position != state.get(name):
            state[name] = position
            save_state(state_path, state)
        pending = pending or more
    return pending


def heartbeat_seconds(value):
    if not value:
        return DEFAULT_HEARTBEAT_SECONDS
    seconds = int(value)
    if seconds < 60:
        raise ValueError("RAKAZO_AUDIT_HEARTBEAT_SECONDS must be at least 60")
    return seconds


def heartbeat_event(host, now):
    stamp = datetime.datetime.fromtimestamp(now, datetime.timezone.utc).isoformat().replace("+00:00", "Z")
    return _event("shipper.heartbeat", "shipper", host, "Audit shipper heartbeat", _time=stamp)


def main():
    url = os.environ.get("RAKAZO_AUDIT_SINK_URL", "")
    token_file = os.environ.get("RAKAZO_AUDIT_TOKEN_FILE", "/etc/rakazo/audit-ship.token")
    host = os.environ.get("RAKAZO_AUDIT_HOST") or socket.gethostname()
    known_keys = parse_known_keys(os.environ.get("RAKAZO_AUDIT_KNOWN_KEYS", ""))
    state_dir = os.environ.get("STATE_DIRECTORY", "/var/lib/rakazo/audit-ship").split(":")[0]
    state_path = Path(state_dir) / "state.json"
    if not url:
        print("RAKAZO_AUDIT_SINK_URL is not set", file=sys.stderr)
        return 1
    send = sender(url, token_file)
    sources = [
        ("auth", AUTH_LOG, lambda lines: parse_auth_lines(lines, host, known_keys), False, None),
        ("audit", AUDIT_LOG, lambda lines: parse_audit_lines(lines, host), True, audit_group_start),
    ]
    interval = heartbeat_seconds(os.environ.get("RAKAZO_AUDIT_HEARTBEAT_SECONDS", ""))
    state = load_state(state_path)
    backoff = 0
    last_heartbeat = None
    while True:
        try:
            pending = ship_once(sources, state_path, state, send)
            # Only a pass that shipped cleanly proves the trail is flowing, so a shipper that keeps
            # failing goes quiet and trips the alert. Monotonic time ignores clock adjustments.
            now = time.monotonic()
            if last_heartbeat is None or now - last_heartbeat >= interval:
                send([heartbeat_event(host, time.time())])
                last_heartbeat = now
        except Exception as error:
            # Never log exception text, which can echo the sink URL or response.
            backoff = min(MAX_BACKOFF, backoff * 2 or 5)
            print(
                "Audit shipping failed (" + type(error).__name__ + "); retrying in " + str(backoff) + "s",
                file=sys.stderr,
                flush=True,
            )
            time.sleep(backoff)
            continue
        if backoff:
            print("Audit shipping recovered", flush=True)
            backoff = 0
        if not pending:
            time.sleep(IDLE_SECONDS)


if __name__ == "__main__":
    sys.exit(main())
