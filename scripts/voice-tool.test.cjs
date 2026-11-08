const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { docTools, docToolIds, asDoc, patched, diff, othersChanged, main } = require('./voice-tool.cjs');

const markdown = fs.readFileSync(path.join(__dirname, '../docs/agent-voice-call.md'), 'utf8');
const ID = 'tool_4701m6shq1k0ezv8nvenvjjrtwys';
const V3 = 'agent_4801m6sgvwc9ffmvdz4x8evst1se';

/** readConversation as ElevenLabs gave it on 2026-11-08, before paging: `ref` alone. */
function hosted() {
  return {
    type: 'client',
    name: 'readConversation',
    description: 'Read one conversation before you summarise it: whether it is working or needs the person, its last five turns, when the person last wrote and the agent last replied, its workspace, its model and effort and the ones it can switch to. On a team, who wrote each message. It doesn\'t open the conversation or change the screen.',
    response_timeout_secs: 10,
    disable_interruptions: false,
    interruption_mode: 'allow',
    force_pre_tool_speech: false,
    pre_tool_speech: 'auto',
    assignments: [],
    tool_call_sound: null,
    tool_call_sound_behavior: 'auto',
    tool_error_handling_mode: 'auto',
    parameters: {
      description: '', dynamic_variable: '', is_omitted: false, type: 'object', required: ['ref'],
      properties: {
        ref: {
          type: 'string', description: 'A conversation ref (s1, s2, ...) from the context or listConversations. Never a title.',
          enum: null, is_system_provided: false, dynamic_variable: '', allowed_values: null,
          allowed_values_dynamic_variable: '', constant_value: '', is_omitted: false,
        },
      },
    },
    expects_response: true,
    dynamic_variables: { dynamic_variable_placeholders: {} },
    execution_mode: 'immediate',
  };
}

/** The hosted tool once the doc's is uploaded, as ElevenLabs fills it in. */
function uploaded() {
  const doc = docTools(markdown).readConversation;
  const config = hosted();
  config.description = doc.description;
  config.parameters.properties = Object.fromEntries(Object.entries(doc.parameters.properties).map(([name, property]) =>
    [name, { ...config.parameters.properties.ref, ...property }]));
  return config;
}

test('the doc\'s client tools and v3\'s IDs come from the doc itself', () => {
  const tools = docTools(markdown);
  assert.deepEqual(Object.keys(tools), ['listConversations', 'readConversation', 'message', 'navigate']);
  const read = tools.readConversation;
  assert.deepEqual(Object.keys(read.parameters.properties), ['ref', 'from', 'backTo', 'words']);
  assert.deepEqual(read.parameters.required, ['ref']);
  assert.equal(read.expects_response, true);
  assert.equal(read.response_timeout_secs, 10);
  assert.deepEqual(docToolIds(markdown), {
    listConversations: 'tool_3801m6shq18nf7r9yrqaqdhcpd98',
    readConversation: ID,
    message: 'tool_8401m6shq22yekcaw8watrp77b2t',
    navigate: 'tool_7501m6shq2dcfp4tgqp8te1cth4x',
  });
});

