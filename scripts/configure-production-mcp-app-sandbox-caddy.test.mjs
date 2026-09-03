import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
    MCP_APP_SANDBOX_CADDY_BLOCK_END,
    MCP_APP_SANDBOX_CADDY_BLOCK_START,
    configureProductionMcpAppSandboxCaddy,
    runConfigureProductionMcpAppSandboxCaddy,
} from './configure-production-mcp-app-sandbox-caddy.mjs';

const source = `{
    grace_period 10s
}

paws.example:8443 {
    respond "paws"
}

sandbox.paws.example {
    # TLS is provisioned automatically by the site address.
}

metrics.example {
    reverse_proxy localhost:9090
}
`;

test('adds an exact-path managed block only inside the provisioned sandbox site', () => {
    const configured = configureProductionMcpAppSandboxCaddy(source, {
        sandboxOrigin: 'https://sandbox.paws.example',
        parentOrigins: ['https://paws.example:8443'],
    });

    assert.match(configured, new RegExp(MCP_APP_SANDBOX_CADDY_BLOCK_START));
    assert.match(configured, new RegExp(MCP_APP_SANDBOX_CADDY_BLOCK_END));
    assert.match(configured, /@paws_mcp_app_host path \/mcp-app-sandbox\/host \/mcp-app-sandbox\/host\.js/);
    assert.match(configured, /reverse_proxy @paws_mcp_app_host localhost:3005/);
    assert.match(configured, /respond 404/);
    assert.match(configured, /# TLS is provisioned automatically by the site address\./);
    assert.match(configured, /metrics\.example \{\n    reverse_proxy localhost:9090\n\}/);
    assert.match(configured, /paws\.example:8443 \{\n    respond "paws"\n\}/);

    const boundaryComment = configureProductionMcpAppSandboxCaddy(
        source.replace('sandbox.paws.example {', 'sandbox.paws.example { # valid token-boundary comment'),
        { sandboxOrigin: 'https://sandbox.paws.example', parentOrigins: ['https://paws.example:8443'] },
    );
    assert.match(boundaryComment, /sandbox\.paws\.example \{ # valid token-boundary comment/);
});

test('is idempotent and replaces only its own complete managed block', () => {
    const options = {
        sandboxOrigin: 'https://sandbox.paws.example',
        parentOrigins: ['https://paws.example:8443'],
    };
    const once = configureProductionMcpAppSandboxCaddy(source, options);
    const twice = configureProductionMcpAppSandboxCaddy(once, options);

    assert.equal(twice, once);
    assert.equal(twice.match(new RegExp(MCP_APP_SANDBOX_CADDY_BLOCK_START, 'g'))?.length, 1);

    const differentlyIndentedComment = once.replace(
        '    # TLS is provisioned automatically by the site address.',
        '  # TLS is provisioned automatically by the site address.',
    );
    assert.equal(configureProductionMcpAppSandboxCaddy(differentlyIndentedComment, options), differentlyIndentedComment);
});

test('preserves unrelated sites byte-for-byte, including CRLF and quoted braces', () => {
    const crlf = source.replace('respond "paws"', 'respond "paws } \\" quoted" # } comment').replaceAll('\n', '\r\n');
    const configured = configureProductionMcpAppSandboxCaddy(crlf, {
        sandboxOrigin: 'https://sandbox.paws.example', parentOrigins: ['https://paws.example:8443'],
    });
    const prefix = crlf.slice(0, crlf.indexOf('sandbox.paws.example {'));
    const suffix = crlf.slice(crlf.indexOf('metrics.example {'));
    assert.ok(configured.startsWith(prefix));
    assert.ok(configured.endsWith(suffix));
    assert.ok(configured.includes('\r\n'));
    assert.equal(configured.replaceAll('\r\n', '').includes('\n'), false);
});

test('fails closed for missing, same-origin, non-HTTPS, and incomplete managed sites', () => {
    assert.throws(() => configureProductionMcpAppSandboxCaddy(source, {
        sandboxOrigin: 'https://missing.example', parentOrigins: ['https://paws.example:8443'],
    }), /site block not found/i);
    assert.throws(() => configureProductionMcpAppSandboxCaddy(source, {
        sandboxOrigin: 'https://sandbox.paws.example', parentOrigins: ['https://sandbox.paws.example'],
    }), /different origin/i);
    assert.throws(() => configureProductionMcpAppSandboxCaddy(source, {
        sandboxOrigin: 'http://sandbox.paws.example', parentOrigins: ['https://paws.example:8443'],
    }), /HTTPS/i);
    assert.throws(() => configureProductionMcpAppSandboxCaddy(
        source.replace('    # TLS is provisioned automatically by the site address.', `    ${MCP_APP_SANDBOX_CADDY_BLOCK_START}`),
        { sandboxOrigin: 'https://sandbox.paws.example', parentOrigins: ['https://paws.example:8443'] },
    ), /incomplete/i);
    assert.throws(() => configureProductionMcpAppSandboxCaddy(
        source.replace('    # TLS is provisioned automatically by the site address.', '    respond "placeholder"'),
        { sandboxOrigin: 'https://sandbox.paws.example', parentOrigins: ['https://paws.example:8443'] },
    ), /only comments/i);
    for (const handler of [
        'reverse_proxy localhost:9999', 'route {', 'handle {', 'handle_path /x {', 'respond 200',
        'redir / /x', 'rewrite * /x', 'file_server', 'php_fastcgi localhost:9000', 'request_body {',
        'handle_errors {', 'import hidden_routes', 'abort', 'basic_auth {', 'forward_auth localhost:3000',
        'try_files {path} /index.html', 'tls internal', 'error "boom"', 'invoke hidden_routes',
        '(hidden_routes) {', 'log', 'encode gzip', 'header X-Test value',
        'reverse_proxy https://evil.example',
    ]) {
        const dangerous = source.replace('    # TLS is provisioned automatically by the site address.', `    ${handler}`);
        assert.throws(() => configureProductionMcpAppSandboxCaddy(dangerous, {
            sandboxOrigin: 'https://sandbox.paws.example', parentOrigins: ['https://paws.example:8443'],
        }), /only comments|unbalanced/i);
    }
    for (const invalidHeader of [
        'sandbox.paws.example {#not-a-comment',
        'sandbox.paws.example {"not-a-quote"',
    ]) {
        assert.throws(() => configureProductionMcpAppSandboxCaddy(
            source.replace('sandbox.paws.example {', invalidHeader),
            { sandboxOrigin: 'https://sandbox.paws.example', parentOrigins: ['https://paws.example:8443'] },
        ), /site block not found|unbalanced|unterminated/i);
    }
});

test('preserves unrelated multiline quotes and official heredocs with structural close-line remainders', () => {
    const unrelated = `notes.example {
    header X-Double "first line {
        a literal line-ending escape \\
        sandbox.paws.example {
        } still quoted"
    header X-Single '} still quoted'
    header X-Raw \`first raw line }
        a raw line-ending backslash \\
        sandbox.paws.example {
        ${MCP_APP_SANDBOX_CADDY_BLOCK_START}
        { still raw\`
    header X-Escaped \\} still-a-token
    header X-Escaped-Heredoc \\<<NOT_A_HEREDOC
    header X-Inline-Heredoc prefix<<NOT_A_HEREDOC
    respond <<HTML
        { # not structural
        ${MCP_APP_SANDBOX_CADDY_BLOCK_START}
        } still data
        HTML 200
    route {
        respond <<BODY
            sandbox.paws.example {
            { still data
        BODY }
}

${source}`;
    const configured = configureProductionMcpAppSandboxCaddy(unrelated, {
        sandboxOrigin: 'https://sandbox.paws.example', parentOrigins: ['https://paws.example:8443'],
    });
    assert.ok(configured.startsWith(unrelated.slice(0, unrelated.indexOf(source))));
    assert.match(configured, /# paws-mcp-app-sandbox:start/);
});

test('fails closed on any heredoc or nested token inside the target while scanning close-line remainders', () => {
    const dangerous = source.replace(
        '    # TLS is provisioned automatically by the site address.',
        '    respond <<BODY\n        } data only\n        { data only\n        BODY }',
    );
    assert.throws(() => configureProductionMcpAppSandboxCaddy(dangerous, {
        sandboxOrigin: 'https://sandbox.paws.example', parentOrigins: ['https://paws.example:8443'],
    }), /only comments|unbalanced/i);

    const escapedClosingBrace = source.replace(
        '    # TLS is provisioned automatically by the site address.',
        '    header X-Escaped \\}',
    );
    assert.throws(() => configureProductionMcpAppSandboxCaddy(escapedClosingBrace, {
        sandboxOrigin: 'https://sandbox.paws.example', parentOrigins: ['https://paws.example:8443'],
    }), /only comments/i);
});

test('enforces the official heredoc closing-marker indentation across every nonempty body line', async () => {
    const valid = `notes.example {
    respond <<HTML
        <main>

            <p>more indentation is valid</p>
        HTML 200
}

${source}`;
    assert.ok(configureProductionMcpAppSandboxCaddy(valid, {
        sandboxOrigin: 'https://sandbox.paws.example', parentOrigins: ['https://paws.example:8443'],
    }).startsWith(valid.slice(0, valid.indexOf(source))));

    const mismatched = valid.replace('        <main>', '  <main>');
    assert.throws(() => configureProductionMcpAppSandboxCaddy(mismatched, {
        sandboxOrigin: 'https://sandbox.paws.example', parentOrigins: ['https://paws.example:8443'],
    }), /mismatched.*whitespace/i);

    const directory = await mkdtemp(join(tmpdir(), 'paws-mcp-caddy-heredoc-'));
    const input = join(directory, 'Caddyfile');
    const output = join(directory, 'output');
    await writeFile(input, mismatched);
    await writeFile(output, 'untouched');
    try {
        await assert.rejects(runConfigureProductionMcpAppSandboxCaddy([
            input, output, 'https://sandbox.paws.example', 'https://paws.example:8443',
        ]), /mismatched.*whitespace/i);
        assert.equal(await readFile(output, 'utf8'), 'untouched');
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('rejects malformed official heredoc forms, open multiline tokens, mixed line endings, and modified blocks', () => {
    const malformed = [
        source.replace('# TLS is provisioned', 'header X-Bad "unterminated }'),
        source.replace('# TLS is provisioned', 'header X-Bad `unterminated }'),
        source.replace('# TLS is provisioned automatically by the site address.', 'respond <<'),
        source.replace('# TLS is provisioned automatically by the site address.', 'respond <<"DOC"\nDOC'),
        source.replace('# TLS is provisioned automatically by the site address.', "respond <<'DOC'\nDOC"),
        source.replace('# TLS is provisioned automatically by the site address.', 'respond << DOC\nDOC'),
        source.replace('# TLS is provisioned automatically by the site address.', 'respond <<-DOC\nDOC'),
        source.replace('# TLS is provisioned automatically by the site address.', 'respond <<DOC!\nDOC'),
        source.replace('# TLS is provisioned automatically by the site address.', 'respond <<DOC#comment\nDOC'),
        source.replace('# TLS is provisioned automatically by the site address.', 'respond <<DOC ignored\nDOC'),
        source.replace('# TLS is provisioned', 'respond <<EOF\n} hidden forever'),
        `${source}header X-Dangling \\`,
        `${source}header X-Bad "escaped \\"`,
        source.replace('\n', '\r\n'),
    ];
    for (const candidate of malformed) {
        assert.throws(() => configureProductionMcpAppSandboxCaddy(candidate, {
            sandboxOrigin: 'https://sandbox.paws.example', parentOrigins: ['https://paws.example:8443'],
        }), /unterminated|malformed|mixed|unbalanced/i);
    }
    const configured = configureProductionMcpAppSandboxCaddy(source, {
        sandboxOrigin: 'https://sandbox.paws.example', parentOrigins: ['https://paws.example:8443'],
    }).replace('respond 404', 'respond 200');
    assert.throws(() => configureProductionMcpAppSandboxCaddy(configured, {
        sandboxOrigin: 'https://sandbox.paws.example', parentOrigins: ['https://paws.example:8443'],
    }), /managed.*modified/i);
});

test('does not create or mutate the output file when validation fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'paws-mcp-caddy-'));
    const input = join(directory, 'Caddyfile');
    const absentOutput = join(directory, 'absent-output');
    const existingOutput = join(directory, 'existing-output');
    await writeFile(input, source);
    await writeFile(existingOutput, 'untouched');
    try {
        await assert.rejects(runConfigureProductionMcpAppSandboxCaddy([
            input, absentOutput, 'https://missing.example', 'https://paws.example:8443',
        ]), /site block not found/i);
        await assert.rejects(readFile(absentOutput), { code: 'ENOENT' });
        await assert.rejects(runConfigureProductionMcpAppSandboxCaddy([
            input, existingOutput, 'https://missing.example', 'https://paws.example:8443',
        ]), /site block not found/i);
        assert.equal(await readFile(existingOutput, 'utf8'), 'untouched');
        for (const [invalidSource, pattern] of [
            [source.replace('# TLS is provisioned', 'reverse_proxy localhost:9999'), /only comments/i],
            [source.replace('# TLS is provisioned', 'respond <<EOF\n} data'), /unterminated heredoc/i],
            [source.replace('# TLS is provisioned', 'respond <<"DOC"\nDOC'), /malformed heredoc/i],
            [source.replace('# TLS is provisioned', 'respond <<DOC ignored\nDOC'), /malformed heredoc/i],
            [source.replace('sandbox.paws.example {', 'sandbox.paws.example {#not-a-comment'), /site block not found|unbalanced/i],
            [source.replace('sandbox.paws.example {', 'sandbox.paws.example {"not-a-quote"'), /site block not found|unbalanced/i],
            [source.replace('# TLS is provisioned', 'header X-Bad `unterminated'), /unterminated quoted/i],
        ]) {
            await writeFile(input, invalidSource);
            await assert.rejects(runConfigureProductionMcpAppSandboxCaddy([
                input, existingOutput, 'https://sandbox.paws.example', 'https://paws.example:8443',
            ]), pattern);
            assert.equal(await readFile(existingOutput, 'utf8'), 'untouched');
        }
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
