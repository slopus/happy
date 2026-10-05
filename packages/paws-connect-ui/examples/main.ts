import { mountServicePanel } from '../dist/index.mjs';
import { type ClientErrorCode } from '@wangjs-jacky/paws-agent/services/browser';
import { createSyntheticController, syntheticCatalog } from './synthetic';

const fixture = createSyntheticController({ approvalUrl: new URL('approval.html', location.href).href });
const params = new URLSearchParams(location.search);
const scenario = params.get('case') ?? 'initial';
const theme = params.get('theme') === 'dark' ? 'dark' : 'light';
const root = document.querySelector<HTMLElement>('#panel')!;
root.dataset.fixtureTheme = theme;
const panel = mountServicePanel(root, { controller: fixture.controller, appearance: { title: '共享 AI 服务', theme, ownerManagementUrl: new URL('approval.html', location.href).href } });
const scenarios = ['initial', 'ready', 'reasoning-only', 'pending', 'machine-offline', 'account-login-required', 'quota-exhausted', 'authorization-revoked', 'authorization-expired', 'protocol-incompatible', 'limited', 'remember-unavailable', 'session-unavailable'];
const selector = document.querySelector<HTMLSelectElement>('#scenario')!;
for (const name of scenarios) { const option = document.createElement('option'); option.value = name; option.textContent = name; selector.append(option); }
selector.value = scenario;
selector.addEventListener('change', () => { params.set('case', selector.value); location.search = params.toString(); });
const themeToggle = document.querySelector<HTMLButtonElement>('#theme')!;
themeToggle.textContent = theme === 'dark' ? '切换浅色' : '切换深色';
themeToggle.addEventListener('click', () => { params.set('theme', theme === 'dark' ? 'light' : 'dark'); location.search = params.toString(); });
document.documentElement.style.colorScheme = theme;
document.querySelector('#approve')!.addEventListener('click', () => fixture.approve());
document.querySelector('#catalog-change')!.addEventListener('click', () => {
    fixture.setCatalog({ ...syntheticCatalog, models: syntheticCatalog.models.slice(1), defaultModelId: 'basic' });
    void fixture.controller.refresh().catch(() => {});
});
document.querySelector('#destroy')!.addEventListener('click', () => panel.destroy());

async function initialize() {
    if (scenario === 'initial') return;
    if (scenario === 'pending') {
        fixture.controller.selectSource('personal');
        void fixture.controller.connect().catch(() => {});
        return;
    }
    if (scenario === 'remember-unavailable' || scenario === 'session-unavailable') fixture.setStorageWarning(scenario);
    if (scenario === 'limited') fixture.setCatalog({ ...syntheticCatalog, completeness: 'limited' });
    if (['initial', 'ready', 'reasoning-only', 'limited', 'remember-unavailable', 'session-unavailable'].includes(scenario)) {
        await fixture.controller.connect(); await fixture.controller.refresh();
        if (scenario === 'reasoning-only') fixture.controller.setOverrides({ reasoning: { mode: 'explicit', value: 'high' } });
        return;
    }
    fixture.setError(scenario as ClientErrorCode);
    await fixture.controller.connect();
}
void initialize().catch(() => {});