test('the hosted tool before paging differs by its description and the three parameters alone', () => {
  const changes = diff(asDoc(hosted()), docTools(markdown).readConversation);
  const changed = changes.split('\n').filter((line) => line[0] !== ' ');
  assert.equal(changed.filter((line) => line.startsWith('- ')).length, 1);
  assert.match(changed.find((line) => line.startsWith('- ')), /"description": "Read one conversation .*its last five turns, when/);
  for (const name of ['from', 'backTo', 'words']) assert.ok(changed.some((line) => line.includes(`"${name}": {`)), name);
  assert.ok(!changed.some((line) => /required|expects_response|response_timeout_secs|"ref"/.test(line)));
  assert.equal(diff(asDoc(uploaded()), docTools(markdown).readConversation), '');
});

test('the PATCH carries the doc\'s settings and every other one as it was', () => {
  const body = patched(hosted(), docTools(markdown).readConversation);
  const config = body.tool_config;
  assert.equal(config.description, docTools(markdown).readConversation.description);
  assert.deepEqual(config.parameters.required, ['ref']);
  assert.deepEqual(config.parameters.properties.words, docTools(markdown).readConversation.parameters.properties.words);
  assert.deepEqual(othersChanged(hosted(), config), []);
  assert.equal(config.execution_mode, 'immediate');
  assert.equal(config.pre_tool_speech, 'auto');
  assert.deepEqual(othersChanged(hosted(), { ...hosted(), execution_mode: 'async' }), ['execution_mode']);
});

/** main against a fake ElevenLabs: each request in order, with what the tool is after each PATCH. */
async function run(argv, { after = uploaded(), agents = [V3] } = {}) {
  const requests = [];
  let current = hosted();
  const fetch = global.fetch;
  const log = console.log;
  const printed = [];
  global.fetch = async (url, init) => {
    requests.push({ method: init.method, url, body: init.body && JSON.parse(init.body), key: init.headers['xi-api-key'] });
    let value;
    if (init.method === 'PATCH') { current = after; value = { id: ID }; }
    else if (url.endsWith('/dependent-agents')) value = { agents: agents.map((id) => ({ id })), has_more: false };
    else value = { id: ID, tool_config: current };
    return { ok: true, status: 200, text: async () => JSON.stringify(value) };
  };
  console.log = (line) => printed.push(line);
  process.env.ELEVENLABS_API_KEY = 'key';
  try {
    await main(argv);
    return { requests, printed: printed.join('\n') };
  } catch (error) {
    return { requests, printed: printed.join('\n'), error: error.message };
  } finally {
    global.fetch = fetch;
    console.log = log;
  }
}

test('a dry run, the default, only reads and prints the diff', async () => {
  for (const argv of [['readConversation'], ['readConversation', '--dry-run']]) {
    const { requests, printed, error } = await run(argv);
    assert.equal(error, undefined);
    assert.deepEqual(requests.map((r) => `${r.method} ${r.url}`), [`GET https://api.elevenlabs.io/v1/convai/tools/${ID}`]);
    assert.equal(requests[0].key, 'key');
    assert.match(printed, /^readConversation \(tool_4701m6shq1k0ezv8nvenvjjrtwys\), - hosted \+ doc:/);
    assert.match(printed, /\+ {7}"words": \{/);
  }
});

test('apply checks v3 alone uses it, PATCHes, and reads it back as the doc\'s', async () => {
  const { requests, printed, error } = await run(['readConversation', '--apply']);
  assert.equal(error, undefined);
  assert.deepEqual(requests.map((r) => r.method + ' ' + r.url.replace(/.*\/tools\//, '')), [
    `GET ${ID}`, `GET ${ID}/dependent-agents`, `PATCH ${ID}`, `GET ${ID}`,
  ]);
  assert.deepEqual(requests[2].body, patched(hosted(), docTools(markdown).readConversation));
  assert.ok(!requests.some((r) => r.url.includes('/agents/')), 'never the agent');
  assert.match(printed, /Applied: readConversation is now the doc's, word for word/);
});

test('apply refuses a tool other agents use, and fails when the read back isn\'t the doc\'s', async () => {
  const shared = await run(['readConversation', '--apply'], { agents: [V3, 'agent_other'] });
  assert.match(shared.error, /used by .*agent_other.*not changed/);
  assert.ok(!shared.requests.some((r) => r.method === 'PATCH'));
  const short = uploaded();
  delete short.parameters.properties.words;
  assert.match((await run(['readConversation', '--apply'], { after: short })).error, /still differs from the doc:[\s\S]*\+ {7}"words"/);
  assert.match((await run(['readConversation', '--apply'], { after: { ...uploaded(), pre_tool_speech: 'force' } })).error,
    /changed settings the doc doesn't hold: pre_tool_speech/);
  const same = await run(['readConversation', '--apply'], { after: uploaded() });
  assert.equal(same.error, undefined);
});

test('a tool the doc lacks, or an unknown flag, is refused before any request', async () => {
  assert.match((await run(['getSessionContext'])).error, /no v3 client tool getSessionContext/);
  assert.match((await run(['readConversation', '--force'])).error, /Usage/);
  assert.match((await run(['readConversation', '--apply', '--dry-run'])).error, /Usage/);
  assert.equal((await run(['readConversation', '--force'])).requests.length, 0);
});
