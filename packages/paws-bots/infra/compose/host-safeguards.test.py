#!/usr/bin/env python3
"""Offline tests; all state, firewall commands and alert delivery are isolated."""

import concurrent.futures
import contextlib
import datetime
import fcntl
import http.server
import importlib.util
import io
import json
import os
import subprocess
import tempfile
import threading
import time
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("host_alert", ROOT / "host-alert.py")
alerts = importlib.util.module_from_spec(spec)
spec.loader.exec_module(alerts)


service_spec = importlib.util.spec_from_file_location("service_health", ROOT / "check-services.py")
service_health = importlib.util.module_from_spec(service_spec)
service_spec.loader.exec_module(service_health)

ship_spec = importlib.util.spec_from_file_location("audit_ship", ROOT / "audit-ship.py")
audit_ship = importlib.util.module_from_spec(ship_spec)
ship_spec.loader.exec_module(audit_ship)


class FakeSink(http.server.BaseHTTPRequestHandler):
    status = 200
    requests = []

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        FakeSink.requests.append((self.headers["Authorization"], json.loads(body or "null")))
        self.send_response(FakeSink.status)
        # Redirect back to this sink; a followed redirect would show up as a second request.
        self.send_header("Location", "/elsewhere")
        self.end_headers()

    do_GET = do_POST

    def log_message(self, *args):
        pass


class BaseImageTests(unittest.TestCase):
    def test_literal_base_images_are_pinned_by_digest(self):
        for dockerfile in sorted(ROOT.parent.rglob("Dockerfile*")):
            stages = set()
            for number, line in enumerate(dockerfile.read_text().splitlines(), 1):
                parts = line.split()
                if not parts or parts[0].upper() != "FROM":
                    continue
                image = next(part for part in parts[1:] if not part.startswith("--"))
                if "$" not in image and image.lower() not in stages and image != "scratch":
                    with self.subTest(file=str(dockerfile.relative_to(ROOT.parent)), line=number):
                        self.assertRegex(image, r"@sha256:[0-9a-f]{64}$")
                if len(parts) >= 4 and parts[-2].upper() == "AS":
                    stages.add(parts[-1].lower())


