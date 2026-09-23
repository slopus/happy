import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { parse } from 'yaml';

const scriptUrl = new URL('./deploy-agent-party.sh', import.meta.url);
const workflowUrl = new URL('../.github/workflows/agent-party-production-deploy.yml', import.meta.url);
const webWorkflowUrl = new URL('../.github/workflows/web-production-deploy.yml', import.meta.url);

test('deployment and embedded remote shell have valid syntax', async () => {
  const script = await readFile(scriptUrl, 'utf8');
  const remote = script.split("<<'REMOTE_SCRIPT'\n")[1]?.split('\nREMOTE_SCRIPT')[0];
  assert.ok(remote);
  for (const source of [script, remote]) { const result = spawnSync('bash', ['-n'], { input: source, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); }
});

test('wrong origin and weak/missing access token fail before any command or external mutation', () => {
  for (const env of [{ PAWS_WEB_ORIGIN: 'https://example.invalid', PAWS_AGENT_PARTY_ACCESS_TOKEN: 'never-print-this' }, { PAWS_WEB_ORIGIN: 'https://47.115.228.20:8443', PAWS_AGENT_PARTY_ACCESS_TOKEN: 'never-print-this' }]) {
    const result = spawnSync('bash', [scriptUrl.pathname], { encoding: 'utf8', env: { ...process.env, ...env } });
    assert.notEqual(result.status, 0); assert.doesNotMatch(result.stdout + result.stderr, /never-print-this/);
  }
});

test('the companion runs in a separate workflow after a successful Web release', async () => {
  const [workflow, webWorkflow] = await Promise.all([
    readFile(workflowUrl, 'utf8').then(parse),
    readFile(webWorkflowUrl, 'utf8').then(parse),
  ]);
  const steps = workflow.jobs.deploy.steps;
  const index = name => steps.findIndex(step => step.name === name);
  assert.equal(workflow.on.workflow_run.workflows[0], webWorkflow.name);
  assert.deepEqual(workflow.on.workflow_run.types, ['completed']);
  assert.match(workflow.jobs.deploy.if, /workflow_run\.conclusion == 'success'/);
  assert.match(workflow.jobs.deploy.if, /workflow_run\.head_branch == 'main'/);
  assert.match(workflow.jobs.deploy.if, /github\.ref == 'refs\/heads\/main'/);

  const verified = index('Guard exact successful Web release before AgentParty mutation');
  const guard = index('Guard AgentParty deployment secret'); const node = index('Setup Node 24 for AgentParty'); const build = index('Build and stamp standalone AgentParty'); const deploy = index('Deploy and verify AgentParty companion service');
  assert.ok(verified < guard && guard < node && node < build && build < deploy);
  assert.equal(steps[node].with['node-version'], 24);
  assert.match(steps[build].run, /pnpm --filter @wangjs-jacky\/paws-agent build/);
  assert.match(steps[build].run, /PAWS_AGENT_PARTY_STANDALONE=1 PAWS_AGENT_PARTY_BASE_PATH=\/agent-party\//);
  assert.match(steps[build].run, /PAWS_RELEASE_SHA.*packages\/paws-agent-party\/dist\/revision/);
  assert.match(workflow.jobs.deploy.env.PAWS_RELEASE_SHA, /workflow_run\.head_sha/);
  assert.equal(workflow.jobs.deploy.env.PAWS_RELEASE_REF, 'refs/heads/main');
  for (const i of [guard, node, build, deploy]) assert.match(steps[i].if, /steps\.source\.outputs\.eligible == 'true'/);
  assert.equal(steps[deploy].env.PAWS_AGENT_PARTY_ACCESS_TOKEN, '${{ secrets.PAWS_AGENT_PARTY_ACCESS_TOKEN }}');

  const webSteps = webWorkflow.jobs.deploy.steps.map(step => step.name);
  for (const name of ['Guard AgentParty deployment secret', 'Setup Node 24 for AgentParty', 'Build and stamp standalone AgentParty', 'Deploy and verify AgentParty companion service']) {
    assert.equal(webSteps.includes(name), false, `${name} must not block Web deployment`);
  }
});

test('the companion owns an isolated non-root service with durable backup and rollback', async () => {
  const script = await readFile(scriptUrl, 'utf8');
  assert.match(script, /PAWS_RELEASE_SHA/); assert.match(script, /PAWS_RELEASE_REF/);
  assert.match(script, /assert_web_release_is_current/); assert.match(script, /Expected clean worktree/);
  assert.match(script, /com\.paws\.service.*agent-party/); assert.match(script, /Refusing to replace an unowned container/);
  assert.match(script, /--network host --user 1000:1000 --read-only --cap-drop ALL/);
  assert.match(script, /tar -czf "\$backup\/data\.tar\.gz"/);
  assert.match(script, /docker rename "\$previous" "\$container" && docker start/);
  assert.match(script, /mv -- "\$data" "\$backup\/failed-data"/);
  assert.match(script, /\/agent-party\/revision/); assert.match(script, /\/agent-party\/api\/paws\/status.*401/);
  assert.doesNotMatch(script, /docker (?:system|image|volume) prune|rm -rf|set -x/);
});
