import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

/** Read only the selected, owned native frame; return assertions, never credentials. */
export async function inspectBotsAccount(page, { runtimeOrigin, credentialsFile, absentText }) {
    const credentials = JSON.parse(await readFile(credentialsFile, 'utf8'));
    const subject = JSON.parse(Buffer.from(credentials.token.split('.')[1], 'base64url')).sub;
    const expectedEmail = `paws-${createHash('sha256').update(`paws\0${subject}`).digest('hex')}@paws.local`;
    const tree = await page.cdp('Page.getFrameTree');
    const native = tree.frameTree.childFrames?.find(item => new URL(item.frame.url).origin === runtimeOrigin);
    assert(native, 'Expected native frame missing');
    await page.cdp('Runtime.disable');
    await page.cdp('Runtime.enable');
    const context = (await page.events()).filter(event => event.method === 'Runtime.executionContextCreated')
        .map(event => event.params.context).find(item => item.auxData?.isDefault && item.auxData.frameId === native.frame.id);
    assert(context, 'Expected native execution context missing');
    const input = JSON.stringify({ expectedEmail, absentText });
    const expression = `(async () => {
        const input = ${input};
        const auth = await fetch('/api/auth/get-session?disableCookieCache=true');
        const session = await auth.json();
        const response = await fetch('/rpc/spaces/list', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ json: {} }) });
        const navigation = await response.json();
        return { authStatus: auth.status, matchesExpectedAccount: session?.user?.email === input.expectedEmail,
            navigationStatus: response.status, bots: navigation.json?.current?.bots?.map(bot => bot.name),
            absentText: !document.body.innerText.includes(input.absentText),
            spaceMatchesFrame: navigation.json?.current?.id === localStorage.getItem('rakazo:space-id') };
    })()`;
    const result = await page.cdp('Runtime.evaluate', { contextId: context.id, expression, awaitPromise: true, returnByValue: true });
    assert(!result.exceptionDetails, 'Native account read failed');
    return result.result.value;
}