class AuditShipTests(unittest.TestCase):
    KEYS = audit_ship.parse_known_keys("SHA256:known/key+1= SHA256:laptopkey=laptop")

    def auth(self, message, program="sshd[812]"):
        line = "2026-10-22T22:43:54.086672+00:00 web-1 " + program + ": " + message
        return audit_ship.parse_auth_line(line, "host-a", self.KEYS)

    def test_ssh_events(self):
        login = self.auth("Accepted publickey for deploy from 192.0.2.10 port 51234 ssh2: ED25519 SHA256:laptopkey")
        self.assertEqual(login["event"], "ssh.login")
        self.assertEqual(
            {k: login[k] for k in ("host", "source", "user", "ip", "method", "key_type", "key_fingerprint", "key_name", "_time")},
            {
                "host": "host-a",
                "source": "auth.log",
                "user": "deploy",
                "ip": "192.0.2.10",
                "method": "publickey",
                "key_type": "ED25519",
                "key_fingerprint": "SHA256:laptopkey",
                "key_name": "laptop",
                "_time": "2026-10-22T22:43:54.086672+00:00",
            },
        )
        stranger = self.auth("Accepted publickey for deploy from 192.0.2.11 port 2 ssh2: RSA SHA256:other", "sshd-session[9]")
        self.assertEqual(stranger["key_name"], "unknown")
        password = self.auth("Accepted password for deploy from 192.0.2.12 port 3 ssh2")
        self.assertEqual((password["method"], "key_name" in password), ("password", False))
        failed = self.auth("Failed password for invalid user admin from 198.51.100.7 port 4 ssh2")
        self.assertEqual((failed["event"], failed["user"], failed["ip"]), ("ssh.failed", "admin", "198.51.100.7"))
        invalid = self.auth("Invalid user oracle from 198.51.100.8 port 5")
        self.assertEqual((invalid["event"], invalid["user"]), ("ssh.failed", "oracle"))
        self.assertIsNone(self.auth("Connection closed by 198.51.100.9 port 6"))

    def test_command_redaction(self):
        cases = [
            ("docker exec -e PGPASSWORD=fake-value app psql", "fake-value", "docker exec", "app"),
            ("sh <<'EOF'\nFAKE_SECRET_ACCESS_KEY=fake-value\npsql\nEOF", "fake-value", "sh", "psql"),
            ("psql -c \"select 'user@example.com'\"", "user@example.com", "psql", "select"),
            ("psql postgres://app:fake-pass@db.example.com/app", "app:fake-pass", "psql", "db.example.com"),
            ("curl -H 'Authorization: Bearer fake-value' https://example.com", "fake-value", "curl", "example.com"),
            ("cat <<'EOF'\n-----BEGIN RSA PRIVATE KEY-----\nfake-value\n-----END RSA PRIVATE KEY-----\nEOF", "fake-value", "cat", "EOF"),
            ("curl 'https://example.com/?token=fake-value&mode=test'", "fake-value", "curl", "mode=test"),
        ]
        for command, secret, executable, useful in cases:
            with self.subTest(command=command):
                event = self.auth("app : USER=root ; COMMAND=" + command, "sudo")
                self.assertEqual((event["user"], event["as_user"]), ("app", "root"))
                for field in ("command", "message"):
                    self.assertNotIn(secret, event[field])
                    self.assertIn("[Redacted]", event[field])
                    self.assertIn(executable, event[field])
                    self.assertIn(useful, event[field])

    def test_text_redaction_patterns(self):
        secrets = [
            "PGPASSWORD=fake-value", "AWS_SECRET_ACCESS_KEY=fake-value",
            "API_KEY=fake-value", "CREDENTIAL=fake-value", "PASSWD=fake-value",
            '--password="fake-value with spaces"', "--password fake-value",
            "--token fake-value", "--api-key fake-value", 'API_KEY="fake-value with spaces"',
            '\"password\":\"fake-value with spaces\"', '\"api_key\":\"fake-value\"',
            "Bearer fake-value", "sk-test-" + "x" * 24,
            *[prefix + "x" * 40 for prefix in ("ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_")],
            *[prefix + "-" + "x" * 24 for prefix in ("xoxa", "xoxb", "xoxp", "xoxr", "xoxs")],
            "AKIAEXAMPLEEXAMPLE12", "eyJfake.eyJfake.fake", "owner@example.org",
            "-----BEGIN PRIVATE KEY-----\nfake-value",
            *["https://example.com/?" + key + "=fake-value&mode=test" for key in (
                "token", "access_token", "refresh_token", "id_token", "code", "key", "api_key",
                "apikey", "secret", "password", "sig", "signature", "X-Amz-Signature", "auth",
            )],
        ]
        for text in secrets:
            with self.subTest(text=text):
                redacted = audit_ship.redact_sensitive_text(text)
                self.assertIn("[Redacted]", redacted)
                self.assertNotIn("fake-value", redacted)
                self.assertNotIn("x" * 24, redacted)
                self.assertNotIn("eyJfake", redacted)
                self.assertNotIn("AKIAEXAMPLEEXAMPLE12", redacted)
                self.assertNotIn("owner@example.org", redacted)
        for program in ("su", "useradd"):
            event = self.auth("PGPASSWORD=fake-value owner@example.org", program)
            self.assertNotIn("fake-value", event["message"])
            self.assertNotIn("owner@example.org", event["message"])

    def test_redaction_precedes_truncation(self):
        command = "docker exec app -e PGPASSWORD=" + "x" * 1500
        event = self.auth("app : USER=root ; COMMAND=" + command, "sudo")
        self.assertEqual(event["command"], "docker exec app -e PGPASSWORD=[Redacted]")
        self.assertTrue(event["message"].endswith("PGPASSWORD=[Redacted]"))

    def test_sudo_identity_su_and_truncation(self):
        command = "/usr/bin/echo " + "x" * 2000
        sudo = self.auth("  deploy : TTY=pts/0 ; PWD=/home/deploy ; USER=root ; COMMAND=" + command, "sudo")
        self.assertEqual((sudo["event"], sudo["user"], sudo["as_user"]), ("sudo.command", "deploy", "root"))
        self.assertEqual(sudo["command"], command[:500])
        self.assertEqual(len(sudo["message"]), 1000)
        self.assertIsNone(self.auth("pam_unix(sudo:session): session opened for user root(uid=0) by deploy(uid=1000)", "sudo"))
        identity = self.auth("new user: name=intruder, UID=1001, GID=1001", "useradd[77]")
        self.assertEqual((identity["event"], identity["program"]), ("identity.change", "useradd"))
        self.assertEqual(self.auth("(to root) deploy on pts/0", "su[5]")["event"], "su")
        self.assertIsNone(self.auth("Started session", "systemd[1]"))
        traditional = audit_ship.parse_auth_line("Oct  2 22:43:54 web-1 su[1]: (to root) deploy on pts/0", "h", {})
        self.assertEqual(traditional["event"], "su")
        # A POSIX zone string needs no tz database: UTC in winter, +01:00 in summer.
        # Cleanups run after patch.dict restores TZ, so this resets the process zone.
        self.addCleanup(time.tzset)
        with patch.dict(os.environ, {"TZ": "GMT0BST,M3.5.0/1,M10.5.0"}):
            time.tzset()
            december = datetime.datetime(2026, 12, 15)
            self.assertEqual(audit_ship.syslog_time("Jul  2 22:43:54", december), "2026-07-02T22:43:54+01:00")
            self.assertEqual(audit_ship.syslog_time("Dec  2 22:43:54", december), "2026-12-02T22:43:54+00:00")
            self.assertEqual(
                audit_ship.syslog_time("Dec 31 23:59:59", datetime.datetime(2027, 1, 1)),
                "2026-12-31T23:59:59+00:00",
            )
        self.assertIsNone(audit_ship.parse_auth_line("not syslog", "h", {}))

    def test_audit_file_changes(self):
        lines = [
            'type=SYSCALL msg=audit(1761173034.123:4567): arch=c000003e syscall=257 success=yes auid=1000 uid=0 '
            'comm="tee" exe="/usr/bin/tee" key="ssh_keys"\x1dARCH=x86_64 AUID="deploy" UID="root"',
            "type=CWD msg=audit(1761173034.123:4567): cwd=\"/root\"",
            'type=PATH msg=audit(1761173034.123:4567): item=0 name="/root/.ssh/" nametype=PARENT',
            'type=PATH msg=audit(1761173034.123:4567): item=1 name="/root/.ssh/authorized_keys" nametype=CREATE',
            'type=SYSCALL msg=audit(1761173035.000:4568): auid=1000 uid=0 comm="cat" exe="/usr/bin/cat" key=(null)',
            'type=SYSCALL msg=audit(1761173036.000:4569): auid=1000 uid=0 comm="vi" exe="/usr/bin/vi" key="other"',
        ]
        events = audit_ship.parse_audit_lines(lines, "host-a")
        self.assertEqual(len(events), 1)
        event = events[0]
        self.assertEqual(
            {k: event[k] for k in ("event", "watch", "exe", "comm", "auid", "uid", "audit_serial", "paths", "source")},
            {
                "event": "file.change",
                "watch": "ssh_keys",
                "exe": "/usr/bin/tee",
                "comm": "tee",
                "auid": "1000",
                "uid": "0",
                "audit_serial": 4567,
                "paths": ["/root/.ssh/authorized_keys"],
                "source": "audit.log",
            },
        )
        self.assertTrue(event["_time"].startswith("2025-10-22T22:43:54.123"))
        self.assertNotIn("\x1d", event["message"])

    def test_offsets_rotation_and_truncation(self):
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / "audit.log"
            self.assertEqual(audit_ship.read_new(log, None, True), (b"", None, False))
            log.write_bytes(b"old\n")
            data, position, _ = audit_ship.read_new(log, None, True)
            self.assertEqual((data, position["offset"]), (b"", 4))
            data, _, _ = audit_ship.read_new(log, None, False)
            self.assertEqual(data, b"old\n")
            with log.open("ab") as output:
                output.write(b"new\npartial")
            data, position, more = audit_ship.read_new(log, position, True)
            self.assertEqual((data, position["offset"], more), (b"new\n", 8, False))
            log.write_bytes(b"cut\n")  # truncated in place: same inode, smaller size
            data, position, _ = audit_ship.read_new(log, position, True)
            self.assertEqual(data, b"cut\n")
            with log.open("ab") as output:
                output.write(b"unread\n")
            log.rename(str(log) + ".1")
            log.write_bytes(b"rotated\n")
            # Lines written before rotation are drained from the renamed file first.
            data, position, more = audit_ship.read_new(log, position, True)
            self.assertEqual((data, more), (b"unread\n", True))
            data, position, more = audit_ship.read_new(log, position, True)
            self.assertEqual((data, position["offset"], more), (b"rotated\n", 8, False))
            data, _, _ = audit_ship.read_new(log, {"inode": -1, "offset": 0}, True)
            self.assertEqual(data, b"rotated\n")
            with patch.object(audit_ship, "MAX_READ", 6):
                log.write_bytes(b"ab\ncd\nef\n")
                data, position, more = audit_ship.read_new(log, None, False)
                self.assertEqual((data, position["offset"], more), (b"ab\ncd\n", 6, True))
                log.write_bytes(b"abcdefgh\n")
                data, position, more = audit_ship.read_new(log, None, False)
                self.assertEqual((data, more), (b"abcdef", True))
            with patch.object(audit_ship, "MAX_READ", 60):
                # A size-limited read stops before the last event so its PATH records stay with it.
                log.write_bytes(b"type=A msg=audit(1.0:7): x\ntype=B msg=audit(1.0:8): y\ntype=C msg=audit(1.0:8): z\n")
                data, position, more = audit_ship.read_new(log, None, False, audit_ship.audit_group_start)
                self.assertEqual((data, more), (b"type=A msg=audit(1.0:7): x\n", True))

    def test_ship_batches_and_retries_against_fake_sink(self):
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), FakeSink)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        FakeSink.requests = []
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            token = root / "token"
            token.write_text("write-only-token\n")
            auth_log = root / "auth.log"
            line = "2026-10-22T22:43:54+00:00 web-1 sudo:  deploy : PWD=/ ; USER=root ; COMMAND=/bin/true\n"
            auth_log.write_text(line * 501)
            audit_log = root / "audit.log"
            audit_log.write_text('type=SYSCALL msg=audit(1.0:1): uid=0 key="persistence"\n')
            sources = [
                ("auth", auth_log, lambda lines: audit_ship.parse_auth_lines(lines, "h", {}), False, None),
                ("audit", audit_log, lambda lines: audit_ship.parse_audit_lines(lines, "h"), True, audit_ship.audit_group_start),
            ]
            state_path = root / "state.json"
            send = audit_ship.sender("http://127.0.0.1:%d/ingest" % server.server_port, token)
            FakeSink.status = 500
            with self.assertRaises(urllib.error.HTTPError):
                audit_ship.ship_once(sources, state_path, {}, send)
            self.assertFalse(state_path.exists())
            FakeSink.status = 200
            FakeSink.requests = []
            state = audit_ship.load_state(state_path)
            self.assertFalse(audit_ship.ship_once(sources, state_path, state, send))
            self.assertEqual([len(body) for _, body in FakeSink.requests], [500, 1])
            self.assertEqual({header for header, _ in FakeSink.requests}, {"Bearer write-only-token"})
            saved = audit_ship.load_state(state_path)
            self.assertEqual(saved["auth"]["offset"], len(line) * 501)
            # The first audit pass starts at the end of the existing log.
            self.assertEqual(saved["audit"]["offset"], audit_log.stat().st_size)
            with audit_log.open("a") as output:
                output.write('type=SYSCALL msg=audit(2.0:2): uid=0 key="persistence"\n')
            FakeSink.requests = []
            audit_ship.ship_once(sources, state_path, saved, send)
            self.assertEqual([body[0]["watch"] for _, body in FakeSink.requests], ["persistence"])

    def test_heartbeat_settings_and_event(self):
        self.assertEqual(audit_ship.heartbeat_seconds(""), 3 * 60 * 60)
        self.assertEqual(audit_ship.heartbeat_seconds("600"), 600)
        with self.assertRaises(ValueError):
            audit_ship.heartbeat_seconds("10")
        event = audit_ship.heartbeat_event("h", 0)
        self.assertEqual(
            event,
            {
                "_time": "1970-01-01T00:00:00Z",
                "host": "h",
                "source": "shipper",
                "event": "shipper.heartbeat",
                "message": "Audit shipper heartbeat",
            },
        )

    def test_redirects_are_not_followed(self):
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), FakeSink)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        FakeSink.requests = []
        with tempfile.TemporaryDirectory() as directory:
            token = Path(directory) / "token"
            token.write_text("write-only-token")
            send = audit_ship.sender("http://127.0.0.1:%d/ingest" % server.server_port, token)
            FakeSink.status = 302
            try:
                with self.assertRaises(urllib.error.HTTPError):
                    send([{"event": "su"}])
            finally:
                FakeSink.status = 200
            self.assertEqual(len(FakeSink.requests), 1)

    def test_sink_must_use_https_off_loopback(self):
        audit_ship.check_sink_url("https://ingest.example.com/v1/events")
        audit_ship.check_sink_url("http://localhost:8080/")
        with self.assertRaises(ValueError):
            audit_ship.check_sink_url("http://ingest.example.com/v1/events")


