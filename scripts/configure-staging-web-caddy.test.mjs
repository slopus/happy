import assert from 'node:assert/strict';
import test from 'node:test';
import {
    configureStagingWebCaddy,
    STAGING_WEB_BLOCK_START,
    STAGING_WEB_BLOCK_END,
} from './configure-staging-web-caddy.mjs';

const production = `47.115.228.20:8443 {
    reverse_proxy 100.116.134.122:3305
}
`;

test('adds one complete same-origin staging site and preserves production verbatim', () => {
    const result = configureStagingWebCaddy(production);
    assert.ok(result.startsWith(production));
    assert.match(result, /47\.115\.228\.20:8444 \{/);
    assert.match(result, /tls \/etc\/caddy\/ip-letsencrypt-fullchain\.pem \/etc\/caddy\/ip-letsencrypt-key\.pem/);
    assert.match(result, /@backend path \/v1\/\* \/v2\/\* \/v3\/\* \/v4\/\* \/files\/\* \/health \/socket\.io\/\* \/socket\/\*/);
    assert.match(result, /root \* \/var\/www\/paws-web-staging\/current/);
    assert.match(result, /try_files \{path\} \/index\.html/);
    assert.match(result, /X-Robots-Tag "noindex, nofollow, noarchive"/);
    assert.match(result, /@paws_agent_party_api path \/agent-party\/api\/\*/);
    assert.match(result, /@party_invalid_origin \{\s+path \/agent-party\/api\/\* \/agent-party\/revision\s+header Origin \*\s+not header Origin https:\/\/47\.115\.228\.20:8444/s);
    assert.match(result, /@party_missing_mutation_origin \{\s+path \/agent-party\/api\/\* \/agent-party\/revision\s+method POST PATCH PUT DELETE\s+not header Origin https:\/\/47\.115\.228\.20:8444/s);
    assert.match(result, /header_up Host 47\.115\.228\.20:8443/);
    assert.match(result, /header_up Origin https:\/\/47\.115\.228\.20:8443/);
    assert.match(result, /@paws_agent_party_assets path \/agent-party\/assets\/\*/);
    assert.match(result, /try_files \{path\} \/agent-party\/index\.html/);
    assert.match(result, /@public_session_share path \/share\/\*/);
    assert.match(result, /Content-Security-Policy .*frame-ancestors 'none'/);
    assert.match(result, /@static_asset path \/_expo\/\* \/assets\/\* \/desktop-skins\/\*/);
    assert.match(result, /@immutable_static path \/_expo\/\* \/assets\/\* \/desktop-skins\/\* \/agent-party\/assets\/\*/);
    assert.match(result, /header @immutable_static Cache-Control "public, max-age=31536000, immutable" \{\s+match status 2xx\s+\}/);
    assert.match(result, /handle @static_asset \{\s+root \* \/var\/www\/paws-web-staging\/current\s+file_server/s);
    assert.equal(configureStagingWebCaddy(result), result);
});

test('refuses a partial, altered, duplicated, or unmanaged staging site', () => {
    assert.throws(() => configureStagingWebCaddy(`${production}${STAGING_WEB_BLOCK_START}\n`), /incomplete/);
    assert.throws(() => configureStagingWebCaddy(`${production}example:8444 {\n}\n`), /already used/);
    const configured = configureStagingWebCaddy(production);
    assert.throws(() => configureStagingWebCaddy(configured.replace('encode zstd gzip', 'encode gzip')), /differs/);
    assert.throws(() => configureStagingWebCaddy(`${configured}\n${STAGING_WEB_BLOCK_END}`), /incomplete or duplicated/);
});
