// A minimal ACP agent over stdio for AcpBackend tests.
// FAKE_ACP_ARGV_OUT: file that receives this process's arguments as JSON.
// FAKE_ACP_IGNORE_EOF=1: stay alive after stdin ends, like an agent that must be killed.
// FAKE_ACP_HOLD_PROMPT=1: never answer session/prompt, like an agent that exits on EOF mid-turn.
import { writeFileSync } from 'node:fs';

if (process.env.FAKE_ACP_ARGV_OUT) writeFileSync(process.env.FAKE_ACP_ARGV_OUT, JSON.stringify(process.argv.slice(2)));
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString();
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method === 'initialize') reply(message.id, { protocolVersion: 1, agentCapabilities: {} });
    else if (message.method === 'session/new') reply(message.id, { sessionId: 'fake-session' });
    else if (message.method === 'session/prompt' && process.env.FAKE_ACP_HOLD_PROMPT === '1') continue;
    else if (message.id !== undefined) reply(message.id, {});
  }
});
process.stdin.on('end', () => {
  if (process.env.FAKE_ACP_IGNORE_EOF === '1') setInterval(() => {}, 1000);
  else process.exit(0);
});
