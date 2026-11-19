/**
 * Agy (Antigravity CLI) Constants
 *
 * Centralized constants for the agy integration: the binary name, Happy's
 * logical model choices, their agy display-name mapping, defaults, and the
 * print-mode timeout. agy is a plain-text streaming CLI, so there are no
 * env-var-based API keys or MCP wiring like the Gemini ACP integration.
 */

import os from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { execFile, execSync } from 'node:child_process';

/** Default command name for the agy binary (looked up on PATH). */
export const AGY_BIN = 'agy';

/**
 * Find the installed agy executable.
 *
 * agy installs to `~/.local/bin`, which is frequently absent from a daemon's
 * PATH (launchd, or `happy daemon start` from a non-login shell), so spawning
 * the bare name fails with ENOENT even though agy is installed. Resolution order:
 *   1. `HAPPY_AGY_PATH` env override — an explicit absolute path to the binary.
 *   2. `agy` already resolvable on PATH (then spawn the bare name).
 *   3. `~/.local/bin/agy` — the Antigravity CLI installer's default location.
 *
 */
export function findAgyBin(): string | undefined {
  const override = process.env.HAPPY_AGY_PATH;
  if (override && existsSync(override)) {
    return override;
  }

  // Already on PATH? Then the bare name is enough (and respects PATH ordering).
  try {
    const probe = process.platform === 'win32'
      ? `where ${AGY_BIN}`
      : `command -v ${AGY_BIN}`;
    execSync(probe, { stdio: 'ignore', windowsHide: true });
    return AGY_BIN;
  } catch {
    // not on PATH — fall through to the known install location
  }

  const localBin = join(os.homedir(), '.local', 'bin', AGY_BIN);
  if (existsSync(localBin)) {
    return localBin;
  }

  return undefined;
}

/**
 * Resolve the agy executable to a spawnable command.
 *
 * Falls back to the bare command name when nothing matches, so the caller still
 * spawns and surfaces a clear ENOENT instead of silently doing nothing.
 */
export function resolveAgyBin(): string {
  return findAgyBin() ?? AGY_BIN;
}

export const AGY_GEMINI_4_NEON_MODEL = 'Gemini 4 Neon';
export const AGY_GEMINI_4_CARBON_MODEL = 'Gemini 4 Carbon';
export const AGY_GEMINI_4_ARGON_MODEL = 'Gemini 4 Argon';
export const AGY_GEMINI_4_HYDROGEN_MODEL = 'Gemini 4 Hydrogen';
export const AGY_ORCHESTRATOR_NEON_MODEL = 'Orchestrator (Neon)';
export const AGY_ORCHESTRATOR_CARBON_MODEL = 'Orchestrator (Carbon)';
export const AGY_ORCHESTRATOR_ARGON_MODEL = 'Orchestrator (Argon)';
export const AGY_GEMINI_3_8_FLASH_MODEL = 'Gemini 3.8 Flash';
export const AGY_CLAUDE_OPUS_5_5_MODEL = 'Claude Opus 5.5';
export const AGY_CLAUDE_SONNET_5_5_MODEL = 'Claude Sonnet 5.5';
export const AGY_GPT_OSS_120B_MODEL = 'GPT-OSS 120B (Medium)';

/**
 * Logical model names shown in Happy. Multi-effort families (Gemini 4, Gemini
 * 3.8 Flash, Claude 5.5) are one row here and resolved with the independent
 * effort selection below.
 */
export const AGY_MODELS = [
  AGY_GEMINI_4_NEON_MODEL,
  AGY_GEMINI_4_CARBON_MODEL,
  AGY_GEMINI_4_ARGON_MODEL,
  AGY_GEMINI_4_HYDROGEN_MODEL,
  AGY_ORCHESTRATOR_NEON_MODEL,
  AGY_ORCHESTRATOR_CARBON_MODEL,
  AGY_ORCHESTRATOR_ARGON_MODEL,
  AGY_GEMINI_3_8_FLASH_MODEL,
  AGY_CLAUDE_OPUS_5_5_MODEL,
  AGY_CLAUDE_SONNET_5_5_MODEL,
  AGY_GPT_OSS_120B_MODEL,
] as const;

