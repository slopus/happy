import {
    App,
    applyDocumentTheme,
    applyHostFonts,
    applyHostStyleVariables,
} from '@modelcontextprotocol/ext-apps';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
    filterIncidentRows,
    filterServiceCards,
    summarizeDeploymentPlan,
    toDeploymentPlannerViewModel,
    toIncidentBoardViewModel,
    toReadinessViewModel,
    toServiceCatalogViewModel,
    type DeploymentPlannerOutput,
    type IncidentBoardOutput,
    type IncidentFilter,
    type IncidentRow,
    type ReadinessOutput,
    type ServiceCard,
    type ServiceCatalogOutput,
    type ServiceFilter,
} from './viewModel.js';
import './styles.css';

const rootElement = document.getElementById('app');
if (!rootElement) throw new Error('Missing MCP App root element');
const root: HTMLElement = rootElement;

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function applyHostContext(context: NonNullable<ReturnType<App['getHostContext']>>): void {
    if (context.theme) applyDocumentTheme(context.theme);
    if (context.styles?.variables) applyHostStyleVariables(context.styles.variables);
    if (context.styles?.css?.fonts) applyHostFonts(context.styles.css.fonts);
}

function isReadinessOutput(value: unknown): value is ReadinessOutput {
    if (!isRecord(value)) return false;
    const candidate = value as Partial<ReadinessOutput>;
    return typeof candidate.releaseName === 'string'
        && typeof candidate.passed === 'number'
        && typeof candidate.total === 'number'
        && typeof candidate.percent === 'number'
        && (candidate.status === 'ready' || candidate.status === 'needs-attention')
        && Array.isArray(candidate.checks)
        && candidate.checks.every((check) => (
            Boolean(check)
            && typeof check === 'object'
            && typeof check.name === 'string'
            && typeof check.passed === 'boolean'
        ));
}

function isServiceCatalogOutput(value: unknown): value is ServiceCatalogOutput {
    if (!isRecord(value) || value.kind !== 'service-catalog' || typeof value.title !== 'string' || !Array.isArray(value.services)) {
        return false;
    }
    return value.services.every((service) => isRecord(service)
        && typeof service.id === 'string'
        && typeof service.name === 'string'
        && ['healthy', 'degraded', 'maintenance'].includes(String(service.status))
        && typeof service.region === 'string'
        && typeof service.latencyMs === 'number'
        && typeof service.version === 'string'
        && typeof service.owner === 'string');
}

function isIncidentBoardOutput(value: unknown): value is IncidentBoardOutput {
    if (!isRecord(value) || value.kind !== 'incident-board' || typeof value.title !== 'string' || !Array.isArray(value.incidents)) {
        return false;
    }
    return value.incidents.every((incident) => isRecord(incident)
        && typeof incident.id === 'string'
        && typeof incident.title === 'string'
        && ['critical', 'warning'].includes(String(incident.severity))
        && typeof incident.service === 'string'
        && typeof incident.ageMinutes === 'number'
        && typeof incident.summary === 'string'
        && Array.isArray(incident.runbook)
        && incident.runbook.every((step) => typeof step === 'string'));
}

function isDeploymentPlannerOutput(value: unknown): value is DeploymentPlannerOutput {
    if (!isRecord(value)
        || value.kind !== 'deployment-planner'
        || typeof value.title !== 'string'
        || !Array.isArray(value.environments)
        || !Array.isArray(value.steps)) {
        return false;
    }
    return value.environments.every((environment) => isRecord(environment)
        && typeof environment.id === 'string'
        && typeof environment.name === 'string'
        && ['low', 'elevated'].includes(String(environment.risk)))
        && value.steps.every((step) => isRecord(step)
            && typeof step.id === 'string'
            && typeof step.label === 'string'
            && typeof step.required === 'boolean'
            && typeof step.selected === 'boolean');
}

function element<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    text?: string,
): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function createExperienceHeader(eyebrowText: string, titleText: string, summaryText: string): HTMLElement {
    const header = element('header', 'experience-header');
    const copy = element('div', 'heading-copy');
    const eyebrow = element('p', 'eyebrow', eyebrowText);
    const title = element('h1', 'title', titleText);
    const summary = element('p', 'experience-summary', summaryText);
    copy.append(eyebrow, title, summary);
    header.append(copy);
    return header;
}

function createFilterButton(
    label: string,
    testId: string,
    active: boolean,
    onClick: () => void,
): HTMLButtonElement {
    const button = element('button', `filter-chip${active ? ' is-active' : ''}`, label);
    button.type = 'button';
    button.dataset.testid = testId;
    button.setAttribute('aria-pressed', String(active));
    button.addEventListener('click', onClick);
    return button;
}

