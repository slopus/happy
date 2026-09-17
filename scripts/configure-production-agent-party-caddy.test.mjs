import assert from 'node:assert/strict';
import test from 'node:test';
import { configureProductionAgentPartyCaddy } from './configure-production-agent-party-caddy.mjs';

const site = `{
    grace_period 10s
}
47.115.228.20:8443 {
    tls internal
    @backend path /v1/* /health
    handle @backend {
        reverse_proxy 127.0.0.1:3005
    }
    # paws-web-oss:start
    @paws_web_asset path /assets/*
    redir @paws_web_asset https://oss.example{uri} 302
    handle {
        rewrite * /web/current/index.html
        reverse_proxy https://oss.example
    }
    # paws-web-oss:end
}
other.example {
    respond "untouched { text }"
}
`;

test('adds only the AgentParty route and preserves the main OSS and unrelated sites byte-for-byte', () => {
  const result = configureProductionAgentPartyCaddy(site);
  assert.match(result, /handle @paws_agent_party \{\n        reverse_proxy 127\.0\.0\.1:3847/);
  assert.match(result, /@paws_agent_party path \/agent-party \/agent-party\/\*/);
  assert.equal(result.replace(/    # paws-agent-party:start[\s\S]*?    # paws-agent-party:end\n/u, ''), site);
  assert.equal(configureProductionAgentPartyCaddy(result), result);
});
test('refuses missing, duplicate, inline, or unmanaged canonical routes', () => {
  for (const invalid of [site.replace('47.115.228.20:8443', 'other.invalid'), site + site, site.replace('tls internal', 'handle /agent-party/* {\n        respond 200\n    }'), site.replace('tls internal', '# paws-agent-party:start'), '47.115.228.20:8443 { respond 200 }']) {
    assert.throws(() => configureProductionAgentPartyCaddy(invalid));
  }
});
test('ignores cloned markers in a different site and preserves CRLF', () => {
  const configured = configureProductionAgentPartyCaddy(site);
  const clone = configured + configured.replace('47.115.228.20:8443', '127.0.0.1:8081').replace('other.example', 'another.example');
  assert.equal(configureProductionAgentPartyCaddy(clone), clone);
  assert.equal(configureProductionAgentPartyCaddy(site.replaceAll('\n', '\r\n')), configured.replaceAll('\n', '\r\n'));
});