export const AGY_EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const;
export type AgyEffort = typeof AGY_EFFORTS[number];

export const AGY_EFFORTS_BY_MODEL: Readonly<Record<string, readonly AgyEffort[]>> = {
  [AGY_GEMINI_4_NEON_MODEL]: ['low', 'medium', 'high', 'xhigh'],
  [AGY_GEMINI_4_CARBON_MODEL]: ['low', 'medium', 'high'],
  [AGY_GEMINI_4_ARGON_MODEL]: ['low', 'medium', 'high'],
  [AGY_GEMINI_4_HYDROGEN_MODEL]: ['low', 'medium', 'high', 'xhigh'],
  [AGY_GEMINI_3_8_FLASH_MODEL]: ['low', 'medium', 'high'],
  [AGY_CLAUDE_OPUS_5_5_MODEL]: ['low', 'medium', 'high'],
  [AGY_CLAUDE_SONNET_5_5_MODEL]: ['low', 'medium', 'high'],
};

export const AGY_MODEL_ALIASES: Readonly<Record<string, string>> = {
  neon: AGY_GEMINI_4_NEON_MODEL,
  carbon: AGY_GEMINI_4_CARBON_MODEL,
  argon: AGY_GEMINI_4_ARGON_MODEL,
  hydrogen: AGY_GEMINI_4_HYDROGEN_MODEL,
  flash: AGY_GEMINI_3_8_FLASH_MODEL,
  orchestrator: AGY_ORCHESTRATOR_CARBON_MODEL,
  'orchestrator-neon': AGY_ORCHESTRATOR_NEON_MODEL,
  'orchestrator-carbon': AGY_ORCHESTRATOR_CARBON_MODEL,
  'orchestrator-argon': AGY_ORCHESTRATOR_ARGON_MODEL,
  opus: AGY_CLAUDE_OPUS_5_5_MODEL,
  sonnet: AGY_CLAUDE_SONNET_5_5_MODEL,
};

/**
 * Default agy model. Gemini 4 Hydrogen is available across all Antigravity
 * tiers (including Free, Pro, and Ultra), unlike Argon (Pro/Ultra) and Carbon
 * (Ultra), and keeps the backend off Claude when used as a rate-limit fallback.
 */
export const DEFAULT_AGY_MODEL = AGY_GEMINI_4_HYDROGEN_MODEL;
export const DEFAULT_AGY_EFFORT: AgyEffort = 'medium';

export function normalizeAgyModelAlias(model: string): string {
  const trimmed = model.trim();
  return AGY_MODEL_ALIASES[trimmed.toLowerCase()] ?? trimmed;
}

export function normalizeAgyEffort(effort: string | null | undefined): AgyEffort {
  const normalized = effort?.trim().toLowerCase();
  return AGY_EFFORTS.includes(normalized as AgyEffort)
    ? (normalized as AgyEffort)
    : DEFAULT_AGY_EFFORT;
}

function formatAgyEffortLabel(effort: AgyEffort): string {
  if (effort === 'xhigh') {
    return 'XHigh';
  }
  return effort[0].toUpperCase() + effort.slice(1);
}

/**
 * Resolve Happy's model + effort picks to the exact display name accepted by
 * `agy --model`. Single-variant models (Orchestrator, GPT-OSS), raw agy model
 * slugs, and saved legacy display names pass through unchanged.
 */
export function resolveAgyModelName(
  model: string,
  effort: string | null | undefined,
): string {
  const canonical = normalizeAgyModelAlias(model);
  const supportedEfforts = AGY_EFFORTS_BY_MODEL[canonical];
  if (!supportedEfforts || supportedEfforts.length === 0) {
    return canonical;
  }
  const normalizedEffort = normalizeAgyEffort(effort);
  const resolvedEffort = supportedEfforts.includes(normalizedEffort)
    ? normalizedEffort
    : DEFAULT_AGY_EFFORT;
  return `${canonical} (${formatAgyEffortLabel(resolvedEffort)})`;
}

export interface AgyMetadataModelOption {
  code: string;
  value: string;
  description?: string;
}