function renderServiceCatalog(output: ServiceCatalogOutput): void {
    const view = toServiceCatalogViewModel(output);
    const card = element('article', 'experience-card catalog-card');
    card.dataset.testid = 'mcp-catalog-root';
    card.append(createExperienceHeader(view.eyebrow, view.title, view.summary));

    let activeFilter: ServiceFilter = 'all';
    let selectedId = view.cards[0]?.id;
    const toolbar = element('div', 'collection-toolbar');
    const filters = element('div', 'filter-group');
    filters.setAttribute('role', 'group');
    filters.setAttribute('aria-label', 'Filter services');
    const scrollControls = element('div', 'scroll-controls');
    const previous = element('button', 'icon-button', '←');
    previous.type = 'button';
    previous.dataset.testid = 'service-catalog-previous';
    previous.setAttribute('aria-label', 'Previous services');
    const next = element('button', 'icon-button', '→');
    next.type = 'button';
    next.dataset.testid = 'service-catalog-next';
    next.setAttribute('aria-label', 'Next services');
    scrollControls.append(previous, next);
    toolbar.append(filters, scrollControls);

    const rail = element('div', 'service-rail');
    rail.dataset.testid = 'service-catalog-rail';
    rail.setAttribute('role', 'group');
    rail.setAttribute('aria-label', 'Services');
    previous.addEventListener('click', () => rail.scrollBy({ left: -264, behavior: 'smooth' }));
    next.addEventListener('click', () => rail.scrollBy({ left: 264, behavior: 'smooth' }));

    const detail = element('section', 'service-detail');
    const renderDetail = (service: ServiceCard): void => {
        const title = element('h2', 'detail-title', service.name);
        title.dataset.testid = 'service-detail-name';
        const facts = element('div', 'detail-facts');
        for (const [label, value] of [
            ['Region', service.region],
            ['Owner', service.owner],
            ['Version', service.version],
            ['Latency', service.latency],
        ]) {
            const fact = element('div', 'detail-fact');
            fact.append(element('span', 'fact-label', label), element('strong', 'fact-value', value));
            facts.append(fact);
        }
        const action = element('button', 'primary-button', 'Run health check');
        action.type = 'button';
        action.dataset.testid = 'service-health-action';
        const result = element('span', 'action-result');
        result.dataset.testid = 'service-health-result';
        result.setAttribute('aria-live', 'polite');
        action.addEventListener('click', async () => {
            action.disabled = true;
            result.textContent = 'checking…';
            try {
                const response = await app.callServerTool({
                    name: 'check-service-health',
                    arguments: { serviceId: service.id },
                });
                const structured = response.structuredContent as { check?: unknown } | undefined;
                result.textContent = structured?.check === 'passed' ? 'passed' : 'unexpected';
            } catch {
                result.textContent = 'unavailable';
            } finally {
                action.disabled = false;
            }
        });
        const actions = element('div', 'detail-actions');
        actions.append(action, result);
        detail.replaceChildren(title, facts, actions);
    };

    const renderCards = (): void => {
        const cards = filterServiceCards(view.cards, activeFilter);
        if (!cards.some((service) => service.id === selectedId)) selectedId = cards[0]?.id;
        rail.replaceChildren();
        for (const service of cards) {
            const item = element('button', `service-card${service.id === selectedId ? ' is-selected' : ''}`);
            item.type = 'button';
            item.dataset.serviceStatus = service.statusTone;
            item.setAttribute('data-service-id', service.id);
            item.setAttribute('aria-pressed', String(service.id === selectedId));
            const top = element('span', 'service-card-top');
            top.append(
                element('span', `status-dot tone-${service.statusTone}`),
                element('span', `status-label tone-text-${service.statusTone}`, service.statusLabel),
            );
            item.append(
                top,
                element('strong', 'service-name', service.name),
                element('span', 'service-region', service.region),
                element('span', 'service-latency', service.latency),
            );
            item.addEventListener('click', () => {
                selectedId = service.id;
                renderCards();
            });
            item.dataset.testid = `service-card-${service.id}`;
            item.setAttribute('data-testid-group', 'service-card');
            rail.append(item);
        }
        const selected = cards.find((service) => service.id === selectedId);
        if (selected) renderDetail(selected);
    };

    const renderFilters = (): void => {
        filters.replaceChildren();
        for (const [filter, label] of [
            ['all', 'All'],
            ['healthy', 'Healthy'],
            ['attention', 'Attention'],
        ] as const) {
            filters.append(createFilterButton(label, `service-filter-${filter}`, activeFilter === filter, () => {
                activeFilter = filter;
                renderFilters();
                renderCards();
            }));
        }
    };

    renderFilters();
    renderCards();
    card.append(toolbar, rail, detail);
    root.replaceChildren(card);
}

