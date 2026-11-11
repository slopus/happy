// connectRoutes and voiceRoutes with no GitHub or ElevenLabs configuration.
import { login } from './phase2.mjs';

export async function scenario(t) {
    const H = { authorization: 'Bearer ' + (await login(t, 1)) };
    await t.req('github params unconfigured', 'GET', '/v1/connect/github/params', { headers: H });
    await t.req('github callback unconfigured', 'GET', '/v1/connect/github/callback?code=c&state=s');
    await t.req('webhook unconfigured', 'POST', '/v1/connect/github/webhook', { raw: '{}', headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'x', 'x-github-event': 'ping' } });
    await t.req('webhook unconfigured no raw body', 'POST', '/v1/connect/github/webhook', { raw: 'x', headers: { 'content-type': 'text/plain', 'x-hub-signature-256': 'x', 'x-github-event': 'ping' } });
    await t.req('github disconnect unconnected', 'DELETE', '/v1/connect/github', { headers: H });
    await t.req('voice usage unconfigured', 'GET', '/v1/voice/usage', { headers: H });
    await t.req('voice conversation unconfigured', 'POST', '/v1/voice/conversations', { headers: H, body: { agentId: 'a' } });
}
