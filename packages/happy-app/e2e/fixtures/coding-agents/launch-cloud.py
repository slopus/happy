"""Start an isolated cloud fixture, never the production server."""
import json, os, secrets, subprocess, signal
from pathlib import Path
root = Path(__file__).resolve().parent
server = root / 'server'
log = open(root / 'server.log', 'a', buffering=1)
os.chmod(root / 'server.log', 0o600)
env = {**os.environ, 'HOST': '127.0.0.1', 'PORT': '19465', 'PGLITE_DIR': str(root / 'data/pglite-verified-deps'), 'DATA_DIR': str(root / 'data'), 'DB_PROVIDER': 'pglite', 'NODE_ENV': 'development', 'NODE_OPTIONS': '--max-old-space-size=256', 'HANDY_MASTER_SECRET': secrets.token_hex(32), 'HAPPY_STATIC_DIR': str(root / 'webapp'), 'S3_HOST': '', 'METRICS_ENABLED': 'false', 'HAPPY_INJECT_HTML_CONFIG': json.dumps({'serverUrl': 'http://127.0.0.1:19465'})}
cli = [str(server / 'node_modules/.bin/tsx'), '--tsconfig', str(server / 'tsconfig.json'), str(server / 'sources/standalone.ts')]
migration = subprocess.Popen(cli + ['migrate'], cwd=server, env=env, stdout=log, stderr=log, start_new_session=True)
try:
    migration.wait(timeout=180)
    if migration.returncode:
        raise RuntimeError('Isolated migration failed; inspect server.log')
except subprocess.TimeoutExpired:
    os.killpg(migration.pid, signal.SIGTERM)
    migration.wait(timeout=10)
    raise
process = subprocess.Popen(cli + ['serve'], cwd=server, env=env, stdout=log, stderr=log, start_new_session=True)
(root / 'server.pid').write_text(str(process.pid))
print(json.dumps({'started': True, 'pid': process.pid, 'port': 19465}))
