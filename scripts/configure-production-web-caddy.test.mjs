import assert from 'node:assert/strict';
import test from 'node:test';
import {
    configureProductionWebCaddy,
    PRODUCTION_CADDY_GRACE_PERIOD,
    PUBLIC_SHARE_CADDY_BLOCK_START,
} from './configure-production-web-caddy.mjs';

const fixture = `:8001 {
    respond "other site"
}

47.115.228.20:8443 {
    tls cert key
    @backend path /v1/* /v3/* /v4/* /files/* /share/*
    handle @backend {
        reverse_proxy localhost:3005
    }
    handle {
        root * /var/www/happy-web
        try_files {path} /index.html
        file_server
    }
}
`;

test('routes public shares to the SPA and installs exact public-document headers', () => {
    const configured = configureProductionWebCaddy(fixture);
    assert.match(configured, new RegExp(`^\\{\\n\\tgrace_period ${PRODUCTION_CADDY_GRACE_PERIOD}\\n\\}`, 'm'));
    assert.match(configured, /@backend path \/v1\/\* \/v3\/\* \/v4\/\* \/files\/\*/);
    assert.doesNotMatch(configured, /@backend path[^\n]*\/share\/\*/);
    assert.match(configured, /@public_session_share path \/share\/\*/);
    assert.match(configured, /Cache-Control "no-store"/);
    assert.match(configured, /Content-Security-Policy "default-src 'self'/);
    assert.match(configured, /X-Robots-Tag "noindex, nofollow, noarchive"/);
    assert.match(configured, /X-Content-Type-Options "nosniff"/);
    assert.match(configured, /Referrer-Policy "no-referrer"/);
});

test('bounds an existing eternal grace period so Caddy reloads cannot wait for WebSockets forever', () => {
    const configured = configureProductionWebCaddy(`{
    default_sni 47.115.228.20
    grace_period eternal
}

${fixture}`);

    assert.match(configured, new RegExp(`\\n    grace_period ${PRODUCTION_CADDY_GRACE_PERIOD}\\n`));
    assert.doesNotMatch(configured, /grace_period eternal/);
});

test('is idempotent and leaves unrelated sites untouched', () => {
    const once = configureProductionWebCaddy(fixture);
    const twice = configureProductionWebCaddy(once);
    assert.equal(twice, once);
    assert.equal(twice.match(new RegExp(PUBLIC_SHARE_CADDY_BLOCK_START, 'g'))?.length, 1);
    assert.match(twice, /:8001 \{\n    respond "other site"\n\}/);
});

test('fails closed when the production site matcher is missing', () => {
    assert.throws(() => configureProductionWebCaddy(':8080 {\n}\n'), /site block not found/);
});
