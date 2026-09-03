export type ReadinessOutput = {
    releaseName: string;
    passed: number;
    total: number;
    percent: number;
    status: 'ready' | 'needs-attention';
    checks: Array<{ name: string; passed: boolean }>;
};

export type ReadinessViewModel = {
    title: string;
    eyebrow: string;
    score: string;
    percentText: string;
    statusLabel: 'Ready' | 'Needs attention';
    statusTone: 'success' | 'warning';
    rows: Array<{
        label: string;
        marker: 'Passed' | 'Pending';
        tone: 'success' | 'warning';
    }>;
};

export function toReadinessViewModel(output: ReadinessOutput): ReadinessViewModel {
    const ready = output.status === 'ready';
    return {
        title: output.releaseName,
        eyebrow: 'MCP App · live tool result',
        score: `${output.passed} / ${output.total}`,
        percentText: `${output.percent}%`,
        statusLabel: ready ? 'Ready' : 'Needs attention',
        statusTone: ready ? 'success' : 'warning',
        rows: output.checks.map((check) => ({
            label: check.name,
            marker: check.passed ? 'Passed' : 'Pending',
            tone: check.passed ? 'success' : 'warning',
        })),
    };
}

export type ServiceCatalogOutput = {
    kind: 'service-catalog';
    title: string;
    services: Array<{
        id: string;
        name: string;
        status: 'healthy' | 'degraded' | 'maintenance';
        region: string;
        latencyMs: number;
        version: string;
        owner: string;
    }>;
};

export type ServiceCard = {
    id: string;
    name: string;
    statusLabel: 'Healthy' | 'Degraded' | 'Maintenance';
    statusTone: 'success' | 'warning' | 'neutral';
    region: string;
    latency: string;
    version: string;
    owner: string;
};

export type ServiceCatalogViewModel = {
    title: string;
    eyebrow: string;
    summary: string;
    cards: ServiceCard[];
};

export type ServiceFilter = 'all' | 'healthy' | 'attention';

export function toServiceCatalogViewModel(output: ServiceCatalogOutput): ServiceCatalogViewModel {
    const cards = output.services.map((service): ServiceCard => ({
        id: service.id,
        name: service.name,
        statusLabel: service.status === 'healthy'
            ? 'Healthy'
            : service.status === 'degraded'
                ? 'Degraded'
                : 'Maintenance',
        statusTone: service.status === 'healthy'
            ? 'success'
            : service.status === 'degraded'
                ? 'warning'
                : 'neutral',
        region: service.region,
        latency: `${service.latencyMs} ms`,
        version: service.version,
        owner: service.owner,
    }));
    const attentionCount = cards.filter((card) => card.statusTone === 'warning').length;
    return {
        title: output.title,
        eyebrow: 'MCP App · horizontal collection',
        summary: `${cards.length} services · ${attentionCount} needs attention`,
        cards,
    };
}

export function filterServiceCards(cards: ServiceCard[], filter: ServiceFilter): ServiceCard[] {
    if (filter === 'all') return cards;
    const tone = filter === 'healthy' ? 'success' : 'warning';
    return cards.filter((card) => card.statusTone === tone);
}

export type IncidentBoardOutput = {
    kind: 'incident-board';
    title: string;
    incidents: Array<{
        id: string;
        title: string;
        severity: 'critical' | 'warning';
        service: string;
        ageMinutes: number;
        summary: string;
        runbook: string[];
    }>;
};

export type IncidentRow = {
    id: string;
    title: string;
    severityLabel: 'Critical' | 'Warning';
    severityTone: 'danger' | 'warning';
    service: string;
    age: string;
    summary: string;
    runbook: string[];
};

export type IncidentBoardViewModel = {
    title: string;
    eyebrow: string;
    summary: string;
    rows: IncidentRow[];
};

export type IncidentFilter = 'all' | 'critical' | 'warning';

export function toIncidentBoardViewModel(output: IncidentBoardOutput): IncidentBoardViewModel {
    const rows = output.incidents.map((incident): IncidentRow => ({
        id: incident.id,
        title: incident.title,
        severityLabel: incident.severity === 'critical' ? 'Critical' : 'Warning',
        severityTone: incident.severity === 'critical' ? 'danger' : 'warning',
        service: incident.service,
        age: `${incident.ageMinutes} min`,
        summary: incident.summary,
        runbook: incident.runbook,
    }));
    const criticalCount = rows.filter((row) => row.severityTone === 'danger').length;
    return {
        title: output.title,
        eyebrow: 'MCP App · expandable workflow',
        summary: `${rows.length} active · ${criticalCount} critical`,
        rows,
    };
}

export function filterIncidentRows(rows: IncidentRow[], filter: IncidentFilter): IncidentRow[] {
    if (filter === 'all') return rows;
    const tone = filter === 'critical' ? 'danger' : 'warning';
    return rows.filter((row) => row.severityTone === tone);
}

export type DeploymentPlannerOutput = {
    kind: 'deployment-planner';
    title: string;
    environments: Array<{
        id: string;
        name: string;
        risk: 'low' | 'elevated';
    }>;
    steps: Array<{
        id: string;
        label: string;
        required: boolean;
        selected: boolean;
    }>;
};

export type DeploymentPlannerViewModel = {
    title: string;
    eyebrow: string;
    environments: Array<{
        id: string;
        name: string;
        riskLabel: 'Low risk' | 'Elevated risk';
        riskTone: 'success' | 'warning';
    }>;
    steps: DeploymentPlannerOutput['steps'];
};

export function toDeploymentPlannerViewModel(output: DeploymentPlannerOutput): DeploymentPlannerViewModel {
    return {
        title: output.title,
        eyebrow: 'MCP App · multi-step planner',
        environments: output.environments.map((environment) => ({
            id: environment.id,
            name: environment.name,
            riskLabel: environment.risk === 'low' ? 'Low risk' : 'Elevated risk',
            riskTone: environment.risk === 'low' ? 'success' : 'warning',
        })),
        steps: output.steps.map((step) => ({ ...step })),
    };
}

export function summarizeDeploymentPlan(
    view: DeploymentPlannerViewModel,
    environmentId: string,
    selectedStepIds: ReadonlySet<string>,
): { environment: string; risk: string; stepCount: number; summary: string } {
    const environment = view.environments.find((candidate) => candidate.id === environmentId)
        ?? view.environments[0];
    const stepCount = view.steps.filter((step) => selectedStepIds.has(step.id)).length;
    return {
        environment: environment?.name ?? 'Unknown',
        risk: environment?.riskLabel ?? 'Unknown risk',
        stepCount,
        summary: `${environment?.name ?? 'Unknown'} · ${stepCount} steps · ${environment?.riskLabel ?? 'Unknown risk'}`,
    };
}