class ServiceHealthTests(unittest.TestCase):
    def test_missing_stopped_and_unhealthy_services_fail(self):
        self.assertEqual(service_health.service_failures([]), ["api container is missing", "worker container is missing"])
        rows = [{"service": "api", "state": "running", "health": "healthy"}, {"service": "worker", "state": "running", "health": "unhealthy"}]
        self.assertEqual(service_health.service_failures(rows), ["worker has no healthy running container"])
        rows[1]["state"] = "exited"
        rows[1]["health"] = "healthy"
        self.assertEqual(len(service_health.service_failures(rows)), 1)

    def test_rolling_replacement_accepts_one_healthy_replica(self):
        rows = [{"service": "api", "state": "running", "health": "healthy"}, {"service": "worker", "state": "exited", "health": ""}, {"service": "worker", "state": "running", "health": "healthy"}]
        self.assertEqual(service_health.service_failures(rows), [])

    def test_point_in_time_recovery_is_checked_only_when_enabled(self):
        healthy = [{"service": "api", "state": "running", "health": "healthy"}, {"service": "worker", "state": "running", "health": "healthy"}]
        self.assertEqual(service_health.service_failures(healthy), [])
        stalled = [*healthy, {"service": "pitr", "state": "running", "health": "unhealthy"}]
        self.assertEqual(service_health.service_failures(stalled), ["pitr has no healthy running container"])
        stalled[2]["health"] = "healthy"
        self.assertEqual(service_health.service_failures(stalled), [])


