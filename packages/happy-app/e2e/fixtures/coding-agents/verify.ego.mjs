import assert from 'node:assert/strict';
export function agentManagerActor(page, runtime) {
    const base = runtime.webUrl;
    const wait = (fn, arg) => page.waitForFunction(fn, arg, { timeout: 45000 });
    const checked = id => page.evaluate(id => {
        const root = document.querySelector(`[data-testid="coding-agent-enable-${id}"]`);
        const input = root?.matches('input') ? root : root?.querySelector('input');
        return input ? input.checked : root?.getAttribute('aria-checked') === 'true';
    }, id);
    async function toggle(id, value) {
        if (await checked(id) !== value) await page.click(`[data-testid="coding-agent-enable-${id}"]`);
        await wait(({ id, value }) => {
            const root = document.querySelector(`[data-testid="coding-agent-enable-${id}"]`);
            const input = root?.matches('input') ? root : root?.querySelector('input');
            return (input ? input.checked : root?.getAttribute('aria-checked') === 'true') === value;
        }, { id, value });
    }
    async function settings(machine = 'A') {
        const id = runtime.machines.find(item => item.label === machine).id;
        await page.goto(`${base}/settings/coding-agents?machineId=${id}`);
        await page.waitForSelector('[data-testid="coding-agent-enable-codex"]');
        await wait(() => {
            const node = document.querySelector('[data-testid="coding-agent-check-codex"]');
            return node && node.getAttribute('aria-disabled') !== 'true';
        });
        return id;
    }
    async function newSession() {
        await page.goto(`${base}/new`);
        await wait(() => [...document.querySelectorAll('[data-testid="session-config-machine-trigger"]')].some(node => node.getBoundingClientRect().width > 0));
        const label = await page.evaluate(() => [...document.querySelectorAll('[data-testid="session-config-machine-trigger"]')].find(node => node.getBoundingClientRect().width > 0)?.textContent);
        if (!label?.includes('Worker A')) {
            await page.click('[data-testid="session-config-machine-trigger"]');
            await page.click('[role="radio"][aria-label*="Cloud E2E Worker A"]');
        }
        await wait(() => [...document.querySelectorAll('[data-testid="session-config-machine-trigger"]')].find(node => node.getBoundingClientRect().width > 0)?.textContent?.includes('Worker A'));
    }
    async function openModes() {
        await page.click('[data-testid="session-composer-mode-trigger"]');
        await page.waitForSelector('[data-testid="session-composer-mode-panel"]');
    }
    const modelText = () => page.evaluate(() => document.querySelector('[data-testid="session-composer-open-models"]')?.textContent ?? '');
    async function selectAgent(name) {
        await openModes();
        for (let step = 0; step < 4; step++) {
            if ((await modelText()).includes(name)) return;
            await page.click('[data-testid="session-composer-agent-cycle"]');
        }
        assert.fail(`Could not select ${name}`);
    }
    async function controller(route, method = 'GET') {
        const response = await fetch(`${runtime.controllerUrl}${route}`, { method });
        assert(response.ok); return response.json();
    }
    return { settings, checked, toggle, newSession, openModes, modelText, selectAgent, controller, wait };
}
