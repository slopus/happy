import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('./deploy-staging-web.sh', import.meta.url));

test('staging release script parses and rejects invalid rollback revisions before SSH', () => {
    const syntax = spawnSync('bash', ['-n', script], { encoding: 'utf8' });
    assert.equal(syntax.status, 0, syntax.stderr);
    const invalid = spawnSync('bash', [script, '--rollback', 'main'], { encoding: 'utf8' });
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /40-character lowercase Git SHA/);
});

test('staging release script targets only the independent site and validates before switching', async () => {
    const source = await readFile(script, 'utf8');
    assert.match(source, /STAGING_ORIGIN='https:\/\/47\.115\.228\.20:8444'/);
    assert.match(source, /EXPO_PUBLIC_DREAMSKIN_STAGING_DEFAULT=1/);
    assert.match(source, /inject-staging-dreamskin-preload\.mjs/);
    assert.match(source, /caddy validate --config/);
    assert.match(source, /sha256sum "\$caddy_file"/);
    assert.match(source, /prepare_current_release "\$old_revision"/);
    assert.match(source, /restore_caddy/);
    assert.match(source, /mv -Tf "\$root\/current.next" "\$root\/current"/);
    assert.match(source, /flock -x 9/);
    assert.match(source, /Staging changed concurrently/);
    assert.match(source, /--rollback/);
    assert.doesNotMatch(source, /STAGING_ORIGIN=.*:8443/);
});

test('staging validation fails on an HTML mismatch even when called from a conditional', async () => {
    const source = await readFile(script, 'utf8');
    const prelude = source.slice(0, source.indexOf("if [[ \"$mode\" == '--rollback' ]]"));
    const revision = '0'.repeat(40);
    const probe = `
readonly revision='${revision}' original_sha='before' candidate_sha='after'
remote() { cat >/dev/null; }
prepare_current_release '${revision}'
install_caddy 'before' 'after' '${revision}' '/tmp/candidate' '/tmp/backup'
activate '${revision}' '${revision}'
curl() {
    case "$*" in
        *'.paws-release-revision'*) printf '%s' '${revision}' ;;
        *'/health'*) printf '%s' '{"status":"ok","service":"happy-server"}' ;;
        *'/restore'*) printf '%s' '<html>wrong version</html>' ;;
    esac
}
if verify_live '${revision}'; then exit 43; else exit 0; fi
`;
    const result = spawnSync('bash', ['-s'], { input: prelude + probe, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /HTML revision mismatch/);
});
