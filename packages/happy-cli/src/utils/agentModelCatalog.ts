import { execFileSync } from 'child_process';

/**
 * One model an agent installed on this machine says it can run.
 *
 * The shape is deliberately the agent's own answer rather than Happy's: `id` is
 * what gets passed back to the CLI, `name` is what a person reads, and the
 * efforts are the levels that model accepts, in the order the agent lists them.
 * Nothing here is interpreted, so a model Happy has never heard of travels
 * intact.
 */
export interface AgentModel {
    id: string;
    name: string;
    description: string | null;
    efforts: string[];
    defaultEffort: string | null;
}

export interface AgentModelCatalog {
    models: AgentModel[];
    detectedAt: number;
}

/** Keyed by agent flavor, and only for agents that answered. */
export type AgentModelCatalogs = Record<string, AgentModelCatalog>;

/** How long an agent gets to print its catalog before we give up on it. */
const CATALOG_TIMEOUT_MS = 10_000;

/** Codex's catalog is a few hundred KB of prompts around the model list. */
const CATALOG_MAX_BUFFER = 8 * 1024 * 1024;

/**
 * The models Codex offers, read from `codex debug models`.
 *
 * Codex publishes far more than it offers: models it hides from its own picker
 * (`visibility` other than `list`) are internal, and `priority` is the order it
 * means them to appear in. Both are honoured here so Happy's picker reads like
 * Codex's own, rather than like whatever order the registry happens to use.
 *
 * Returns null rather than an empty list when the answer cannot be read, so a
 * caller can tell "this agent has no models" from "this agent did not answer".
 */
export function parseCodexModelCatalog(raw: string): AgentModel[] | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }
    const models = (parsed as { models?: unknown })?.models;
    if (!Array.isArray(models)) return null;

    const listed = models
        .filter((model): model is Record<string, any> =>
            typeof model === 'object' && model !== null
            && typeof model.slug === 'string' && model.slug.length > 0
            && model.visibility === 'list')
        .sort((a, b) => priorityOf(a) - priorityOf(b))
        .map((model): AgentModel => ({
            id: model.slug,
            name: typeof model.display_name === 'string' && model.display_name.length > 0
                ? model.display_name
                : model.slug,
            description: typeof model.description === 'string' && model.description.length > 0
                ? model.description
                : null,
            efforts: Array.isArray(model.supported_reasoning_levels)
                ? model.supported_reasoning_levels
                    .map((level: unknown) => (level as { effort?: unknown })?.effort)
                    .filter((effort: unknown): effort is string => typeof effort === 'string')
                : [],
            defaultEffort: typeof model.default_reasoning_level === 'string'
                ? model.default_reasoning_level
                : null,
        }));

    return listed;
}

/** A model with no stated priority sorts after every model that has one. */
function priorityOf(model: Record<string, any>): number {
    return typeof model.priority === 'number' ? model.priority : Number.MAX_SAFE_INTEGER;
}

/**
 * How each agent is asked for its models.
 *
 * Only Codex publishes a catalog today. The others keep the lists Happy ships,
 * which is what an absent entry here means: not "no models", but "nothing on
 * this machine can be asked".
 */
const CATALOG_READERS: Record<string, () => AgentModel[] | null> = {
    codex: () => {
        const raw = runAgent('codex', ['debug', 'models']);
        return raw === null ? null : parseCodexModelCatalog(raw);
    },
};

function runAgent(command: string, args: string[]): string | null {
    try {
        return execFileSync(command, args, {
            encoding: 'utf8',
            timeout: CATALOG_TIMEOUT_MS,
            maxBuffer: CATALOG_MAX_BUFFER,
            stdio: ['ignore', 'pipe', 'ignore'],
        });
    } catch {
        // Not installed, too old for the subcommand, or killed by the OS. All
        // of them mean the same thing to the caller, and none of them is worth
        // failing a metadata refresh over.
        return null;
    }
}

/**
 * Read the model catalog of every agent available on this machine.
 *
 * `available` is the CLI availability already detected, so an agent that is not
 * installed is never executed. An agent that answers nothing is left out
 * entirely: the app falls back to its own list for exactly those.
 */
export function detectAgentModelCatalogs(available: object): AgentModelCatalogs {
    // Typed as `object` so the caller can pass its own availability interface,
    // which has no index signature, without reshaping it first.
    const flags = available as Record<string, unknown>;
    const detectedAt = Date.now();
    const catalogs: AgentModelCatalogs = {};
    for (const [agent, read] of Object.entries(CATALOG_READERS)) {
        if (flags[agent] !== true) continue;
        const models = read();
        if (!models || models.length === 0) continue;
        catalogs[agent] = { models, detectedAt };
    }
    return catalogs;
}

/** Whether two catalogs say the same thing, for deciding to republish. */
export function sameAgentModelCatalogs(a: AgentModelCatalogs | undefined, b: AgentModelCatalogs | undefined): boolean {
    return stripTimestamps(a) === stripTimestamps(b);
}

function stripTimestamps(catalogs: AgentModelCatalogs | undefined): string {
    if (!catalogs) return '';
    return JSON.stringify(
        Object.keys(catalogs).sort().map((agent) => [agent, catalogs[agent].models]),
    );
}