function renderIncidentBoard(output: IncidentBoardOutput): void {
    const view = toIncidentBoardViewModel(output);
    const card = element('article', 'experience-card incident-card');
    card.dataset.testid = 'mcp-incident-root';
    card.append(createExperienceHeader(view.eyebrow, view.title, view.summary));
    let activeFilter: IncidentFilter = 'all';
    let expandedId: string | undefined;

    const filters = element('div', 'filter-group incident-filters');
    filters.setAttribute('role', 'group');
    filters.setAttribute('aria-label', 'Filter incidents');
    const list = element('div', 'incident-list');

    const renderExpanded = (row: IncidentRow): HTMLElement => {
        const detail = element('div', 'incident-detail');
        detail.id = `incident-runbook-panel-${row.id}`;
        detail.dataset.testid = `incident-runbook-${row.id}`;
        detail.append(element('p', 'incident-summary', row.summary));
        const runbook = element('ol', 'runbook-list');
        for (const step of row.runbook) runbook.append(element('li', undefined, step));
        const action = element('button', 'primary-button', 'Confirm runbook');
        action.type = 'button';
        action.dataset.testid = 'incident-confirm-action';
        const result = element('span', 'action-result');
        result.dataset.testid = 'incident-confirm-result';
        result.setAttribute('aria-live', 'polite');
        action.addEventListener('click', async () => {
            action.disabled = true;
            result.textContent = 'confirming…';
            try {
                const response = await app.callServerTool({
                    name: 'confirm-incident-runbook',
                    arguments: { incidentId: row.id },
                });
                const structured = response.structuredContent as { confirmation?: unknown } | undefined;
                result.textContent = structured?.confirmation === 'confirmed' ? 'confirmed' : 'unexpected';
            } catch {
                result.textContent = 'unavailable';
            } finally {
                action.disabled = false;
            }
        });
        const actions = element('div', 'detail-actions');
        actions.append(action, result);
        detail.append(runbook, actions);
        return detail;
    };

    const renderRows = (): void => {
        list.replaceChildren();
        for (const row of filterIncidentRows(view.rows, activeFilter)) {
            const item = element('section', `incident-row severity-${row.severityTone}`);
            item.dataset.testid = 'incident-row';
            const toggle = element('button', 'incident-toggle');
            toggle.type = 'button';
            toggle.dataset.testid = `incident-toggle-${row.id}`;
            toggle.setAttribute('aria-expanded', String(expandedId === row.id));
            toggle.setAttribute('aria-controls', `incident-runbook-panel-${row.id}`);
            const marker = element('span', `severity-pill severity-pill-${row.severityTone}`, row.severityLabel);
            const copy = element('span', 'incident-copy');
            copy.append(element('strong', 'incident-title', row.title), element('span', 'incident-meta', `${row.service} · ${row.age}`));
            toggle.append(marker, copy, element('span', 'disclosure', expandedId === row.id ? '−' : '+'));
            toggle.addEventListener('click', () => {
                expandedId = expandedId === row.id ? undefined : row.id;
                renderRows();
            });
            item.append(toggle);
            if (expandedId === row.id) item.append(renderExpanded(row));
            list.append(item);
        }
    };

    const renderFilters = (): void => {
        filters.replaceChildren();
        for (const [filter, label] of [
            ['all', 'All incidents'],
            ['critical', 'Critical'],
            ['warning', 'Warning'],
        ] as const) {
            filters.append(createFilterButton(label, `incident-filter-${filter}`, activeFilter === filter, () => {
                activeFilter = filter;
                expandedId = undefined;
                renderFilters();
                renderRows();
            }));
        }
    };

    renderFilters();
    renderRows();
    card.append(filters, list);
    root.replaceChildren(card);
}

