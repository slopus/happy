/** Retrieve an explicitly named Account Pool entry through an in-memory pipe. Never log stdout. */
import { spawn } from 'node:child_process';
export function secureOrigin(raw) {
  const url = new URL(raw);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) throw new Error('HTTPS origin required');
  return url.origin;
}
export async function readCredential({ modulePath, platform, entry, python = '/usr/bin/python3' }) {
  if (!modulePath?.startsWith('/') || !/^[a-z0-9-]+$/.test(platform) || !/^[a-z0-9-]+$/.test(entry)) throw new Error('Explicit secure credential reference required');
  return new Promise((ok, fail) => {
    const child = spawn(python, ['-c', 'import sys; sys.path.insert(0,sys.argv[1]); from account_pool import Pool; sys.stdout.write(Pool().get_secret(sys.argv[2],sys.argv[3]))', modulePath, platform, entry], { stdio: ['ignore', 'pipe', 'ignore'] });
    let value = ''; const timer = setTimeout(() => { child.kill('SIGKILL'); fail(new Error('Secure credential read timed out')); }, 15000);
    child.stdout.on('data', chunk => { value += chunk; if (value.length > 16384) child.kill('SIGKILL'); });
    child.on('error', () => { clearTimeout(timer); fail(new Error('Secure credential read failed')); });
    child.on('close', code => { clearTimeout(timer); if (code === 0 && value.length >= 32 && value.length <= 16384) ok(value); else fail(new Error('Secure credential unavailable')); });
  });
}
