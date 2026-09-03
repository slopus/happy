import { describe, expect, it } from 'vitest';
import {
    filterIncidentRows,
    filterServiceCards,
    summarizeDeploymentPlan,
    toDeploymentPlannerViewModel,
    toIncidentBoardViewModel,
    toReadinessViewModel,
    toServiceCatalogViewModel,
} from './src/viewModel.js';

describe('release-readiness MCP App view model', () => {
    it('turns partial readiness structured content into an attention state with check rows', () => {
        expect(toReadinessViewModel({
            releaseName: 'Paws MCP Apps PR 1',
            passed: 3,
            total: 4,
            percent: 75,
            status: 'needs-attention',
            checks: [
                { name: 'Protocol metadata preserved', passed: true },
                { name: 'Structured content preserved', passed: true },
                { name: 'UI resource reachable', passed: true },
                { name: 'Happy Web host available', passed: false },
            ],
        })).toEqual({
            title: 'Paws MCP Apps PR 1',
            eyebrow: 'MCP App · live tool result',
            score: '3 / 4',
            percentText: '75%',
            statusLabel: 'Needs attention',
            statusTone: 'warning',
            rows: [
                { label: 'Protocol metadata preserved', marker: 'Passed', tone: 'success' },
                { label: 'Structured content preserved', marker: 'Passed', tone: 'success' },
                { label: 'UI resource reachable', marker: 'Passed', tone: 'success' },
                { label: 'Happy Web host available', marker: 'Pending', tone: 'warning' },
            ],
        });
    });
});

describe('service-catalog MCP App view model', () => {
    const output = {
        kind: 'service-catalog' as const,
        title: 'Production service catalog',
        services: [
            { id: 'gateway', name: 'Gateway API', status: 'healthy' as const, region: 'Singapore', latencyMs: 82, version: 'v4.12.0', owner: 'Edge' },
            { id: 'sync', name: 'Sync Engine', status: 'degraded' as const, region: 'Frankfurt', latencyMs: 241, version: 'v3.8.2', owner: 'Realtime' },
            { id: 'media', name: 'Media Pipeline', status: 'maintenance' as const, region: 'Virginia', latencyMs: 134, version: 'v2.6.1', owner: 'Media' },
        ],
    };

    it('maps service cards and derives literal status counts', () => {
        expect(toServiceCatalogViewModel(output)).toEqual({
            title: 'Production service catalog',
            eyebrow: 'MCP App · horizontal collection',
            summary: '3 services · 1 needs attention',
            cards: [
                { id: 'gateway', name: 'Gateway API', statusLabel: 'Healthy', statusTone: 'success', region: 'Singapore', latency: '82 ms', version: 'v4.12.0', owner: 'Edge' },
                { id: 'sync', name: 'Sync Engine', statusLabel: 'Degraded', statusTone: 'warning', region: 'Frankfurt', latency: '241 ms', version: 'v3.8.2', owner: 'Realtime' },
                { id: 'media', name: 'Media Pipeline', statusLabel: 'Maintenance', statusTone: 'neutral', region: 'Virginia', latency: '134 ms', version: 'v2.6.1', owner: 'Media' },
            ],
        });
    });

    it('filters attention cards without treating planned maintenance as degraded', () => {
        const cards = toServiceCatalogViewModel(output).cards;
        expect(filterServiceCards(cards, 'attention').map((card) => card.id)).toEqual(['sync']);
        expect(filterServiceCards(cards, 'healthy').map((card) => card.id)).toEqual(['gateway']);
    });
});

describe('incident-board MCP App view model', () => {
    const output = {
        kind: 'incident-board' as const,
        title: 'Live incident command',
        incidents: [
            { id: 'inc-1042', title: 'Webhook delivery delays', severity: 'critical' as const, service: 'Gateway API', ageMinutes: 18, summary: 'Queue depth exceeded the alert threshold.', runbook: ['Freeze deploys', 'Drain backlog'] },
            { id: 'inc-1041', title: 'Search replica lag', severity: 'warning' as const, service: 'Search', ageMinutes: 43, summary: 'One replica is catching up.', runbook: ['Inspect replica', 'Rebalance reads'] },
        ],
    };

    it('maps incident severity, age and runbook steps', () => {
        expect(toIncidentBoardViewModel(output)).toEqual({
            title: 'Live incident command',
            eyebrow: 'MCP App · expandable workflow',
            summary: '2 active · 1 critical',
            rows: [
                { id: 'inc-1042', title: 'Webhook delivery delays', severityLabel: 'Critical', severityTone: 'danger', service: 'Gateway API', age: '18 min', summary: 'Queue depth exceeded the alert threshold.', runbook: ['Freeze deploys', 'Drain backlog'] },
                { id: 'inc-1041', title: 'Search replica lag', severityLabel: 'Warning', severityTone: 'warning', service: 'Search', age: '43 min', summary: 'One replica is catching up.', runbook: ['Inspect replica', 'Rebalance reads'] },
            ],
        });
    });

    it('filters incident rows by severity', () => {
        const rows = toIncidentBoardViewModel(output).rows;
        expect(filterIncidentRows(rows, 'critical').map((row) => row.id)).toEqual(['inc-1042']);
        expect(filterIncidentRows(rows, 'warning').map((row) => row.id)).toEqual(['inc-1041']);
    });
});

describe('deployment-planner MCP App view model', () => {
    const output = {
        kind: 'deployment-planner' as const,
        title: 'Progressive delivery plan',
        environments: [
            { id: 'preview', name: 'Preview', risk: 'low' as const },
            { id: 'production', name: 'Production', risk: 'elevated' as const },
        ],
        steps: [
            { id: 'tests', label: 'Verify automated checks', required: true, selected: true },
            { id: 'canary', label: 'Run a 10% canary', required: true, selected: true },
            { id: 'notify', label: 'Notify release channel', required: false, selected: false },
        ],
    };

    it('maps environments and preserves required step semantics', () => {
        expect(toDeploymentPlannerViewModel(output)).toEqual({
            title: 'Progressive delivery plan',
            eyebrow: 'MCP App · multi-step planner',
            environments: [
                { id: 'preview', name: 'Preview', riskLabel: 'Low risk', riskTone: 'success' },
                { id: 'production', name: 'Production', riskLabel: 'Elevated risk', riskTone: 'warning' },
            ],
            steps: [
                { id: 'tests', label: 'Verify automated checks', required: true, selected: true },
                { id: 'canary', label: 'Run a 10% canary', required: true, selected: true },
                { id: 'notify', label: 'Notify release channel', required: false, selected: false },
            ],
        });
    });

    it('summarizes the selected environment and enabled steps', () => {
        const view = toDeploymentPlannerViewModel(output);
        expect(summarizeDeploymentPlan(view, 'production', new Set(['tests', 'canary', 'notify']))).toEqual({
            environment: 'Production',
            risk: 'Elevated risk',
            stepCount: 3,
            summary: 'Production · 3 steps · Elevated risk',
        });
    });
});