function renderDeploymentPlanner(output: DeploymentPlannerOutput): void {
    const view = toDeploymentPlannerViewModel(output);
    const card = element('article', 'experience-card deployment-card');
    card.dataset.testid = 'mcp-deployment-root';
    card.append(createExperienceHeader(view.eyebrow, view.title, 'Configure a safe rollout before asking the Host to preview it.'));
    let environmentId = view.environments[0]?.id ?? '';
    const selectedSteps = new Set(view.steps.filter((step) => step.selected).map((step) => step.id));

    const environmentSection = element('section', 'planner-section');
    environmentSection.append(element('h2', 'section-label', '1 · Environment'));
    const environmentOptions = element('div', 'environment-options');
    environmentOptions.setAttribute('role', 'radiogroup');
    environmentOptions.setAttribute('aria-label', 'Deployment environment');
    environmentSection.append(environmentOptions);

    const stepsSection = element('section', 'planner-section');
    stepsSection.append(element('h2', 'section-label', '2 · Rollout steps'));
    const steps = element('div', 'planner-steps');
    stepsSection.append(steps);

    const summarySection = element('section', 'plan-summary');
    const summaryLabel = element('span', 'fact-label', 'Live preview');
    const summary = element('strong', 'plan-summary-copy');
    summary.dataset.testid = 'deployment-summary';
    summarySection.append(summaryLabel, summary);

    const action = element('button', 'primary-button', 'Preview deployment');
    action.type = 'button';
    action.dataset.testid = 'deployment-preview-action';
    const result = element('span', 'action-result');
    result.dataset.testid = 'deployment-preview-result';
    result.setAttribute('aria-live', 'polite');
    const setConfigurationDisabled = (disabled: boolean): void => {
        for (const option of environmentOptions.querySelectorAll<HTMLButtonElement>('button')) {
            option.disabled = disabled;
        }
        for (const option of steps.querySelectorAll<HTMLButtonElement>('button')) {
            option.disabled = disabled;
        }
    };
    action.addEventListener('click', async () => {
        action.disabled = true;
        setConfigurationDisabled(true);
        result.textContent = 'building preview…';
        try {
            const response = await app.callServerTool({
                name: 'preview-deployment-plan',
                arguments: { environmentId, stepIds: Array.from(selectedSteps) },
            });
            const structured = response.structuredContent as { planId?: unknown; status?: unknown } | undefined;
            result.textContent = typeof structured?.planId === 'string' && structured.status === 'ready'
                ? `${structured.planId} · ready`
                : 'unexpected';
        } catch {
            result.textContent = 'unavailable';
        } finally {
            action.disabled = false;
            setConfigurationDisabled(false);
        }
    });
    const actions = element('div', 'planner-actions');
    actions.append(action, result);

    const updateSummary = (): void => {
        summary.textContent = summarizeDeploymentPlan(view, environmentId, selectedSteps).summary;
    };
    const renderEnvironments = (): void => {
        environmentOptions.replaceChildren();
        for (const environment of view.environments) {
            const option = element('button', `environment-option${environment.id === environmentId ? ' is-selected' : ''}`);
            option.type = 'button';
            option.dataset.testid = `deployment-environment-${environment.id}`;
            option.setAttribute('role', 'radio');
            option.setAttribute('aria-checked', String(environment.id === environmentId));
            option.append(
                element('strong', 'environment-name', environment.name),
                element('span', `risk-label tone-text-${environment.riskTone}`, environment.riskLabel),
            );
            option.addEventListener('click', () => {
                environmentId = environment.id;
                renderEnvironments();
                updateSummary();
                result.textContent = '';
            });
            environmentOptions.append(option);
        }
    };
    for (const step of view.steps) {
        const option = element('button', `planner-step${selectedSteps.has(step.id) ? ' is-selected' : ''}`);
        option.type = 'button';
        option.dataset.testid = `deployment-step-${step.id}`;
        option.setAttribute('role', 'checkbox');
        option.setAttribute('aria-checked', String(selectedSteps.has(step.id)));
        if (step.required) option.setAttribute('aria-disabled', 'true');
        const check = element('span', 'step-check', selectedSteps.has(step.id) ? '✓' : '');
        option.append(check, element('span', 'step-label', step.label), element('span', 'step-requirement', step.required ? 'Required' : 'Optional'));
        option.addEventListener('click', () => {
            if (step.required) return;
            if (selectedSteps.has(step.id)) selectedSteps.delete(step.id);
            else selectedSteps.add(step.id);
            option.classList.toggle('is-selected', selectedSteps.has(step.id));
            option.setAttribute('aria-checked', String(selectedSteps.has(step.id)));
            check.textContent = selectedSteps.has(step.id) ? '✓' : '';
            updateSummary();
            result.textContent = '';
        });
        steps.append(option);
    }

    renderEnvironments();
    updateSummary();
    card.append(environmentSection, stepsSection, summarySection, actions);
    root.replaceChildren(card);
}

