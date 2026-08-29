import {
    PluginCatalogItemSchema,
    PluginCatalogResponseSchema,
    PluginConnectionTestResultSchema,
    PluginInstallationStatusSchema,
} from '@slopus/happy-wire';
import type {
    PluginCatalogItem,
    PluginCatalogResponse,
    PluginConnectionTestResult,
    PluginInstallationStatus,
} from '@slopus/happy-wire';

import { apiSocket } from './apiSocket';

async function readResponse<T>(response: Response, parse: (value: unknown) => T): Promise<T> {
    if (!response.ok) throw new Error(`Plugin request failed: ${response.status}`);
    return parse(await response.json());
}

export async function getPluginCatalog(): Promise<PluginCatalogResponse> {
    return readResponse(
        await apiSocket.request('/v1/plugins'),
        (value) => PluginCatalogResponseSchema.parse(value),
    );
}

export async function getPlugin(pluginId: string): Promise<PluginCatalogItem> {
    return readResponse(
        await apiSocket.request(`/v1/plugins/${encodeURIComponent(pluginId)}`),
        (value) => PluginCatalogItemSchema.parse(value),
    );
}

export async function installPlugin(
    pluginId: string,
    version: string,
    configuration: Record<string, string>,
): Promise<PluginInstallationStatus> {
    return readResponse(
        await apiSocket.request(`/v1/plugins/${encodeURIComponent(pluginId)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ version, configuration }),
        }),
        (value) => PluginInstallationStatusSchema.parse(value),
    );
}

export async function uninstallPlugin(pluginId: string): Promise<PluginInstallationStatus> {
    return readResponse(
        await apiSocket.request(`/v1/plugins/${encodeURIComponent(pluginId)}`, { method: 'DELETE' }),
        (value) => PluginInstallationStatusSchema.parse(value),
    );
}

export async function testPluginConnection(
    pluginId: string,
    version: string,
    configuration: Record<string, string>,
): Promise<PluginConnectionTestResult> {
    return readResponse(
        await apiSocket.request(`/v1/plugins/${encodeURIComponent(pluginId)}/test-connection`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ version, configuration }),
        }),
        (value) => PluginConnectionTestResultSchema.parse(value),
    );
}
