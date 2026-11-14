"""Pipe driver for native streaming local mode and live Happy remote takeover."""
import json, os, pathlib, select, signal, subprocess, sys, time

root = pathlib.Path(__file__).resolve().parents[1]
out = pathlib.Path(sys.argv[1]).resolve()
model = sys.argv[2] if len(sys.argv) > 2 else 'opus'
if (out / 'evidence.json').exists():
    raise SystemExit('Choose a fresh output directory for each run')
out.mkdir(parents=True, exist_ok=True)
env = dict(os.environ, TERM='xterm-256color', HAPPY_DISABLE_CAFFEINATE='1')
# Axios already applies these proxy variables. Avoid applying Node's proxy twice.
env.pop('NODE_USE_ENV_PROXY', None)
env['NODE_OPTIONS'] = env.get('NODE_OPTIONS', '').replace('--use-env-proxy', '').strip()
proc = subprocess.Popen(['pnpm', 'exec', 'tsx', '--tsconfig', 'tsconfig.json', 'scripts/validate-remote-model.ts', str(out), model], cwd=root, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True, env=env)
start = time.monotonic()
pending = b''
prompt_at = None
sent = False
try:
    with (out / 'terminal.log').open('wb') as log:
        while proc.poll() is None and time.monotonic() - start < 210:
            if prompt_at and not sent and time.monotonic() >= prompt_at:
                msg = {'type': 'user', 'message': {'role': 'user', 'content': 'Reply with exactly PR1844_LOCAL. Do not call tools.'}, 'parent_tool_use_id': None}
                proc.stdin.write((json.dumps(msg) + '\n').encode()); proc.stdin.flush(); sent = True
            if not select.select([proc.stdout], [], [], 0.3)[0]: continue
            try: chunk = os.read(proc.stdout.fileno(), 65536)
            except OSError: break
            log.write(chunk); log.flush(); pending += chunk
            if b'PR1844_LOCAL_READY' in pending and prompt_at is None: prompt_at = time.monotonic() + 5
            while b'\n' in pending:
                line, pending = pending.split(b'\n', 1)
                try: data = json.loads(line.strip())
                except (ValueError, UnicodeDecodeError): continue
                if data.get('type') == 'result':
                    # Local native stdout only; remote SDK messages are captured in TS.
                    (out / 'local-result.json').write_text(json.dumps(data, indent=2) + '\n')
finally:
    if proc.poll() is None:
        os.killpg(proc.pid, signal.SIGTERM)
        try: proc.wait(timeout=10)
        except subprocess.TimeoutExpired: os.killpg(proc.pid, signal.SIGKILL)
    proc.stdin.close()
    proc.stdout.close()
evidence = out / 'evidence.json'
if evidence.exists():
    data = json.loads(evidence.read_text())
    if data.get('status') == 'running':
        data.update(status='blocked', reason=f'Runner exited before completion (exit={proc.poll()})')
        evidence.write_text(json.dumps(data, indent=2) + '\n')
    print(evidence.read_text())
else: print('No evidence report; inspect terminal.log')
sys.exit(0 if evidence.exists() and json.loads(evidence.read_text()).get('status') == 'passed-headless-live-takeover' else 1)