function renderResult(result: CallToolResult): void {
    if (isServiceCatalogOutput(result.structuredContent)) {
        renderServiceCatalog(result.structuredContent);
        return;
    }
    if (isIncidentBoardOutput(result.structuredContent)) {
        renderIncidentBoard(result.structuredContent);
        return;
    }
    if (isDeploymentPlannerOutput(result.structuredContent)) {
        renderDeploymentPlanner(result.structuredContent);
        return;
    }
    if (!isReadinessOutput(result.structuredContent)) {
        const error = element('section', 'error-card', 'The tool returned an invalid readiness payload.');
        error.dataset.testid = 'mcp-app-invalid-result';
        root.replaceChildren(error);
        return;
    }

    const output = result.structuredContent;
    const view = toReadinessViewModel(output);
    const card = element('article', 'readiness-card');
    card.dataset.testid = 'mcp-example-root';
    card.id = 'mcp-app-release-readiness';

    const header = element('header', 'card-header');
    const headingCopy = element('div', 'heading-copy');
    const eyebrow = element('p', 'eyebrow', view.eyebrow);
    const title = element('h1', 'title', view.title);
    title.dataset.testid = 'readiness-title';
    headingCopy.append(eyebrow, title);
    const status = element('span', `status status-${view.statusTone}`, view.statusLabel);
    status.dataset.testid = 'readiness-status';
    header.append(headingCopy, status);

    const scoreSection = element('section', 'score-section');
    const scoreTop = element('div', 'score-top');
    const score = element('strong', 'score', view.score);
    score.dataset.testid = 'readiness-score';
    const percent = element('span', 'percent', view.percentText);
    scoreTop.append(score, percent);
    const progressTrack = element('div', 'progress-track');
    progressTrack.setAttribute('role', 'progressbar');
    progressTrack.setAttribute('aria-label', 'Release readiness');
    progressTrack.setAttribute('aria-valuemin', '0');
    progressTrack.setAttribute('aria-valuemax', '100');
    progressTrack.setAttribute('aria-valuenow', String(output.percent));
    progressTrack.dataset.testid = 'readiness-progress';
    const progressBar = element('div', `progress-bar progress-${view.statusTone}`);
    progressBar.style.width = `${output.percent}%`;
    progressTrack.append(progressBar);
    scoreSection.append(scoreTop, progressTrack);

    const list = element('ul', 'check-list');
    list.dataset.testid = 'readiness-checks';
    for (const row of view.rows) {
        const item = element('li', 'check-row');
        const icon = element('span', `check-icon icon-${row.tone}`, row.tone === 'success' ? '✓' : '!');
        icon.setAttribute('aria-hidden', 'true');
        const label = element('span', 'check-label', row.label);
        const marker = element('span', `check-marker marker-${row.tone}`, row.marker);
        item.append(icon, label, marker);
        list.append(item);
    }

    const action = element('button', 'approval-button', 'Verify mediated action');
    action.type = 'button';
    action.dataset.testid = 'mcp-example-tool-call';
    const actionResult = element('p', 'approval-result');
    actionResult.dataset.testid = 'mcp-example-tool-result';
    action.addEventListener('click', async () => {
        action.disabled = true;
        actionResult.textContent = 'pending';
        try {
            const approval = await app.callServerTool({
                name: 'approve-release-readiness',
                arguments: { releaseName: output.releaseName },
            });
            const structured = approval.structuredContent as { approval?: unknown } | undefined;
            actionResult.textContent = structured?.approval === 'approved' ? 'approved' : 'unexpected';
        } catch {
            actionResult.textContent = 'denied';
        } finally {
            action.disabled = false;
        }
    });
    const actionSection = element('section', 'approval-section');
    actionSection.append(action, actionResult);
    const footer = element('footer', 'card-footer', 'Rendered from structuredContent via MCP Apps');
    card.append(header, scoreSection, list, actionSection, footer);
    root.replaceChildren(card);
}

const app = new App({ name: 'Paws Release Readiness', version: '1.0.0' });
app.ontoolresult = renderResult;
app.onhostcontextchanged = applyHostContext;

void app.connect().then(() => {
    const context = app.getHostContext();
    if (context) applyHostContext(context);
}).catch(() => {
    const error = element('section', 'error-card', 'The MCP App could not connect to its Host.');
    error.dataset.testid = 'mcp-app-connect-error';
    root.replaceChildren(error);
});
