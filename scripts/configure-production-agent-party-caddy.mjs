import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const START = '# paws-agent-party:start';
const END = '# paws-agent-party:end';
const ADDRESS = '47.115.228.20:8443';

export function configureProductionAgentPartyCaddy(source) {
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const text = source.replaceAll('\r\n', '\n');
  if (text.includes('\r')) throw Error('Unsupported Caddyfile line endings');
  // Structural braces are standalone tokens; placeholders and quoted strings
  // must not change nesting depth. Fail closed for unsupported heredocs.
  const tokens = [...text.matchAll(/"(?:\\.|[^"\\])*"|`[^`]*`|#[^\n]*|[^\s]+/gu)]
    .filter(match => !match[0].startsWith('#'));
  let depth = 0; const sites = []; let opening;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token[0].startsWith('<<')) throw Error('Unsupported Caddyfile heredoc');
    if (token[0] === '{') {
      if (depth === 0 && tokens[index - 1]?.[0] === ADDRESS) { opening = token.index; sites.push({ opening }); }
      depth++;
    } else if (token[0] === '}') {
      depth--; if (depth < 0) throw Error('Unbalanced Caddyfile');
      if (depth === 0 && opening !== undefined) { sites.at(-1).closing = token.index; opening = undefined; }
    }
  }
  if (depth !== 0 || sites.length !== 1) throw Error('Exactly one standalone canonical site is required');
  const site = sites[0];
  const lineStart = text.lastIndexOf('\n', site.opening) + 1;
  const contentStart = text.indexOf('\n', site.opening) + 1;
  if (text.slice(lineStart, site.opening).trim() !== ADDRESS || contentStart === 0 || text.slice(site.opening + 1, contentStart).trim()) throw Error('Unsupported inline or shared canonical site');
  let body = text.slice(contentStart, site.closing);
  const lines = body.split('\n');
  const starts = lines.flatMap((line, index) => line.trim() === START ? [index] : []);
  const ends = lines.flatMap((line, index) => line.trim() === END ? [index] : []);
  if (starts.length || ends.length) {
    if (starts.length !== 1 || ends.length !== 1 || starts[0] >= ends[0]) throw Error('Incomplete or duplicate AgentParty markers');
    lines.splice(starts[0], ends[0] - starts[0] + 1); body = lines.join('\n');
  }
  if (body.includes('/agent-party') || body.includes('@paws_agent_party')) throw Error('Unmanaged AgentParty route exists');
  const managed = [START, '@paws_agent_party path /agent-party /agent-party/*', 'handle @paws_agent_party {', '    reverse_proxy 127.0.0.1:3847', '}', END].map(line => `    ${line}`).join('\n') + '\n';
  return (text.slice(0, contentStart) + managed + body + text.slice(site.closing)).replaceAll('\n', newline);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) throw Error('Usage: configure-production-agent-party-caddy.mjs <input> <output>');
  const source = await readFile(input, 'utf8'); const result = configureProductionAgentPartyCaddy(source);
  await writeFile(output, result); process.stdout.write(result === source ? 'unchanged\n' : 'changed\n');
}