/**
 * Collapse an agy display name to the model row Happy's pickers list:
 * "Gemini 4 Argon (High)" becomes "Gemini 4 Argon", whose effort is picked
 * separately. Single-variant names ("Orchestrator (Neon)", "GPT-OSS 120B
 * (Medium)") and unknown efforts pass through unchanged.
 */
export function agyModelFamily(label: string): string {
  const m = /^(.+) \(([^)]+)\)$/.exec(label);
  if (!m || !AGY_EFFORTS_BY_MODEL[m[1]]) {
    return label;
  }
  return AGY_EFFORTS.includes(m[2].toLowerCase() as AgyEffort) ? m[1] : label;
}

/**
 * The `agy models` list as one row per model, matching the iOS and Android
 * catalogs: the apps prefer `metadata.models` over their hardcoded list and
 * look effort levels up by row, so a flattened "Gemini 4 Argon (High)" row
 * would hide the effort picker.
 */
export function toAgyFamilyModelOptions(
  options: readonly AgyMetadataModelOption[],
): AgyMetadataModelOption[] {
  const seen = new Set<string>();
  const families: AgyMetadataModelOption[] = [];
  for (const option of options) {
    const family = agyModelFamily(option.code);
    if (seen.has(family)) continue;
    seen.add(family);
    families.push(family === option.code ? option : { code: family, value: family });
  }
  return families;
}

/** Published until `agy models` answers, and kept when it can't. */
export const FALLBACK_AGY_MODEL_OPTIONS: readonly AgyMetadataModelOption[] =
  AGY_MODELS.map((model) => ({ code: model, value: model }));

/**
 * The model to run when none was asked for: Gemini 4 Hydrogen, or Gemini 3.8
 * Flash when the account's `agy models` doesn't list Hydrogen, so a tier
 * without it doesn't fail every turn.
 */
export function pickDefaultAgyModel(available: readonly string[]): string {
  return available.includes(DEFAULT_AGY_MODEL) ? DEFAULT_AGY_MODEL : AGY_GEMINI_3_8_FLASH_MODEL;
}

/**
 * Parse `agy models` stdout (`<slug>\t<Display Name>`) into session metadata
 * model options so web, iOS, Android, and terminal pickers always reflect the
 * live models installed in the user's Antigravity CLI.
 */
export function parseAgyModelsOutput(raw: string): AgyMetadataModelOption[] {
  const clean = raw.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '');
  const seen = new Set<string>();
  const parsed: AgyMetadataModelOption[] = [];
  for (const line of clean.split(/[\r\n]+/)) {
    const m = /^([a-z0-9._-]+)(?:\t|\s{2,})(.+?)\s*$/.exec(line);
    if (!m) continue;
    const slug = m[1];
    const label = m[2];
    if (seen.has(label)) continue;
    seen.add(label);
    parsed.push({ code: label, value: label, description: slug });
  }
  return parsed;
}

/**
 * Ask `agy models` for the account's models, one row per model. Resolves to
 * null when agy is missing, offline, unauthenticated, or lists nothing; the
 * session keeps FALLBACK_AGY_MODEL_OPTIONS then.
 */
export function discoverAgyModelOptions(): Promise<AgyMetadataModelOption[] | null> {
  return new Promise((resolve) => {
    try {
      const child = execFile(resolveAgyBin(), ['models'], {
        encoding: 'utf8',
        timeout: 4_000,
        windowsHide: true,
      }, (error, stdout) => {
        const parsed = error ? [] : toAgyFamilyModelOptions(parseAgyModelsOutput(stdout));
        resolve(parsed.length > 0 ? parsed : null);
      });
      child.stdin?.end();
    } catch {
      resolve(null);
    }
  });
}

/** Timeout passed to `agy --print-timeout` for a single print turn. */
export const AGY_PRINT_TIMEOUT = '10m';

/**
 * Path to agy's per-workspace conversation cache. agy records the most recent
 * conversation id for each cwd here; print mode does not echo the id, so this is
 * how we recover it for `--conversation`-based resume.
 */
export const AGY_CONVERSATIONS_CACHE = join(
  os.homedir(),
  '.gemini',
  'antigravity-cli',
  'cache',
  'last_conversations.json',
);
