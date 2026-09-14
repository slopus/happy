// A credential-free stand-in for a Happy owner and its Codex app-server child.
const { spawn } = require('node:child_process');
const backend = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', env: {} });
process.send({ backendPid: backend.pid });
process.on('SIGTERM', () => process.send({ stopping: true }));
const finish = () => {
  if (backend.exitCode !== null || backend.signalCode !== null) process.exit(0);
  backend.once('exit', () => process.exit(0));
  backend.kill('SIGTERM');
};
process.on('message', (message) => { if (message === 'finish') finish(); });
process.on('disconnect', finish);