class AlertTests(unittest.TestCase):
    def test_change_dedup_recovery_and_failed_delivery(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = root / "config.json"
            config.write_text(
                json.dumps(
                    {"slack_webhook": "https://hooks.slack.com/services/example"}
                )
            )
            response = MagicMock()
            response.__enter__.return_value.status = 200
            response.__enter__.return_value.read.return_value = b"ok"
            with patch.object(
                alerts.urllib.request, "urlopen", return_value=response
            ) as send:
                emit = lambda text: alerts.notify("disk", text, config, root / "state")
                emit("")
                self.assertEqual(send.call_count, 0)
                emit("Disk full")
                emit("Disk full")
                self.assertEqual(send.call_count, 1)
                emit("")
                self.assertEqual(send.call_count, 2)
                emit("")
                self.assertEqual(send.call_count, 2)
                send.side_effect = OSError("offline")
                with self.assertRaises(OSError):
                    emit("Backup failed")
                send.side_effect = None
                emit("Backup failed")
                self.assertEqual(send.call_count, 4)

    def test_missing_webhook_uses_journal_without_network(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with (
                patch.object(alerts.urllib.request, "urlopen") as send,
                contextlib.redirect_stdout(io.StringIO()) as output,
            ):
                alerts.notify("disk", "Low space", root / "absent.json", root / "state")
                alerts.notify("disk", "Low space", root / "absent.json", root / "state")
                self.assertEqual(output.getvalue().count("Rakazo alert: Low space"), 1)
                send.assert_not_called()

    def test_concurrent_calls_deliver_once(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            response = MagicMock()
            response.__enter__.return_value.status = 200
            response.__enter__.return_value.read.return_value = b"ok"
            config = root / "config.json"
            config.write_text(
                json.dumps(
                    {"slack_webhook": "https://hooks.slack.com/services/example"}
                )
            )

            def slow_send(*args, **kwargs):
                time.sleep(0.05)
                return response

            with patch.object(
                alerts.urllib.request, "urlopen", side_effect=slow_send
            ) as send:
                with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
                    list(
                        pool.map(
                            lambda _: alerts.notify(
                                "disk", "Low space", config, root / "state"
                            ),
                            range(4),
                        )
                    )
                self.assertEqual(send.call_count, 1)
                self.assertEqual(list((root / "state").glob("*.tmp")), [])

    def test_daily_reminder(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = root / "config.json"
            config.write_text(
                json.dumps(
                    {"slack_webhook": "https://hooks.slack.com/services/example"}
                )
            )
            response = MagicMock()
            response.__enter__.return_value.status = 200
            response.__enter__.return_value.read.return_value = b"ok"
            with patch.object(
                alerts.urllib.request, "urlopen", return_value=response
            ) as send:
                with patch.object(alerts.time, "time", return_value=100000):
                    alerts.notify("disk", "Low space", config, root / "state")
                with patch.object(alerts.time, "time", return_value=186401):
                    alerts.notify("disk", "Low space", config, root / "state")
                self.assertEqual(send.call_count, 2)


class FirewallTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.etc = self.root / "etc"
        (self.etc / "ufw").mkdir(parents=True)
        (self.etc / "default").mkdir()
        self.defaults = self.etc / "default/ufw"
        self.defaults.write_text('DEFAULT_OUTPUT_POLICY="DROP"\n')
        self.rules = self.etc / "ufw/user.rules"
        self.rules.write_text("original rules\n")
        self.state = self.root / "state"
        self.bin = self.root / "bin"
        self.bin.mkdir()
        for name, script in {
            "df": 'printf "Filesystem Blocks Used Available Capacity Mounted\\n/dev/fake 1000000 0 ${FAKE_FREE:-900000} 0%% /\\n"',
            "systemd-run": 'test "${FAIL_SCHEDULE:-0}" != 1 && test ! -e "$TIMER_STATE" && touch "$TIMER_STATE"',
            "systemctl": 'if [[ "$1" == show ]]; then [[ "${FAIL_SHOW:-0}" != 1 ]] || exit 1; echo "${TIMER_STATUS:-active}"; elif [[ "$1" == stop ]]; then [[ "${FAIL_STOP:-0}" != 1 ]] || exit 1; rm -f "$TIMER_STATE"; fi',
            "ufw": 'echo "$*" >> "$UFW_LOG"; if [[ "$1" == status && "${WAS_ENABLED:-1}" == 1 ]]; then echo "Status: active"; elif [[ "$1" == status ]]; then echo "Status: inactive"; fi',
            "logger": "exit 0",
        }.items():
            executable = self.bin / name
            executable.write_text("#!/bin/bash\n" + script + "\n")
            executable.chmod(0o755)
        source = (ROOT / "firewall-change.sh").read_text()
        source = source.replace('[[ "${EUID}" == 0 ]]', "true")
        source = source.replace(
            "STATE=/var/lib/rakazo/firewall-change", "STATE=" + str(self.state)
        )
        source = source.replace("df -Pk /etc/ufw", "df -Pk " + str(self.etc / "ufw"))
        source = source.replace("-C /etc", "-C " + str(self.etc))
        self.script = self.root / "firewall-change"
        self.script.write_text(source)
        self.script.chmod(0o755)
        self.env = {
            **os.environ,
            "PATH": str(self.bin) + ":" + os.environ["PATH"],
            "SSH_CONNECTION": "client 1 server 22",
            "UFW_LOG": str(self.root / "ufw.log"),
            "TIMER_STATE": str(self.root / "timer"),
        }

    def run_guard(self, *args, **env):
        return subprocess.run(
            [str(self.script), *args],
            env={**self.env, **env},
            capture_output=True,
            text=True,
        )

    def apply(self):
        result = self.run_guard(
            "apply", "bash", "-c", 'echo changed > "$1"', "_", str(self.rules)
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return (self.state / "token").read_text().strip()

    def test_requires_fresh_ssh_connection(self):
        token = self.apply()
        self.assertNotEqual(self.run_guard("confirm", token).returncode, 0)
        self.assertEqual(
            self.run_guard(
                "confirm", token, SSH_CONNECTION="client 2 server 22"
            ).returncode,
            0,
        )
        self.assertFalse((self.state / "token").exists())
        self.assertEqual(self.rules.read_text(), "changed\n")

    def test_rollback_restores_rules_and_rejects_wrong_token(self):
        token = self.apply()
        self.defaults.write_text('DEFAULT_OUTPUT_POLICY="ACCEPT"\n')
        self.assertNotEqual(self.run_guard("rollback", "wrong-token").returncode, 0)
        result = self.run_guard("rollback", token)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.rules.read_text(), "original rules\n")
        self.assertEqual(self.defaults.read_text(), 'DEFAULT_OUTPUT_POLICY="DROP"\n')
        self.assertFalse((self.state / "token").exists())

    def test_apply_requires_connection_identity(self):
        result = self.run_guard("apply", "true", SSH_CONNECTION="")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.state / "token").exists())
        self.assertFalse((self.root / "timer").exists())

    def test_rollback_waits_for_operation_lock(self):
        token = self.apply()
        with (self.state / "lock").open("w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            process = subprocess.Popen(
                [str(self.script), "rollback", token],
                env=self.env,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            try:
                time.sleep(0.15)
                self.assertIsNone(process.poll())
            finally:
                fcntl.flock(lock, fcntl.LOCK_UN)
            _, stderr = process.communicate(timeout=5)
            self.assertEqual(process.returncode, 0, stderr)
        self.assertEqual(self.rules.read_text(), "original rules\n")

    def test_failed_timer_cleanup_preserves_pending_token(self):
        token = self.apply()
        for overrides in ({"TIMER_STATUS": "active"}, {"FAIL_SHOW": "1"}):
            result = self.run_guard("rollback", token, FAIL_STOP="1", **overrides)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual((self.state / "token").read_text().strip(), token)
            self.assertNotEqual(self.run_guard("apply", "true").returncode, 0)
        self.assertEqual(self.run_guard("rollback", token).returncode, 0)
        self.assertFalse((self.state / "token").exists())

    def test_failed_stop_with_known_inactive_timer_allows_cleanup(self):
        token = self.apply()
        result = self.run_guard(
            "rollback", token, FAIL_STOP="1", TIMER_STATUS="inactive"
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((self.state / "token").exists())

    def test_hardening_rejects_missing_identity_before_host_changes(self):
        source = (
            (ROOT / "harden-host.sh")
            .read_text()
            .replace('[[ "${EUID}" -ne 0 ]]', "false")
        )
        script = self.root / "harden-host"
        script.write_text(source)
        result = subprocess.run(
            ["bash", str(script)],
            env={**self.env, "SSH_CONNECTION": ""},
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn("SSH_CONNECTION is required", result.stderr)
        self.assertNotIn("Deploy user", result.stderr)
        self.assertEqual(result.stdout, "")

    def test_manual_rollback_allows_another_guarded_change(self):
        first = self.apply()
        self.assertEqual(self.run_guard("rollback", first).returncode, 0)
        second = self.apply()
        self.assertEqual(self.run_guard("rollback", second).returncode, 0)

    def test_rollback_restores_disabled_state(self):
        self.env["WAS_ENABLED"] = "0"
        token = self.apply()
        self.assertEqual(self.run_guard("rollback", token).returncode, 0)
        self.assertIn("--force disable", (self.root / "ufw.log").read_text())

    def test_no_edit_when_timer_cannot_be_scheduled(self):
        result = self.run_guard(
            "apply",
            "bash",
            "-c",
            'echo unsafe > "$1"',
            "_",
            str(self.rules),
            FAIL_SCHEDULE="1",
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.rules.read_text(), "original rules\n")

    def test_refuses_full_disk_and_overlapping_changes(self):
        self.assertNotEqual(
            self.run_guard("apply", "true", FAKE_FREE="1").returncode, 0
        )
        self.apply()
        self.assertNotEqual(self.run_guard("apply", "true").returncode, 0)


class HostCheckTests(unittest.TestCase):
    def test_missing_backup_directory_still_sends_alert_and_custom_port_is_used(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bin_dir = root / "bin"
            bin_dir.mkdir()
            backups = root / "backups"
            backups.mkdir()
            rules = root / "user.rules"
            rules.write_text(
                "### tuple ### limit tcp 2222 0.0.0.0/0 any 0.0.0.0/0 in\n"
            )
            alert_log = root / "alert.log"
            commands = {
                "df": 'echo "Filesystem Blocks Used Available Capacity Mounted"; echo "/dev/fake 100000000 0 40000000 20% /"',
                "mountpoint": "exit 0",
                "stat": 'if [[ "$3" == / ]]; then echo 1; else echo 2; fi',
                "systemctl": "exit 1",
                "sshd": 'echo "port 2222"',
                "nproc": "echo 4",
                "alert": 'echo "$*" >> "$ALERT_LOG"; if (($# < 2)); then cat >> "$ALERT_LOG"; fi',
            }
            for name, command in commands.items():
                executable = bin_dir / name
                executable.write_text("#!/bin/bash\n" + command + "\n")
                executable.chmod(0o755)
            source = (ROOT / "check-host.sh").read_text()
            source = source.replace("/var/backups", str(backups))
            source = source.replace("/etc/ufw/user.rules", str(rules))
            audit_env = root / "audit-ship.env"
            source = source.replace("/etc/rakazo/audit-ship.env", str(audit_env))
            source = source.replace("/usr/sbin/sshd", str(bin_dir / "sshd"))
            reboot_required = root / "reboot-required"
            source = source.replace("/run/reboot-required", str(reboot_required))
            loadavg = root / "loadavg"
            loadavg.write_text("0.50 0.50 0.50 1/100 1\n")
            source = source.replace("/proc/loadavg", str(loadavg))
            pressure = root / "pressure-cpu"
            source = source.replace("/proc/pressure/cpu", str(pressure))
            meminfo = root / "meminfo"
            healthy_memory = (
                "MemTotal: 8000000 kB\nMemAvailable: 4000000 kB\n"
                "SwapTotal: 4000000 kB\nSwapFree: 4000000 kB\n"
            )
            meminfo.write_text(healthy_memory)
            source = source.replace("/proc/meminfo", str(meminfo))
            source = source.replace(
                "/usr/local/sbin/rakazo-host-alert", str(bin_dir / "alert")
            )
            script = root / "check.sh"
            script.write_text(source)
            env = {
                **os.environ,
                "PATH": str(bin_dir) + ":" + os.environ["PATH"],
                "ALERT_LOG": str(alert_log),
            }
            result = subprocess.run(
                ["bash", str(script)], env=env, capture_output=True, text=True
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("No verified backup completed", alert_log.read_text())
            self.assertNotIn("SSH allow rule is missing", alert_log.read_text())
            (backups / "rakazo" / "20261020T000000Z").mkdir(parents=True)
            (backups / "rakazo" / "20261020T000000Z" / "SHA256SUMS").write_text(
                "verified"
            )
            result = subprocess.run(
                ["bash", str(script)], env=env, capture_output=True, text=True
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            # A plaintext latest snapshot alerts until it is encrypted or explicitly allowed.
            plaintext = backups / "rakazo" / "20261020T000000Z" / "rakazo.dump"
            plaintext.write_text("dump")
            result = subprocess.run(
                ["bash", str(script)], env=env, capture_output=True, text=True
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("latest backup is not encrypted", alert_log.read_text())
            result = subprocess.run(
                ["bash", str(script)],
                env={**env, "RAKAZO_BACKUP_ALLOW_PLAINTEXT": "1"},
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            plaintext.unlink()
            reboot_required.touch()
            result = subprocess.run(
                ["bash", str(script)], env=env, capture_output=True, text=True
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("need a reboot", alert_log.read_text())
            reboot_required.unlink()
            # Without pressure information, a load above the core count alerts.
            loadavg.write_text("6.00 5.50 5.00 1/100 1\n")
            result = subprocess.run(
                ["bash", str(script)], env=env, capture_output=True, text=True
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("CPU is overloaded", alert_log.read_text())
            # With it, a high load alone does not: only work waiting for a core does.
            alert_log.write_text("")
            pressure.write_text(
                "some avg10=30.00 avg60=25.00 avg300=24.00 total=1\n"
                "full avg10=0.00 avg60=0.00 avg300=0.00 total=0\n"
            )
            result = subprocess.run(
                ["bash", str(script)], env=env, capture_output=True, text=True
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            pressure.write_text(
                "some avg10=80.00 avg60=70.00 avg300=65.00 total=1\n"
                "full avg10=0.00 avg60=0.00 avg300=0.00 total=0\n"
            )
            result = subprocess.run(
                ["bash", str(script)], env=env, capture_output=True, text=True
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("CPU is overloaded", alert_log.read_text())
            pressure.unlink()
            loadavg.write_text("0.50 0.50 0.50 1/100 1\n")
            meminfo.write_text(
                "MemTotal: 8000000 kB\nMemAvailable: 500000 kB\n"
                "SwapTotal: 4000000 kB\nSwapFree: 4000000 kB\n"
            )
            result = subprocess.run(
                ["bash", str(script)], env=env, capture_output=True, text=True
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Memory is low", alert_log.read_text())
            meminfo.write_text(
                "MemTotal: 8000000 kB\nMemAvailable: 4000000 kB\n"
                "SwapTotal: 4000000 kB\nSwapFree: 2000000 kB\n"
            )
            alert_log.write_text("")
            result = subprocess.run(
                ["bash", str(script)], env=env, capture_output=True, text=True
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Memory is low", alert_log.read_text())
            meminfo.write_text(healthy_memory)
            rules.write_text(
                "### tuple ### allow any 2222 0.0.0.0/0 any 0.0.0.0/0 in\n"
            )
            result = subprocess.run(
                ["bash", str(script)], env=env, capture_output=True, text=True
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            # A failed recovery delivery must not skip subsequent checks or their alert.
            alert = bin_dir / "alert"
            original_alert = alert.read_text()
            alert.write_text(original_alert + '\n[[ "$1" != backup-failure ]]\n')
            rules.write_text("")
            alert_log.write_text("")
            result = subprocess.run(
                ["bash", str(script)], env=env, capture_output=True, text=True
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(
                "Could not deliver backup recovery notification", alert_log.read_text()
            )
            self.assertIn("SSH allow rule is missing", alert_log.read_text())
            alert.write_text(original_alert)
            rules.write_text(
                "### tuple ### allow any 2222 0.0.0.0/0 any 0.0.0.0/0 in\n"
            )
            (bin_dir / "mountpoint").write_text("#!/bin/bash\nexit 1\n")
            result = subprocess.run(
                ["bash", str(script)], env=env, capture_output=True, text=True
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            result = subprocess.run(
                ["bash", str(script)],
                env={**env, "RAKAZO_BACKUP_REQUIRE_VOLUME": "1"},
                capture_output=True,
                text=True,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(
                "Backup volume is not mounted separately", alert_log.read_text()
            )
            # A configured audit sink alerts while its shipper is not running.
            audit_env.write_text("RAKAZO_AUDIT_SINK_URL=https://ingest.example.com/v1\n")
            result = subprocess.run(
                ["bash", str(script)], env=env, capture_output=True, text=True
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Audit trail shipping is not running", alert_log.read_text())
            (bin_dir / "systemctl").write_text('#!/bin/bash\n[[ "$1" == is-active ]]\n')
            result = subprocess.run(
                ["bash", str(script)], env=env, capture_output=True, text=True
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            (bin_dir / "sshd").write_text("#!/bin/bash\nexit 1\n")
            (bin_dir / "df").write_text("#!/bin/bash\nexit 1\n")
            result = subprocess.run(
                ["bash", str(script)], env=env, capture_output=True, text=True
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Could not inspect storage", alert_log.read_text())
            self.assertIn("Could not inspect SSH configuration", alert_log.read_text())


if __name__ == "__main__":
    unittest.main()
