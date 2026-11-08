// The voice call's hosted client tools (docs/agent-voice-call.md, "Client
// tools") against ElevenLabs. The doc is the only copy of each tool: its
// ```json block, and its ID from the table of v3's tools.
//
//   ELEVENLABS_API_KEY=… node scripts/voice-tool.cjs <tool> [--dry-run]
//   ELEVENLABS_API_KEY=… node scripts/voice-tool.cjs <tool> --apply
//
// --dry-run, the default, reads the hosted tool and prints how it differs
// from the doc; it changes nothing. --apply first checks that the tool is
// used by v3 alone, then PATCHes it with the doc's description, parameters,
// expects_response and response_timeout_secs, every other setting as it was
// (execution_mode, pre_tool_speech and the rest); then reads it again and
// fails unless it is the doc's word for word and the rest unchanged. It never
// touches the agent: no tool_ids, nothing else. A tool's edit reaches every
// build calling its agent at once (the doc's "A tool is edited in place").
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DOC = path.join(ROOT, 'docs/agent-voice-call.md');
const API = 'https://api.elevenlabs.io/v1/convai/tools';
const V3_AGENT = 'agent_4801m6sgvwc9ffmvdz4x8evst1se';
/** The settings the doc holds; every other one of the hosted tool's is left as it is. */
const DOC_KEYS = ['type', 'name', 'description', 'expects_response', 'response_timeout_secs', 'parameters'];

/** The doc's client tools by name, each its ```json block under "### Client tools", parsed. */
function docTools(markdown) {
  const start = markdown.indexOf('\n### Client tools');
  if (start < 0) throw new Error('No "### Client tools" section in the doc');
  const end = markdown.indexOf('\n### ', start + 1);
  const section = markdown.slice(start, end < 0 ? undefined : end);
  const tools = {};
  for (const match of section.matchAll(/```json\n([\s\S]*?)\n```/g)) {
    const tool = JSON.parse(match[1]);
    if (tool.type === 'client' && typeof tool.name === 'string') tools[tool.name] = tool;
  }
  return tools;
}

/** v3's tool IDs by name, from the table after the doc's "Happy Agent v3public". */
function docToolIds(markdown) {
  const start = markdown.indexOf('**"Happy Agent v3public"**');
  if (start < 0) throw new Error('No "Happy Agent v3public" in the doc');
  const end = markdown.indexOf('\n\n', markdown.indexOf('| Tool | ID |', start));
  const ids = {};
  for (const match of markdown.slice(start, end).matchAll(/^\| (\w+) \| `(tool_\w+)` \|$/gm)) ids[match[1]] = match[2];
  return ids;
}

/**
 * The hosted tool_config as the doc writes a tool: its keys alone, and each
 * parameter's type and description (ElevenLabs adds an empty description and
 * its own defaults to `parameters`, which the doc leaves out).
 */
function asDoc(config) {
  const parameters = config.parameters ?? {};
  const properties = {};
  for (const [name, property] of Object.entries(parameters.properties ?? {})) {
    properties[name] = { type: property.type, description: property.description };
  }
  const tool = {};
  for (const key of DOC_KEYS) tool[key] = config[key];
  tool.parameters = { type: parameters.type, properties, required: parameters.required ?? [] };
  return tool;
}

/** The PATCH body: the hosted config, the doc's settings in place of its own. */
function patched(config, doc) {
  const properties = {};
  for (const [name, property] of Object.entries(doc.parameters.properties)) {
    properties[name] = { type: property.type, description: property.description };
  }
  return {
    tool_config: {
      ...config,
      description: doc.description,
      expects_response: doc.expects_response,
      response_timeout_secs: doc.response_timeout_secs,
      parameters: { type: 'object', description: '', properties, required: doc.parameters.required },
    },
  };
}

/** Keys sorted, so that only content counts; arrays keep their order. */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

/** A line diff of two values as indented JSON, `-` the hosted's, `+` the doc's; empty when they are the same. */
function diff(hosted, doc) {
  const a = JSON.stringify(canonical(hosted), null, 2).split('\n');
  const b = JSON.stringify(canonical(doc), null, 2).split('\n');
  const lcs = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const lines = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      lines.push('  ' + a[i]); i++; j++;
    } else if (j < b.length && (i === a.length || lcs[i][j + 1] >= lcs[i + 1][j])) {
      lines.push('+ ' + b[j]); j++;
    } else {
      lines.push('- ' + a[i]); i++;
    }
  }
  return lines.some((line) => line[0] !== ' ') ? lines.join('\n') : '';
}

/** The settings outside the doc's that differ between two hosted configs, by name. */
function othersChanged(before, after) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((key) => !DOC_KEYS.includes(key)
    && JSON.stringify(canonical(before[key])) !== JSON.stringify(canonical(after[key])));
}

async function request(method, url, key, body) {
  const response = await fetch(url, {
    method,
    headers: { 'xi-api-key': key, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${url}: ${response.status} ${text}`);
  return JSON.parse(text);
}

async function main(argv) {
  const name = argv.find((arg) => !arg.startsWith('--'));
  const apply = argv.includes('--apply');
  const unknown = argv.filter((arg) => arg.startsWith('--') && arg !== '--apply' && arg !== '--dry-run');
  if (!name || unknown.length || (apply && argv.includes('--dry-run'))) {
    throw new Error('Usage: node scripts/voice-tool.cjs <tool> [--dry-run | --apply]');
  }
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error('Set ELEVENLABS_API_KEY');
  const markdown = fs.readFileSync(DOC, 'utf8');
  const doc = docTools(markdown)[name];
  const id = docToolIds(markdown)[name];
  if (!doc || !id) throw new Error(`The doc has no v3 client tool ${name}`);

  const before = (await request('GET', `${API}/${id}`, key)).tool_config;
  const changes = diff(asDoc(before), doc);
  console.log(changes ? `${name} (${id}), - hosted + doc:\n${changes}` : `${name} (${id}) is the doc's, word for word.`);
  if (!apply || !changes) return;

  const dependents = await request('GET', `${API}/${id}/dependent-agents`, key);
  const agents = (dependents.agents ?? []).map((agent) => agent.id);
  if (agents.length !== 1 || agents[0] !== V3_AGENT || dependents.has_more) {
    throw new Error(`${name} is used by ${agents.join(', ') || 'no agent'}, not v3 (${V3_AGENT}) alone; not changed`);
  }
  await request('PATCH', `${API}/${id}`, key, patched(before, doc));
  const after = (await request('GET', `${API}/${id}`, key)).tool_config;
  const left = diff(asDoc(after), doc);
  const others = othersChanged(before, after);
  if (left) throw new Error(`After the PATCH, ${name} still differs from the doc:\n${left}`);
  if (others.length) throw new Error(`The PATCH changed settings the doc doesn't hold: ${others.join(', ')}`);
  console.log(`Applied: ${name} is now the doc's, word for word; its other settings are as they were.`);
}

module.exports = { docTools, docToolIds, asDoc, patched, diff, othersChanged, main };

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
