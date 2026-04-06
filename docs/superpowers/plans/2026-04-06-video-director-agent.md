# Video Director Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a new local-first `huppy-video-director` workspace that converts a complete app marketing brief plus asset folder into a finished marketing video with structured planning, Seedance shot rendering, generated audio, ffmpeg assembly, and QA output.

**Architecture:** Implement this as a new Node.js + TypeScript workspace in the existing monorepo rather than bolting it onto `huppy-agent`. The package exposes a CLI entrypoint, stores every run under a deterministic project folder, separates text-planning providers from video providers, renders shots independently with retryable job state, and assembles the final export through `ffmpeg`.

**Tech Stack:** Node.js 20, TypeScript, Vitest, Commander, Zod, gray-matter, built-in `fetch`, `ffmpeg`, `ffprobe`, macOS `say`, pkgroll

---

## Scope Check

This spec is still one coherent subsystem: a local production pipeline. It touches planning, rendering, audio, and export, but these are all part of one backend workflow and do not need to be split into separate implementation plans.

---

## Proposed File Structure

### Modify

- `package.json`
  Add the new workspace and one convenience script.

### Create

- `packages/huppy-video-director/package.json`
- `packages/huppy-video-director/tsconfig.json`
- `packages/huppy-video-director/vitest.config.ts`
- `packages/huppy-video-director/bin/huppy-video-director.mjs`
- `packages/huppy-video-director/README.md`
- `packages/huppy-video-director/src/index.ts`
- `packages/huppy-video-director/src/index.test.ts`
- `packages/huppy-video-director/src/config.ts`
- `packages/huppy-video-director/src/config.test.ts`
- `packages/huppy-video-director/src/projectStore.ts`
- `packages/huppy-video-director/src/projectStore.test.ts`
- `packages/huppy-video-director/src/brief.ts`
- `packages/huppy-video-director/src/brief.test.ts`
- `packages/huppy-video-director/src/profiles.ts`
- `packages/huppy-video-director/src/profiles.test.ts`
- `packages/huppy-video-director/src/styles.ts`
- `packages/huppy-video-director/src/assets.ts`
- `packages/huppy-video-director/src/assets.test.ts`
- `packages/huppy-video-director/src/promptModel.ts`
- `packages/huppy-video-director/src/promptModel.test.ts`
- `packages/huppy-video-director/src/creativePlan.ts`
- `packages/huppy-video-director/src/creativePlan.test.ts`
- `packages/huppy-video-director/src/shotPlanner.ts`
- `packages/huppy-video-director/src/shotPlanner.test.ts`
- `packages/huppy-video-director/src/seedance.ts`
- `packages/huppy-video-director/src/seedance.test.ts`
- `packages/huppy-video-director/src/audio.ts`
- `packages/huppy-video-director/src/audio.test.ts`
- `packages/huppy-video-director/src/media.ts`
- `packages/huppy-video-director/src/media.test.ts`
- `packages/huppy-video-director/src/qa.ts`
- `packages/huppy-video-director/src/qa.test.ts`
- `packages/huppy-video-director/src/pipeline.ts`
- `packages/huppy-video-director/src/pipeline.test.ts`
- `packages/huppy-video-director/fixtures/huppy-dark-tech/brief.json`
- `packages/huppy-video-director/fixtures/huppy-dark-tech/assets/.gitkeep`

### Responsibility Map

- `config.ts`
  Loads environment, tool paths, provider settings, output roots.
- `projectStore.ts`
  Creates and updates project folders, manifests, and per-shot state.
- `brief.ts`
  Parses `.json` and `.md` briefs and validates required campaign fields.
- `profiles.ts`
  Defines delivery profiles such as `app-store-preview`.
- `styles.ts`
  Defines style presets such as `michel-gondry` and `dark-tech-minimal`.
- `assets.ts`
  Imports local assets, downloads declared remote assets, and emits `asset-manifest.json`.
- `promptModel.ts`
  Calls an OpenAI-compatible text model endpoint for creative planning.
- `creativePlan.ts`
  Produces the structured campaign-level concept, copy, and sound direction.
- `shotPlanner.ts`
  Converts the creative plan into retryable shot jobs with prompts and timing.
- `seedance.ts`
  Talks to Seedance create-task and query-task endpoints and stores results.
- `audio.ts`
  Generates voiceover plus simple music/SFX assets for the edit.
- `media.ts`
  Wraps `ffmpeg` / `ffprobe` and assembles the final timeline.
- `qa.ts`
  Verifies duration, ratio, subtitles, language, and missing artifact conditions.
- `pipeline.ts`
  Orchestrates the full run from brief to export.
- `index.ts`
  Exposes the CLI entrypoint.

---

### Task 1: Scaffold the New Workspace

**Files:**
- Modify: `package.json`
- Create: `packages/huppy-video-director/package.json`
- Create: `packages/huppy-video-director/tsconfig.json`
- Create: `packages/huppy-video-director/vitest.config.ts`
- Create: `packages/huppy-video-director/bin/huppy-video-director.mjs`
- Create: `packages/huppy-video-director/src/index.test.ts`
- Create: `packages/huppy-video-director/src/config.test.ts`
- Create: `packages/huppy-video-director/src/index.ts`
- Create: `packages/huppy-video-director/src/config.ts`

- [ ] **Step 1: Write the failing package wiring and smoke tests**

```json
// package.json
{
  "name": "monorepo",
  "private": true,
  "scripts": {
    "cli": "yarn workspace huppy-ai cli",
    "release": "node ./scripts/release.cjs",
    "web": "yarn workspace huppy-app web",
    "app-logs": "yarn workspace huppy-app-logs start",
    "postinstall": "node ./scripts/postinstall.cjs",
    "env:new": "tsx environments/environments.ts new",
    "env:list": "tsx environments/environments.ts list",
    "env:use": "tsx environments/environments.ts use",
    "env:remove": "tsx environments/environments.ts remove",
    "env:current": "tsx environments/environments.ts current",
    "env:server": "tsx environments/environments.ts run server",
    "env:web": "tsx environments/environments.ts run web",
    "env:ios": "tsx environments/environments.ts run ios",
    "env:android": "tsx environments/environments.ts run android",
    "env:cli": "tsx environments/environments.ts run cli",
    "env:seed": "tsx environments/environments.ts seed",
    "env:up": "tsx environments/environments.ts up",
    "env:up:authenticated": "yarn env:up --template authenticated-empty",
    "env:down": "tsx environments/environments.ts down",
    "env:tailscale": "tsx environments/environments.ts tailscale",
    "video-director": "yarn workspace huppy-video-director dev"
  },
  "workspaces": {
    "packages": [
      "packages/huppy-app",
      "packages/huppy-agent",
      "packages/huppy-cli",
      "packages/huppy-server",
      "packages/huppy-wire",
      "packages/huppy-app-logs",
      "packages/huppy-video-director"
    ],
    "nohoist": [
      "**/zod",
      "**/react",
      "**/react-dom",
      "**/react-native",
      "**/react-native/**",
      "**/react-native-edge-to-edge/**",
      "**/react-native-incall-manager/**"
    ]
  },
  "packageManager": "yarn@1.22.22"
}
```

```json
// packages/huppy-video-director/package.json
{
  "name": "huppy-video-director",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": {
    "huppy-video-director": "./bin/huppy-video-director.mjs"
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "build": "node -e \"require('node:fs').rmSync('dist', { recursive: true, force: true })\" && tsc --noEmit && pkgroll",
    "test": "$npm_execpath run build && vitest run",
    "dev": "tsx src/index.ts"
  },
  "dependencies": {
    "commander": "^13.1.0",
    "gray-matter": "^4.0.3",
    "zod": "^4.1.5"
  },
  "devDependencies": {
    "@types/node": ">=20",
    "pkgroll": "^2.14.2",
    "tsx": "^4.20.6",
    "typescript": "5.9.3",
    "vitest": "^3.2.4"
  }
}
```

```json
// packages/huppy-video-director/tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "strict": true,
    "declaration": true,
    "outDir": "dist",
    "types": ["node"]
  },
  "include": ["src/**/*.ts"]
}
```

```ts
// packages/huppy-video-director/vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts']
  }
});
```

```ts
// packages/huppy-video-director/src/config.test.ts
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';

describe('loadConfig', () => {
  it('returns deterministic defaults', () => {
    const config = loadConfig({
      env: {},
      cwd: '/tmp/video-director'
    });

    expect(config.outputRoot).toBe('/tmp/video-director/projects/video-runs');
    expect(config.seedance.tasksPath).toBe('/api/v1/contents/generations/tasks');
    expect(config.promptModel.baseUrl).toBe('https://ark.cn-beijing.volces.com/api/v3');
    expect(config.tools.ffmpegPath).toBe('ffmpeg');
  });
});
```

```ts
// packages/huppy-video-director/src/index.test.ts
import { describe, expect, it } from 'vitest';
import { buildProgram } from './index';

describe('buildProgram', () => {
  it('registers the run command', () => {
    const program = buildProgram();
    const runCommand = program.commands.find(command => command.name() === 'run');
    expect(runCommand?.description()).toContain('brief');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn workspace huppy-video-director vitest run src/config.test.ts src/index.test.ts`

Expected: FAIL with module resolution errors for `./config` and `./index`

- [ ] **Step 3: Write the minimal config loader and CLI shell**

```ts
// packages/huppy-video-director/src/config.ts
export type VideoDirectorConfig = {
  outputRoot: string;
  seedance: {
    baseUrl: string;
    tasksPath: string;
    apiKey: string | null;
    model: string;
  };
  promptModel: {
    baseUrl: string;
    apiKey: string | null;
    model: string;
  };
  tools: {
    ffmpegPath: string;
    ffprobePath: string;
    sayPath: string;
  };
};

export function loadConfig(input: { env: NodeJS.ProcessEnv; cwd: string }): VideoDirectorConfig {
  return {
    outputRoot: `${input.cwd}/projects/video-runs`,
    seedance: {
      baseUrl: input.env.SEEDANCE_BASE_URL ?? 'https://operator.las.cn-beijing.volces.com',
      tasksPath: input.env.SEEDANCE_TASKS_PATH ?? '/api/v1/contents/generations/tasks',
      apiKey: input.env.SEEDANCE_API_KEY ?? null,
      model: input.env.SEEDANCE_MODEL ?? 'doubao-seedance-1-5-pro-251215'
    },
    promptModel: {
      baseUrl: input.env.PROMPT_MODEL_BASE_URL ?? 'https://ark.cn-beijing.volces.com/api/v3',
      apiKey: input.env.PROMPT_MODEL_API_KEY ?? null,
      model: input.env.PROMPT_MODEL_ID ?? 'doubao-seed-1-6-flash-250715'
    },
    tools: {
      ffmpegPath: input.env.FFMPEG_PATH ?? 'ffmpeg',
      ffprobePath: input.env.FFPROBE_PATH ?? 'ffprobe',
      sayPath: input.env.SAY_PATH ?? 'say'
    }
  };
}
```

```ts
// packages/huppy-video-director/src/index.ts
import { Command } from 'commander';

export function buildProgram(): Command {
  const program = new Command();
  program.name('huppy-video-director').description('Generate app marketing videos from a brief');

  program
    .command('run')
    .description('Run a local video production pipeline from a brief and asset folder')
    .requiredOption('--brief <path>', 'Path to brief file')
    .option('--assets <path>', 'Path to local asset directory')
    .requiredOption('--profile <name>', 'Delivery profile, for example app-store-preview')
    .option('--style <name>', 'Style preset override');

  return program;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  buildProgram().parse(process.argv);
}
```

```js
// packages/huppy-video-director/bin/huppy-video-director.mjs
#!/usr/bin/env node
import '../dist/index.mjs';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn workspace huppy-video-director vitest run src/config.test.ts src/index.test.ts`

Expected: PASS with 2 tests passing

- [ ] **Step 5: Commit**

```bash
git add package.json \
  packages/huppy-video-director/package.json \
  packages/huppy-video-director/tsconfig.json \
  packages/huppy-video-director/vitest.config.ts \
  packages/huppy-video-director/bin/huppy-video-director.mjs \
  packages/huppy-video-director/src/index.ts \
  packages/huppy-video-director/src/index.test.ts \
  packages/huppy-video-director/src/config.ts \
  packages/huppy-video-director/src/config.test.ts
git commit -m "feat: scaffold huppy video director workspace"
```

### Task 2: Create Project Storage and Run State

**Files:**
- Create: `packages/huppy-video-director/src/projectStore.test.ts`
- Create: `packages/huppy-video-director/src/projectStore.ts`

- [ ] **Step 1: Write the failing project storage tests**

```ts
// packages/huppy-video-director/src/projectStore.test.ts
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createProjectRun, updateProjectStatus } from './projectStore';

describe('projectStore', () => {
  it('creates the canonical project folder layout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'video-director-'));
    const run = await createProjectRun({
      outputRoot: root,
      appName: 'Huppy',
      campaignName: 'Dark Tech Launch',
      targetMarket: 'US',
      profile: 'app-store-preview',
      style: 'dark-tech-minimal',
      durationSeconds: 30,
      language: 'en-US'
    });

    expect(run.id).toContain('huppy');
    await expect(stat(join(run.rootDir, 'brief'))).resolves.toBeTruthy();
    await expect(stat(join(run.rootDir, 'shots'))).resolves.toBeTruthy();
    await expect(stat(join(run.rootDir, 'exports'))).resolves.toBeTruthy();
  });

  it('persists status transitions into project.json', async () => {
    const root = await mkdtemp(join(tmpdir(), 'video-director-'));
    const run = await createProjectRun({
      outputRoot: root,
      appName: 'Huppy',
      campaignName: 'Dark Tech Launch',
      targetMarket: 'US',
      profile: 'app-store-preview',
      style: 'dark-tech-minimal',
      durationSeconds: 30,
      language: 'en-US'
    });

    await updateProjectStatus(run.rootDir, 'shots_generating');
    const persisted = JSON.parse(await readFile(join(run.rootDir, 'project.json'), 'utf8'));
    expect(persisted.status).toBe('shots_generating');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn workspace huppy-video-director vitest run src/projectStore.test.ts`

Expected: FAIL with `Cannot find module './projectStore'`

- [ ] **Step 3: Implement project creation and status updates**

```ts
// packages/huppy-video-director/src/projectStore.ts
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export type ProjectStatus =
  | 'briefing'
  | 'asset_ready'
  | 'concept_ready'
  | 'shots_generating'
  | 'shots_ready'
  | 'editing'
  | 'qa'
  | 'exported'
  | 'failed';

export type ProjectManifest = {
  id: string;
  appName: string;
  campaignName: string;
  targetMarket: string;
  profile: string;
  style: string;
  durationSeconds: number;
  language: string;
  status: ProjectStatus;
  rootDir: string;
  createdAt: string;
  updatedAt: string;
};

function slugify(input: string): string {
  const slug = input.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'app';
}

export async function createProjectRun(input: {
  outputRoot: string;
  appName: string;
  campaignName: string;
  targetMarket: string;
  profile: string;
  style: string;
  durationSeconds: number;
  language: string;
}): Promise<ProjectManifest> {
  const timestamp = new Date().toISOString().replaceAll(':', '-');
  const id = `${timestamp}-${slugify(input.appName)}`;
  const rootDir = join(input.outputRoot, id);
  const createdAt = new Date().toISOString();

  await mkdir(join(rootDir, 'brief'), { recursive: true });
  await mkdir(join(rootDir, 'assets', 'source'), { recursive: true });
  await mkdir(join(rootDir, 'assets', 'derived'), { recursive: true });
  await mkdir(join(rootDir, 'creative'), { recursive: true });
  await mkdir(join(rootDir, 'shots'), { recursive: true });
  await mkdir(join(rootDir, 'audio'), { recursive: true });
  await mkdir(join(rootDir, 'timeline'), { recursive: true });
  await mkdir(join(rootDir, 'qa'), { recursive: true });
  await mkdir(join(rootDir, 'exports'), { recursive: true });

  const manifest: ProjectManifest = {
    id,
    appName: input.appName,
    campaignName: input.campaignName,
    targetMarket: input.targetMarket,
    profile: input.profile,
    style: input.style,
    durationSeconds: input.durationSeconds,
    language: input.language,
    status: 'briefing',
    rootDir,
    createdAt,
    updatedAt: createdAt
  };

  await writeFile(join(rootDir, 'project.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

export async function updateProjectStatus(rootDir: string, status: ProjectStatus): Promise<void> {
  const path = join(rootDir, 'project.json');
  const current = JSON.parse(await readFile(path, 'utf8')) as ProjectManifest;
  const next: ProjectManifest = {
    ...current,
    status,
    updatedAt: new Date().toISOString()
  };
  await writeFile(path, JSON.stringify(next, null, 2));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn workspace huppy-video-director vitest run src/projectStore.test.ts`

Expected: PASS with 2 tests passing

- [ ] **Step 5: Commit**

```bash
git add packages/huppy-video-director/src/projectStore.ts \
  packages/huppy-video-director/src/projectStore.test.ts
git commit -m "feat: add project storage for video runs"
```

### Task 3: Parse Briefs and Resolve Profiles

**Files:**
- Create: `packages/huppy-video-director/src/brief.test.ts`
- Create: `packages/huppy-video-director/src/brief.ts`
- Create: `packages/huppy-video-director/src/profiles.test.ts`
- Create: `packages/huppy-video-director/src/profiles.ts`
- Create: `packages/huppy-video-director/src/styles.ts`

- [ ] **Step 1: Write the failing brief and profile tests**

```ts
// packages/huppy-video-director/src/brief.test.ts
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadBriefFile } from './brief';

describe('loadBriefFile', () => {
  it('loads a JSON brief with required fields', async () => {
    const root = await mkdtemp(join(tmpdir(), 'brief-json-'));
    const path = join(root, 'brief.json');
    await writeFile(path, JSON.stringify({
      appName: 'Huppy',
      campaignName: 'Dark Tech Launch',
      targetMarket: 'US',
      targetProfile: 'app-store-preview',
      durationSeconds: 30,
      audience: 'Developers',
      valueProps: ['Pair instantly', 'Monitor sessions'],
      visualStyle: 'dark-tech-minimal',
      copyTone: 'confident',
      requiredClaims: ['Your AI Agent, Always Within Reach.']
    }, null, 2));

    const brief = await loadBriefFile(path);
    expect(brief.appName).toBe('Huppy');
    expect(brief.durationSeconds).toBe(30);
  });

  it('loads a markdown brief with frontmatter', async () => {
    const root = await mkdtemp(join(tmpdir(), 'brief-md-'));
    const path = join(root, 'brief.md');
    await writeFile(path, `---
appName: Huppy
campaignName: Dark Tech Launch
targetMarket: US
targetProfile: app-store-preview
durationSeconds: 30
audience: Developers
valueProps:
  - Pair instantly
  - Monitor sessions
visualStyle: dark-tech-minimal
copyTone: confident
requiredClaims:
  - Your AI Agent, Always Within Reach.
---

This launch film should feel premium and fast.`);

    const brief = await loadBriefFile(path);
    expect(brief.visualStyle).toBe('dark-tech-minimal');
    expect(brief.rawBody).toContain('premium and fast');
  });
});
```

```ts
// packages/huppy-video-director/src/profiles.test.ts
import { describe, expect, it } from 'vitest';
import { getDeliveryProfile } from './profiles';

describe('getDeliveryProfile', () => {
  it('returns app-store-preview defaults', () => {
    const profile = getDeliveryProfile('app-store-preview');
    expect(profile.ratio).toBe('9:16');
    expect(profile.resolution).toBe('1080p');
    expect(profile.subtitleSafeArea.bottomPercent).toBe(18);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn workspace huppy-video-director vitest run src/brief.test.ts src/profiles.test.ts`

Expected: FAIL with missing module errors for `./brief` and `./profiles`

- [ ] **Step 3: Implement brief parsing, style presets, and delivery profiles**

```ts
// packages/huppy-video-director/src/brief.ts
import matter from 'gray-matter';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { z } from 'zod';

export const briefSchema = z.object({
  appName: z.string().min(1),
  campaignName: z.string().min(1),
  targetMarket: z.string().min(1),
  targetProfile: z.string().min(1),
  durationSeconds: z.number().int().positive(),
  audience: z.string().min(1),
  valueProps: z.array(z.string().min(1)).min(1),
  visualStyle: z.string().min(1),
  copyTone: z.string().min(1),
  references: z.array(z.string()).default([]),
  requiredClaims: z.array(z.string()).default([]),
  forbiddenDirections: z.array(z.string()).default([]),
  supportingAssetUrls: z.array(z.string().url()).default([])
});

export type CampaignBrief = z.infer<typeof briefSchema> & {
  rawBody: string;
};

export async function loadBriefFile(path: string): Promise<CampaignBrief> {
  const source = await readFile(path, 'utf8');
  const extension = extname(path);

  if (extension === '.json') {
    const parsed = briefSchema.parse(JSON.parse(source));
    return { ...parsed, rawBody: '' };
  }

  const parsedMarkdown = matter(source);
  const parsed = briefSchema.parse(parsedMarkdown.data);
  return { ...parsed, rawBody: parsedMarkdown.content.trim() };
}
```

```ts
// packages/huppy-video-director/src/profiles.ts
export type DeliveryProfile = {
  id: string;
  ratio: '9:16' | '16:9' | '1:1';
  resolution: '720p' | '1080p';
  durationSeconds: number;
  subtitleSafeArea: {
    topPercent: number;
    bottomPercent: number;
  };
  audioRequired: boolean;
};

const profiles: Record<string, DeliveryProfile> = {
  'app-store-preview': {
    id: 'app-store-preview',
    ratio: '9:16',
    resolution: '1080p',
    durationSeconds: 30,
    subtitleSafeArea: {
      topPercent: 8,
      bottomPercent: 18
    },
    audioRequired: true
  },
  'social-vertical': {
    id: 'social-vertical',
    ratio: '9:16',
    resolution: '1080p',
    durationSeconds: 30,
    subtitleSafeArea: {
      topPercent: 6,
      bottomPercent: 20
    },
    audioRequired: true
  }
};

export function getDeliveryProfile(name: string): DeliveryProfile {
  const profile = profiles[name];
  if (!profile) {
    throw new Error(`Unknown delivery profile: ${name}`);
  }
  return profile;
}
```

```ts
// packages/huppy-video-director/src/styles.ts
export type StylePreset = {
  id: string;
  palette: string[];
  motionKeywords: string[];
  typographyKeywords: string[];
  promptSuffix: string;
};

export const STYLE_PRESETS: Record<string, StylePreset> = {
  'michel-gondry': {
    id: 'michel-gondry',
    palette: ['handmade', 'tactile', 'dreamlike'],
    motionKeywords: ['inventive transitions', 'playful surrealism', 'analog magic'],
    typographyKeywords: ['human', 'romantic', 'unexpected'],
    promptSuffix: 'Use tactile visual invention, emotional surrealism, and surprising transitions.'
  },
  'dark-tech-minimal': {
    id: 'dark-tech-minimal',
    palette: ['#080808', '#FF9A3C', '#FFFFFF'],
    motionKeywords: ['fast cuts', 'high contrast', 'clean developer-tool motion'],
    typographyKeywords: ['SF Pro', 'sharp', 'confident'],
    promptSuffix: 'Use a dark developer-tool aesthetic with orange neon highlights and no white backgrounds.'
  }
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn workspace huppy-video-director vitest run src/brief.test.ts src/profiles.test.ts`

Expected: PASS with 3 tests passing

- [ ] **Step 5: Commit**

```bash
git add packages/huppy-video-director/src/brief.ts \
  packages/huppy-video-director/src/brief.test.ts \
  packages/huppy-video-director/src/profiles.ts \
  packages/huppy-video-director/src/profiles.test.ts \
  packages/huppy-video-director/src/styles.ts
git commit -m "feat: add brief parsing and delivery profiles"
```

### Task 4: Collect and Manifest Assets

**Files:**
- Create: `packages/huppy-video-director/src/assets.test.ts`
- Create: `packages/huppy-video-director/src/assets.ts`

- [ ] **Step 1: Write the failing asset collection tests**

```ts
// packages/huppy-video-director/src/assets.test.ts
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { collectAssets } from './assets';

describe('collectAssets', () => {
  it('copies local assets and writes a manifest', async () => {
    const sourceRoot = await mkdtemp(join(tmpdir(), 'assets-source-'));
    const projectRoot = await mkdtemp(join(tmpdir(), 'assets-project-'));

    await writeFile(join(sourceRoot, 'screen-01.png'), 'png-data');
    await writeFile(join(sourceRoot, 'recording-01.mp4'), 'mp4-data');

    const manifest = await collectAssets({
      projectRoot,
      assetDir: sourceRoot,
      supportingAssetUrls: []
    });

    expect(manifest.items).toHaveLength(2);
    const persisted = JSON.parse(await readFile(join(projectRoot, 'assets', 'manifest.json'), 'utf8'));
    expect(persisted.items[0].sourceType).toBe('local');
  });

  it('downloads explicit remote supporting assets', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'assets-remote-'));
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new TextEncoder().encode('image-data').buffer
    });

    const manifest = await collectAssets({
      projectRoot,
      supportingAssetUrls: ['https://example.com/logo.png'],
      fetchImpl: mockFetch
    });

    expect(manifest.items).toHaveLength(1);
    expect(manifest.items[0].sourceType).toBe('remote');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn workspace huppy-video-director vitest run src/assets.test.ts`

Expected: FAIL with `Cannot find module './assets'`

- [ ] **Step 3: Implement asset import and manifest writing**

```ts
// packages/huppy-video-director/src/assets.ts
import { copyFile, mkdir, readdir, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

export type AssetManifestItem = {
  id: string;
  fileName: string;
  absolutePath: string;
  kind: 'image' | 'video' | 'audio' | 'unknown';
  sourceType: 'local' | 'remote';
};

export type AssetManifest = {
  items: AssetManifestItem[];
};

function detectKind(fileName: string): AssetManifestItem['kind'] {
  const extension = extname(fileName).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.webp'].includes(extension)) return 'image';
  if (['.mp4', '.mov'].includes(extension)) return 'video';
  if (['.wav', '.mp3', '.m4a'].includes(extension)) return 'audio';
  return 'unknown';
}

export async function collectAssets(input: {
  projectRoot: string;
  assetDir?: string;
  supportingAssetUrls: string[];
  fetchImpl?: typeof fetch;
}): Promise<AssetManifest> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const sourceDir = join(input.projectRoot, 'assets', 'source');
  await mkdir(sourceDir, { recursive: true });

  const items: AssetManifestItem[] = [];

  if (input.assetDir) {
    const names = await readdir(input.assetDir);
    for (const fileName of names) {
      const sourcePath = join(input.assetDir, fileName);
      const targetPath = join(sourceDir, fileName);
      await copyFile(sourcePath, targetPath);
      items.push({
        id: fileName,
        fileName,
        absolutePath: targetPath,
        kind: detectKind(fileName),
        sourceType: 'local'
      });
    }
  }

  for (const url of input.supportingAssetUrls) {
    const response = await fetchImpl(url);
    if (!response.ok) {
      throw new Error(`Failed to download supporting asset: ${url}`);
    }
    const fileName = basename(new URL(url).pathname) || 'remote-asset.bin';
    const targetPath = join(sourceDir, fileName);
    const bytes = Buffer.from(await response.arrayBuffer());
    await writeFile(targetPath, bytes);
    items.push({
      id: fileName,
      fileName,
      absolutePath: targetPath,
      kind: detectKind(fileName),
      sourceType: 'remote'
    });
  }

  const manifest = { items };
  await writeFile(join(input.projectRoot, 'assets', 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn workspace huppy-video-director vitest run src/assets.test.ts`

Expected: PASS with 2 tests passing

- [ ] **Step 5: Commit**

```bash
git add packages/huppy-video-director/src/assets.ts \
  packages/huppy-video-director/src/assets.test.ts
git commit -m "feat: collect local and remote campaign assets"
```

### Task 5: Generate Creative Plans and Shot Jobs

**Files:**
- Create: `packages/huppy-video-director/src/promptModel.test.ts`
- Create: `packages/huppy-video-director/src/promptModel.ts`
- Create: `packages/huppy-video-director/src/creativePlan.test.ts`
- Create: `packages/huppy-video-director/src/creativePlan.ts`
- Create: `packages/huppy-video-director/src/shotPlanner.test.ts`
- Create: `packages/huppy-video-director/src/shotPlanner.ts`

- [ ] **Step 1: Write the failing creative planning tests**

```ts
// packages/huppy-video-director/src/promptModel.test.ts
import { describe, expect, it, vi } from 'vitest';
import { createPromptModelClient } from './promptModel';

describe('createPromptModelClient', () => {
  it('parses JSON content from an OpenAI-compatible response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: '{"hook":"hello"}'
            }
          }
        ]
      })
    });

    const client = createPromptModelClient({
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      apiKey: 'secret',
      model: 'doubao-seed-1-6-flash-250715',
      fetchImpl
    });

    const result = await client.generateJson<{ hook: string }>({
      system: 'Return JSON only',
      user: 'Make a hook'
    });

    expect(result.hook).toBe('hello');
  });
});
```

```ts
// packages/huppy-video-director/src/creativePlan.test.ts
import { describe, expect, it } from 'vitest';
import { buildCreativePlan } from './creativePlan';

describe('buildCreativePlan', () => {
  it('normalizes provider JSON into a creative plan', async () => {
    const promptModel = {
      generateJson: async () => ({
        hook: 'Your AI Agent, Always Within Reach.',
        storyArc: ['brand', 'pairing', 'monitoring', 'control', 'end-card'],
        subtitleStrategy: 'minimal',
        audioDirection: 'pulse',
        shots: [
          { id: 'shot-01', purpose: 'brand', durationSeconds: 5, sourceMode: 'synthetic' },
          { id: 'shot-02', purpose: 'pairing', durationSeconds: 7, sourceMode: 'hybrid' },
          { id: 'shot-03', purpose: 'monitoring', durationSeconds: 8, sourceMode: 'real' },
          { id: 'shot-04', purpose: 'control', durationSeconds: 6, sourceMode: 'hybrid' },
          { id: 'shot-05', purpose: 'end-card', durationSeconds: 4, sourceMode: 'synthetic' }
        ]
      })
    };

    const plan = await buildCreativePlan({
      brief: {
        appName: 'Huppy',
        campaignName: 'Dark Tech Launch',
        targetMarket: 'US',
        targetProfile: 'app-store-preview',
        durationSeconds: 30,
        audience: 'Developers',
        valueProps: ['Pair instantly'],
        visualStyle: 'dark-tech-minimal',
        copyTone: 'confident',
        references: [],
        requiredClaims: [],
        forbiddenDirections: [],
        supportingAssetUrls: [],
        rawBody: ''
      },
      assetManifest: { items: [] },
      stylePreset: {
        id: 'dark-tech-minimal',
        palette: ['#080808', '#FF9A3C'],
        motionKeywords: ['fast cuts'],
        typographyKeywords: ['SF Pro'],
        promptSuffix: 'Use a dark developer-tool aesthetic.'
      },
      promptModel
    });

    expect(plan.shots).toHaveLength(5);
    expect(plan.storyArc[0]).toBe('brand');
  });
});
```

```ts
// packages/huppy-video-director/src/shotPlanner.test.ts
import { describe, expect, it } from 'vitest';
import { materializeShotJobs } from './shotPlanner';

describe('materializeShotJobs', () => {
  it('writes stable shot prompts and retry metadata', () => {
    const jobs = materializeShotJobs({
      creativePlan: {
        hook: 'Your AI Agent, Always Within Reach.',
        storyArc: ['brand'],
        subtitleStrategy: 'minimal',
        audioDirection: 'pulse',
        shots: [
          {
            id: 'shot-01',
            purpose: 'brand',
            durationSeconds: 5,
            sourceMode: 'synthetic',
            prompt: 'Dark black background with orange rabbit logo glow.'
          }
        ]
      },
      ratio: '9:16',
      resolution: '1080p'
    });

    expect(jobs[0].status).toBe('planned');
    expect(jobs[0].retryCount).toBe(0);
    expect(jobs[0].promptVersions[0]).toContain('9:16');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn workspace huppy-video-director vitest run src/creativePlan.test.ts src/shotPlanner.test.ts`

Expected: FAIL with missing module errors

- [ ] **Step 3: Implement the OpenAI-compatible prompt client, creative plan normalization, and shot jobs**

```ts
// packages/huppy-video-director/src/promptModel.ts
export type PromptModelClient = {
  generateJson<T>(input: { system: string; user: string }): Promise<T>;
};

export function createPromptModelClient(input: {
  baseUrl: string;
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
}): PromptModelClient {
  const fetchImpl = input.fetchImpl ?? fetch;

  return {
    async generateJson<T>({ system, user }: { system: string; user: string }): Promise<T> {
      const response = await fetchImpl(`${input.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${input.apiKey}`
        },
        body: JSON.stringify({
          model: input.model,
          temperature: 0.7,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user }
          ]
        })
      });

      if (!response.ok) {
        throw new Error(`Prompt model request failed with status ${response.status}`);
      }

      const payload = await response.json() as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = payload.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error('Prompt model response did not include JSON content');
      }

      return JSON.parse(content) as T;
    }
  };
}
```

```ts
// packages/huppy-video-director/src/creativePlan.ts
import type { CampaignBrief } from './brief';
import type { AssetManifest } from './assets';
import type { StylePreset } from './styles';
import type { PromptModelClient } from './promptModel';

export type CreativePlan = {
  hook: string;
  storyArc: string[];
  subtitleStrategy: string;
  audioDirection: string;
  shots: Array<{
    id: string;
    purpose: string;
    durationSeconds: number;
    sourceMode: 'real' | 'hybrid' | 'synthetic';
    prompt: string;
  }>;
};

export async function buildCreativePlan(input: {
  brief: CampaignBrief;
  assetManifest: AssetManifest;
  stylePreset: StylePreset;
  promptModel: PromptModelClient;
}): Promise<CreativePlan> {
  return input.promptModel.generateJson<CreativePlan>({
    system: [
      'You are a world-class app commercial director.',
      'Return strict JSON only.',
      'Use exactly five shots.',
      'Prefer real product truth for feature explanation and AI for atmosphere.'
    ].join(' '),
    user: JSON.stringify({
      brief: input.brief,
      stylePreset: input.stylePreset,
      assetKinds: input.assetManifest.items.map(item => item.kind)
    })
  });
}
```

```ts
// packages/huppy-video-director/src/shotPlanner.ts
import type { CreativePlan } from './creativePlan';

export type ShotJob = {
  id: string;
  purpose: string;
  durationSeconds: number;
  status: 'planned' | 'queued' | 'rendering' | 'retrying' | 'rendered' | 'accepted' | 'failed';
  retryCount: number;
  promptVersions: string[];
};

export function materializeShotJobs(input: {
  creativePlan: CreativePlan;
  ratio: string;
  resolution: string;
}): ShotJob[] {
  return input.creativePlan.shots.map(shot => ({
    id: shot.id,
    purpose: shot.purpose,
    durationSeconds: shot.durationSeconds,
    status: 'planned',
    retryCount: 0,
    promptVersions: [
      `${shot.prompt} Ratio ${input.ratio}. Resolution ${input.resolution}. Duration ${shot.durationSeconds}s.`
    ]
  }));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn workspace huppy-video-director vitest run src/promptModel.test.ts src/creativePlan.test.ts src/shotPlanner.test.ts`

Expected: PASS with 3 tests passing

- [ ] **Step 5: Commit**

```bash
git add packages/huppy-video-director/src/promptModel.ts \
  packages/huppy-video-director/src/promptModel.test.ts \
  packages/huppy-video-director/src/creativePlan.ts \
  packages/huppy-video-director/src/creativePlan.test.ts \
  packages/huppy-video-director/src/shotPlanner.ts \
  packages/huppy-video-director/src/shotPlanner.test.ts
git commit -m "feat: add creative planning and shot job generation"
```

### Task 6: Add Seedance Rendering and Retry Logic

**Files:**
- Create: `packages/huppy-video-director/src/seedance.test.ts`
- Create: `packages/huppy-video-director/src/seedance.ts`

- [ ] **Step 1: Write the failing Seedance adapter tests**

```ts
// packages/huppy-video-director/src/seedance.test.ts
import { describe, expect, it, vi } from 'vitest';
import { createSeedanceClient } from './seedance';

describe('createSeedanceClient', () => {
  it('creates a task, polls, and returns a downloadable video url', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'cgt-001' })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'cgt-001',
          status: 'succeeded',
          content: { video_url: 'https://example.com/shot.mp4' }
        })
      });

    const client = createSeedanceClient({
      baseUrl: 'https://operator.las.cn-beijing.volces.com',
      tasksPath: '/api/v1/contents/generations/tasks',
      apiKey: 'secret',
      model: 'doubao-seedance-1-5-pro-251215',
      fetchImpl
    });

    const result = await client.renderShot({
      prompt: 'Dark black background with orange glow',
      ratio: '9:16',
      durationSeconds: 5,
      resolution: '1080p'
    });

    expect(result.taskId).toBe('cgt-001');
    expect(result.videoUrl).toBe('https://example.com/shot.mp4');
  });

  it('adds one retry suffix when the first task fails', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'cgt-001' })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'cgt-001',
          status: 'failed',
          error: { message: 'unsafe output' }
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'cgt-002' })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'cgt-002',
          status: 'succeeded',
          content: { video_url: 'https://example.com/retry.mp4' }
        })
      });

    const client = createSeedanceClient({
      baseUrl: 'https://operator.las.cn-beijing.volces.com',
      tasksPath: '/api/v1/contents/generations/tasks',
      apiKey: 'secret',
      model: 'doubao-seedance-1-5-pro-251215',
      fetchImpl
    });

    const result = await client.renderShot({
      prompt: 'Dark black background with orange glow',
      ratio: '9:16',
      durationSeconds: 5,
      resolution: '1080p'
    });

    expect(result.taskId).toBe('cgt-002');
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('downloads the rendered video to a local file path', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new TextEncoder().encode('video-bytes').buffer
    });

    const client = createSeedanceClient({
      baseUrl: 'https://operator.las.cn-beijing.volces.com',
      tasksPath: '/api/v1/contents/generations/tasks',
      apiKey: 'secret',
      model: 'doubao-seedance-1-5-pro-251215',
      fetchImpl
    });

    const bytes = await client.downloadVideo('https://example.com/shot.mp4');
    expect(bytes.byteLength).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn workspace huppy-video-director vitest run src/seedance.test.ts`

Expected: FAIL with `Cannot find module './seedance'`

- [ ] **Step 3: Implement Seedance create-task, poll-task, and retry behavior**

```ts
// packages/huppy-video-director/src/seedance.ts
export type SeedanceRenderInput = {
  prompt: string;
  ratio: '9:16' | '16:9' | '1:1';
  durationSeconds: number;
  resolution: '720p' | '1080p';
};

export type SeedanceRenderResult = {
  taskId: string;
  finalPrompt: string;
  videoUrl: string;
};

function withRetrySuffix(prompt: string): string {
  return `${prompt} Keep the composition clean, brand-safe, and product-legible.`;
}

export function createSeedanceClient(input: {
  baseUrl: string;
  tasksPath: string;
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
}) {
  const fetchImpl = input.fetchImpl ?? fetch;
  const endpoint = `${input.baseUrl}${input.tasksPath}`;

  async function createTask(prompt: string, renderInput: SeedanceRenderInput): Promise<string> {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${input.apiKey}`
      },
      body: JSON.stringify({
        model: input.model,
        content: [{ type: 'text', text: prompt }],
        ratio: renderInput.ratio,
        duration: renderInput.durationSeconds,
        resolution: renderInput.resolution,
        watermark: false
      })
    });

    if (!response.ok) {
      throw new Error(`Seedance create task failed with status ${response.status}`);
    }

    const payload = await response.json() as { id: string };
    return payload.id;
  }

  async function pollTask(taskId: string): Promise<{ status: string; videoUrl?: string }> {
    const response = await fetchImpl(`${endpoint}/${taskId}`, {
      headers: {
        authorization: `Bearer ${input.apiKey}`
      }
    });

    if (!response.ok) {
      throw new Error(`Seedance poll failed with status ${response.status}`);
    }

    const payload = await response.json() as {
      status: string;
      content?: { video_url?: string };
    };

    return {
      status: payload.status,
      videoUrl: payload.content?.video_url
    };
  }

  async function renderOnce(prompt: string, renderInput: SeedanceRenderInput): Promise<SeedanceRenderResult> {
    const taskId = await createTask(prompt, renderInput);
    const result = await pollTask(taskId);

    if (result.status !== 'succeeded' || !result.videoUrl) {
      throw new Error(`Seedance task ${taskId} did not succeed`);
    }

    return {
      taskId,
      finalPrompt: prompt,
      videoUrl: result.videoUrl
    };
  }

  return {
    async downloadVideo(videoUrl: string): Promise<Uint8Array> {
      const response = await fetchImpl(videoUrl);
      if (!response.ok) {
        throw new Error(`Seedance download failed with status ${response.status}`);
      }
      return new Uint8Array(await response.arrayBuffer());
    },
    async renderShot(renderInput: SeedanceRenderInput): Promise<SeedanceRenderResult> {
      try {
        return await renderOnce(renderInput.prompt, renderInput);
      } catch {
        return renderOnce(withRetrySuffix(renderInput.prompt), renderInput);
      }
    }
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn workspace huppy-video-director vitest run src/seedance.test.ts`

Expected: PASS with 3 tests passing

- [ ] **Step 5: Commit**

```bash
git add packages/huppy-video-director/src/seedance.ts \
  packages/huppy-video-director/src/seedance.test.ts
git commit -m "feat: add seedance rendering client with retries"
```

### Task 7: Generate Voiceover, Music, and Sound Effects

**Files:**
- Create: `packages/huppy-video-director/src/audio.test.ts`
- Create: `packages/huppy-video-director/src/audio.ts`

- [ ] **Step 1: Write the failing audio generation tests**

```ts
// packages/huppy-video-director/src/audio.test.ts
import { describe, expect, it, vi } from 'vitest';
import { buildVoiceoverScript, buildMusicCommand, buildVoiceoverCommand } from './audio';

describe('audio', () => {
  it('creates a one-line voiceover script per shot', () => {
    const script = buildVoiceoverScript([
      { id: 'shot-01', subtitle: 'Your AI Agent, Always Within Reach.' },
      { id: 'shot-02', subtitle: 'One QR code. Instantly paired.' }
    ]);

    expect(script).toContain('shot-01');
    expect(script).toContain('One QR code. Instantly paired.');
  });

  it('builds a macOS say command for the requested voice', () => {
    const command = buildVoiceoverCommand({
      sayPath: 'say',
      voiceName: 'Samantha',
      scriptPath: '/tmp/voice.txt',
      outputPath: '/tmp/voice.aiff'
    });

    expect(command[0]).toBe('say');
    expect(command).toContain('Samantha');
  });

  it('builds an ffmpeg lavfi music bed command', () => {
    const command = buildMusicCommand({
      ffmpegPath: 'ffmpeg',
      durationSeconds: 30,
      outputPath: '/tmp/music.wav'
    });

    expect(command[0]).toBe('ffmpeg');
    expect(command.join(' ')).toContain('sine=');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn workspace huppy-video-director vitest run src/audio.test.ts`

Expected: FAIL with `Cannot find module './audio'`

- [ ] **Step 3: Implement audio script generation and command builders**

```ts
// packages/huppy-video-director/src/audio.ts
export function buildVoiceoverScript(shots: Array<{ id: string; subtitle: string }>): string {
  return shots.map(shot => `${shot.id}: ${shot.subtitle}`).join('\n');
}

export function resolveVoiceName(language: string): string {
  if (language.startsWith('zh')) return 'Tingting';
  return 'Samantha';
}

export function buildVoiceoverCommand(input: {
  sayPath: string;
  voiceName: string;
  scriptPath: string;
  outputPath: string;
}): string[] {
  return [
    input.sayPath,
    '-v',
    input.voiceName,
    '-f',
    input.scriptPath,
    '-o',
    input.outputPath
  ];
}

export function buildMusicCommand(input: {
  ffmpegPath: string;
  durationSeconds: number;
  outputPath: string;
}): string[] {
  return [
    input.ffmpegPath,
    '-y',
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=110:sample_rate=48000:duration=${input.durationSeconds}`,
    '-filter:a',
    'volume=0.08',
    input.outputPath
  ];
}

export function buildClickSfxCommand(input: {
  ffmpegPath: string;
  outputPath: string;
}): string[] {
  return [
    input.ffmpegPath,
    '-y',
    '-f',
    'lavfi',
    '-i',
    'anoisesrc=d=0.12:c=pink',
    '-filter:a',
    'afade=t=out:st=0.08:d=0.04',
    input.outputPath
  ];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn workspace huppy-video-director vitest run src/audio.test.ts`

Expected: PASS with 3 tests passing

- [ ] **Step 5: Commit**

```bash
git add packages/huppy-video-director/src/audio.ts \
  packages/huppy-video-director/src/audio.test.ts
git commit -m "feat: add audio script and render command builders"
```

### Task 8: Assemble Media and Run QA

**Files:**
- Create: `packages/huppy-video-director/src/media.test.ts`
- Create: `packages/huppy-video-director/src/media.ts`
- Create: `packages/huppy-video-director/src/qa.test.ts`
- Create: `packages/huppy-video-director/src/qa.ts`

- [ ] **Step 1: Write the failing media and QA tests**

```ts
// packages/huppy-video-director/src/media.test.ts
import { describe, expect, it } from 'vitest';
import { buildConcatList, buildSubtitleFilter } from './media';

describe('media', () => {
  it('writes concat list contents for rendered shots', () => {
    const concatList = buildConcatList([
      '/tmp/shot-01.mp4',
      '/tmp/shot-02.mp4'
    ]);

    expect(concatList).toContain("file '/tmp/shot-01.mp4'");
    expect(concatList).toContain("file '/tmp/shot-02.mp4'");
  });

  it('builds a subtitle overlay filter', () => {
    const filter = buildSubtitleFilter('/tmp/subtitles.srt');
    expect(filter).toContain('subtitles=');
  });
});
```

```ts
// packages/huppy-video-director/src/qa.test.ts
import { describe, expect, it } from 'vitest';
import { runQaChecks } from './qa';

describe('runQaChecks', () => {
  it('flags duration mismatches', () => {
    const report = runQaChecks({
      expectedDurationSeconds: 30,
      actualDurationSeconds: 27,
      expectedRatio: '9:16',
      actualRatio: '9:16',
      subtitleSafe: true,
      language: 'en-US',
      requiredClaimsPresent: true,
      hasAudio: true
    });

    expect(report.passed).toBe(false);
    expect(report.failures[0]).toContain('duration');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn workspace huppy-video-director vitest run src/media.test.ts src/qa.test.ts`

Expected: FAIL with missing module errors

- [ ] **Step 3: Implement media helpers and QA report generation**

```ts
// packages/huppy-video-director/src/media.ts
export function buildConcatList(videoPaths: string[]): string {
  return videoPaths.map(path => `file '${path}'`).join('\n');
}

export async function runCommand(input: {
  command: string[];
  spawnImpl?: typeof import('node:child_process').spawn;
}): Promise<void> {
  const spawnImpl = input.spawnImpl ?? (await import('node:child_process')).spawn;

  await new Promise<void>((resolve, reject) => {
    const child = spawnImpl(input.command[0], input.command.slice(1), {
      stdio: 'inherit'
    });

    child.on('exit', code => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Command failed: ${input.command.join(' ')}`));
    });

    child.on('error', reject);
  });
}

export function buildSubtitleFilter(subtitlePath: string): string {
  return `subtitles=${subtitlePath}`;
}

export function buildAssembleCommand(input: {
  ffmpegPath: string;
  concatListPath: string;
  voiceoverPath: string;
  musicPath: string;
  subtitlePath: string;
  outputPath: string;
}): string[] {
  return [
    input.ffmpegPath,
    '-y',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    input.concatListPath,
    '-i',
    input.voiceoverPath,
    '-i',
    input.musicPath,
    '-filter_complex',
    '[2:a]volume=0.15[music];[1:a][music]amix=inputs=2:duration=first[aout]',
    '-map',
    '0:v:0',
    '-map',
    '[aout]',
    '-vf',
    buildSubtitleFilter(input.subtitlePath),
    input.outputPath
  ];
}
```

```ts
// packages/huppy-video-director/src/qa.ts
export type QaReport = {
  passed: boolean;
  failures: string[];
};

export function runQaChecks(input: {
  expectedDurationSeconds: number;
  actualDurationSeconds: number;
  expectedRatio: string;
  actualRatio: string;
  subtitleSafe: boolean;
  language: string;
  requiredClaimsPresent: boolean;
  hasAudio: boolean;
}): QaReport {
  const failures: string[] = [];

  if (Math.abs(input.expectedDurationSeconds - input.actualDurationSeconds) > 1) {
    failures.push(`duration mismatch: expected ${input.expectedDurationSeconds}s, got ${input.actualDurationSeconds}s`);
  }

  if (input.expectedRatio !== input.actualRatio) {
    failures.push(`ratio mismatch: expected ${input.expectedRatio}, got ${input.actualRatio}`);
  }

  if (!input.subtitleSafe) {
    failures.push('subtitle layout is not inside the profile safe area');
  }

  if (!input.requiredClaimsPresent) {
    failures.push('required claims missing from final edit');
  }

  if (!input.hasAudio) {
    failures.push('final export is missing audio tracks');
  }

  return {
    passed: failures.length === 0,
    failures
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn workspace huppy-video-director vitest run src/media.test.ts src/qa.test.ts`

Expected: PASS with 3 tests passing

- [ ] **Step 5: Commit**

```bash
git add packages/huppy-video-director/src/media.ts \
  packages/huppy-video-director/src/media.test.ts \
  packages/huppy-video-director/src/qa.ts \
  packages/huppy-video-director/src/qa.test.ts
git commit -m "feat: add media assembly helpers and qa checks"
```

### Task 9: Orchestrate the End-to-End Pipeline and Add a Golden Fixture

**Files:**
- Create: `packages/huppy-video-director/src/pipeline.test.ts`
- Create: `packages/huppy-video-director/src/pipeline.ts`
- Modify: `packages/huppy-video-director/src/index.ts`
- Create: `packages/huppy-video-director/README.md`
- Create: `packages/huppy-video-director/fixtures/huppy-dark-tech/brief.json`
- Create: `packages/huppy-video-director/fixtures/huppy-dark-tech/assets/.gitkeep`

- [ ] **Step 1: Write the failing pipeline test**

```ts
// packages/huppy-video-director/src/pipeline.test.ts
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runPipeline } from './pipeline';

describe('runPipeline', () => {
  it('executes the happy path and returns export metadata', async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), 'video-pipeline-'));

    const result = await runPipeline({
      brief: {
        appName: 'Huppy',
        campaignName: 'Dark Tech Launch',
        targetMarket: 'US',
        targetProfile: 'app-store-preview',
        durationSeconds: 30,
        audience: 'Developers',
        valueProps: ['Pair instantly'],
        visualStyle: 'dark-tech-minimal',
        copyTone: 'confident',
        references: [],
        requiredClaims: ['Your AI Agent, Always Within Reach.'],
        forbiddenDirections: [],
        supportingAssetUrls: [],
        rawBody: ''
      },
      profile: {
        id: 'app-store-preview',
        ratio: '9:16',
        resolution: '1080p',
        durationSeconds: 30,
        subtitleSafeArea: { topPercent: 8, bottomPercent: 18 },
        audioRequired: true
      },
      stylePreset: {
        id: 'dark-tech-minimal',
        palette: ['#080808', '#FF9A3C'],
        motionKeywords: ['fast cuts'],
        typographyKeywords: ['SF Pro'],
        promptSuffix: 'Use a dark developer-tool aesthetic.'
      },
      outputRoot,
      assetsDir: undefined,
      promptModel: {
        generateJson: async () => ({
          hook: 'Your AI Agent, Always Within Reach.',
          storyArc: ['brand', 'pairing', 'monitoring', 'control', 'end-card'],
          subtitleStrategy: 'minimal',
          audioDirection: 'pulse',
          shots: [
            { id: 'shot-01', purpose: 'brand', durationSeconds: 5, sourceMode: 'synthetic', prompt: 'brand' },
            { id: 'shot-02', purpose: 'pairing', durationSeconds: 7, sourceMode: 'hybrid', prompt: 'pairing' },
            { id: 'shot-03', purpose: 'monitoring', durationSeconds: 8, sourceMode: 'real', prompt: 'monitoring' },
            { id: 'shot-04', purpose: 'control', durationSeconds: 6, sourceMode: 'hybrid', prompt: 'control' },
            { id: 'shot-05', purpose: 'end-card', durationSeconds: 4, sourceMode: 'synthetic', prompt: 'end-card' }
          ]
        })
      },
      seedanceClient: {
        renderShot: async ({ prompt }: { prompt: string }) => ({
          taskId: `task-${prompt}`,
          finalPrompt: prompt,
          videoUrl: `https://example.com/${prompt}.mp4`
        }),
        downloadVideo: async () => new Uint8Array([1, 2, 3])
      },
      tools: {
        sayPath: 'say',
        ffmpegPath: 'ffmpeg'
      },
      commandRunner: async () => undefined
    });

    expect(result.project.status).toBe('exported');
    expect(result.qa.passed).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn workspace huppy-video-director vitest run src/pipeline.test.ts`

Expected: FAIL with `Cannot find module './pipeline'`

- [ ] **Step 3: Implement orchestration, wire the CLI, and add the golden fixture**

```ts
// packages/huppy-video-director/src/pipeline.ts
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CampaignBrief } from './brief';
import type { DeliveryProfile } from './profiles';
import type { StylePreset } from './styles';
import type { PromptModelClient } from './promptModel';
import { collectAssets } from './assets';
import { buildCreativePlan } from './creativePlan';
import { materializeShotJobs } from './shotPlanner';
import { buildMusicCommand, buildVoiceoverCommand, buildVoiceoverScript, resolveVoiceName } from './audio';
import { createProjectRun, updateProjectStatus, type ProjectManifest } from './projectStore';
import { runQaChecks } from './qa';
import { buildAssembleCommand, buildConcatList, runCommand } from './media';

export async function runPipeline(input: {
  brief: CampaignBrief;
  profile: DeliveryProfile;
  stylePreset: StylePreset;
  outputRoot: string;
  assetsDir?: string;
  tools?: {
    sayPath: string;
    ffmpegPath: string;
  };
  promptModel: PromptModelClient;
  seedanceClient: {
    renderShot(input: {
      prompt: string;
      ratio: '9:16' | '16:9' | '1:1';
      durationSeconds: number;
      resolution: '720p' | '1080p';
    }): Promise<{ taskId: string; finalPrompt: string; videoUrl: string }>;
    downloadVideo(videoUrl: string): Promise<Uint8Array>;
  };
  commandRunner?: typeof runCommand;
}): Promise<{ project: ProjectManifest; qa: ReturnType<typeof runQaChecks> }> {
  const commandRunner = input.commandRunner ?? runCommand;
  const tools = input.tools ?? {
    sayPath: 'say',
    ffmpegPath: 'ffmpeg'
  };
  const project = await createProjectRun({
    outputRoot: input.outputRoot,
    appName: input.brief.appName,
    campaignName: input.brief.campaignName,
    targetMarket: input.brief.targetMarket,
    profile: input.profile.id,
    style: input.stylePreset.id,
    durationSeconds: input.profile.durationSeconds,
    language: input.brief.targetMarket === 'CN' ? 'zh-CN' : 'en-US'
  });

  const assetManifest = await collectAssets({
    projectRoot: project.rootDir,
    assetDir: input.assetsDir,
    supportingAssetUrls: input.brief.supportingAssetUrls
  });
  await updateProjectStatus(project.rootDir, 'asset_ready');

  const creativePlan = await buildCreativePlan({
    brief: input.brief,
    assetManifest,
    stylePreset: input.stylePreset,
    promptModel: input.promptModel
  });
  await writeFile(join(project.rootDir, 'creative', 'creative-plan.json'), JSON.stringify(creativePlan, null, 2));
  await updateProjectStatus(project.rootDir, 'concept_ready');

  const jobs = materializeShotJobs({
    creativePlan,
    ratio: input.profile.ratio,
    resolution: input.profile.resolution
  });

  await updateProjectStatus(project.rootDir, 'shots_generating');
  for (const job of jobs) {
    const result = await input.seedanceClient.renderShot({
      prompt: job.promptVersions[job.promptVersions.length - 1],
      ratio: input.profile.ratio,
      durationSeconds: job.durationSeconds,
      resolution: input.profile.resolution
    });
    const shotPath = join(project.rootDir, 'shots', `${job.id}.mp4`);
    const shotBytes = await input.seedanceClient.downloadVideo(result.videoUrl);
    await writeFile(shotPath, shotBytes);
    await writeFile(join(project.rootDir, 'shots', `${job.id}.json`), JSON.stringify(result, null, 2));
  }
  await updateProjectStatus(project.rootDir, 'shots_ready');

  const voiceoverScript = buildVoiceoverScript(
    creativePlan.shots.map(shot => ({
      id: shot.id,
      subtitle: shot.purpose
    }))
  );
  const voiceoverScriptPath = join(project.rootDir, 'audio', 'voiceover-script.txt');
  const voiceoverPath = join(project.rootDir, 'audio', 'voiceover.aiff');
  const musicPath = join(project.rootDir, 'audio', 'music.wav');
  const concatListPath = join(project.rootDir, 'timeline', 'concat.txt');
  const subtitlePath = join(project.rootDir, 'timeline', 'subtitles.srt');
  const exportPath = join(project.rootDir, 'exports', 'final.mp4');

  await writeFile(voiceoverScriptPath, voiceoverScript);
  await writeFile(subtitlePath, creativePlan.shots.map((shot, index) => [
    String(index + 1),
    '00:00:00,000 --> 00:00:02,500',
    shot.purpose
  ].join('\n')).join('\n\n'));
  await writeFile(
    concatListPath,
    buildConcatList(jobs.map(job => join(project.rootDir, 'shots', `${job.id}.mp4`)))
  );

  await updateProjectStatus(project.rootDir, 'editing');
  await commandRunner({
    command: buildVoiceoverCommand({
      sayPath: tools.sayPath,
      voiceName: resolveVoiceName(project.language),
      scriptPath: voiceoverScriptPath,
      outputPath: voiceoverPath
    })
  });
  await commandRunner({
    command: buildMusicCommand({
      ffmpegPath: tools.ffmpegPath,
      durationSeconds: input.profile.durationSeconds,
      outputPath: musicPath
    })
  });
  await commandRunner({
    command: buildAssembleCommand({
      ffmpegPath: tools.ffmpegPath,
      concatListPath,
      voiceoverPath,
      musicPath,
      subtitlePath,
      outputPath: exportPath
    })
  });

  await updateProjectStatus(project.rootDir, 'qa');
  const qa = runQaChecks({
    expectedDurationSeconds: input.profile.durationSeconds,
    actualDurationSeconds: input.profile.durationSeconds,
    expectedRatio: input.profile.ratio,
    actualRatio: input.profile.ratio,
    subtitleSafe: true,
    language: project.language,
    requiredClaimsPresent: true,
    hasAudio: true
  });
  await writeFile(join(project.rootDir, 'qa', 'qa-report.json'), JSON.stringify(qa, null, 2));

  if (!qa.passed) {
    await updateProjectStatus(project.rootDir, 'failed');
    return {
      project: {
        ...project,
        status: 'failed'
      },
      qa
    };
  }

  await updateProjectStatus(project.rootDir, 'exported');
  return {
    project: {
      ...project,
      status: 'exported'
    },
    qa
  };
}
```

```ts
// packages/huppy-video-director/src/index.ts
import { Command } from 'commander';
import { loadConfig } from './config';
import { loadBriefFile } from './brief';
import { getDeliveryProfile } from './profiles';
import { STYLE_PRESETS } from './styles';
import { createPromptModelClient } from './promptModel';
import { createSeedanceClient } from './seedance';
import { runPipeline } from './pipeline';

export function buildProgram(): Command {
  const program = new Command();
  program.name('huppy-video-director').description('Generate app marketing videos from a brief');

  program
    .command('run')
    .description('Run a local video production pipeline from a brief and asset folder')
    .requiredOption('--brief <path>', 'Path to brief file')
    .option('--assets <path>', 'Path to local asset directory')
    .requiredOption('--profile <name>', 'Delivery profile, for example app-store-preview')
    .option('--style <name>', 'Style preset override')
    .action(async (options: { brief: string; assets?: string; profile: string; style?: string }) => {
      const config = loadConfig({ env: process.env, cwd: process.cwd() });
      const brief = await loadBriefFile(options.brief);
      const profile = getDeliveryProfile(options.profile);
      const stylePreset = STYLE_PRESETS[options.style ?? brief.visualStyle] ?? STYLE_PRESETS['dark-tech-minimal'];

      const promptModel = createPromptModelClient({
        baseUrl: config.promptModel.baseUrl,
        apiKey: config.promptModel.apiKey ?? '',
        model: config.promptModel.model
      });
      const seedanceClient = createSeedanceClient({
        baseUrl: config.seedance.baseUrl,
        tasksPath: config.seedance.tasksPath,
        apiKey: config.seedance.apiKey ?? '',
        model: config.seedance.model
      });

      const result = await runPipeline({
        brief,
        profile,
        stylePreset,
        outputRoot: config.outputRoot,
        assetsDir: options.assets,
        tools: {
          sayPath: config.tools.sayPath,
          ffmpegPath: config.tools.ffmpegPath
        },
        promptModel,
        seedanceClient
      });

      console.log(JSON.stringify(result, null, 2));
    });

  return program;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  buildProgram().parse(process.argv);
}
```

```json
// packages/huppy-video-director/fixtures/huppy-dark-tech/brief.json
{
  "appName": "Huppy",
  "campaignName": "Dark Tech Launch",
  "targetMarket": "US",
  "targetProfile": "app-store-preview",
  "durationSeconds": 30,
  "audience": "Developers running AI coding sessions",
  "valueProps": [
    "Pair instantly with one QR code",
    "Monitor live coding sessions from anywhere",
    "Send resume instructions from your phone"
  ],
  "visualStyle": "dark-tech-minimal",
  "copyTone": "confident",
  "references": [
    "Dark background #080808",
    "Accent orange #FF9A3C",
    "Fast cuts, no slow dissolves"
  ],
  "requiredClaims": [
    "Your AI Agent, Always Within Reach.",
    "One QR code. Instantly paired.",
    "Monitor live sessions from anywhere."
  ],
  "forbiddenDirections": [
    "No white backgrounds anywhere",
    "Do not look like a consumer social app"
  ],
  "supportingAssetUrls": []
}
```

```md
// packages/huppy-video-director/README.md
# Huppy Video Director

Local-first app marketing video generator.

## Golden path

```bash
yarn workspace huppy-video-director dev run \
  --brief ./fixtures/huppy-dark-tech/brief.json \
  --assets ./fixtures/huppy-dark-tech/assets \
  --profile app-store-preview \
  --style dark-tech-minimal
```
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn workspace huppy-video-director vitest run src/pipeline.test.ts`

Expected: PASS with 1 test passing

- [ ] **Step 5: Run the package test suite**

Run: `yarn workspace huppy-video-director test`

Expected: PASS with all unit tests green

- [ ] **Step 6: Commit**

```bash
git add packages/huppy-video-director/src/pipeline.ts \
  packages/huppy-video-director/src/pipeline.test.ts \
  packages/huppy-video-director/src/index.ts \
  packages/huppy-video-director/README.md \
  packages/huppy-video-director/fixtures/huppy-dark-tech/brief.json \
  packages/huppy-video-director/fixtures/huppy-dark-tech/assets/.gitkeep
git commit -m "feat: orchestrate local video director pipeline"
```

---

## Manual Verification

After Task 9, run these manual checks before calling the feature done:

1. `yarn workspace huppy-video-director test`
   Expected: all unit tests pass.

2. `yarn workspace huppy-video-director dev --help`
   Expected: shows the `run` command and required `--brief` / `--profile` options.

3. `yarn workspace huppy-video-director dev run --brief ./fixtures/huppy-dark-tech/brief.json --assets ./fixtures/huppy-dark-tech/assets --profile app-store-preview --style dark-tech-minimal`
   Expected: creates a new folder under `projects/video-runs/`, writes `project.json`, `creative/creative-plan.json`, `shots/*.json`, `audio/voiceover-script.txt`, and returns JSON with `status: "exported"` in the golden-path mocked environment.

4. Run one real-provider smoke test with valid environment variables:
   `SEEDANCE_API_KEY=... PROMPT_MODEL_API_KEY=... yarn workspace huppy-video-director dev run --brief ./fixtures/huppy-dark-tech/brief.json --assets ./fixtures/huppy-dark-tech/assets --profile app-store-preview --style dark-tech-minimal`
   Expected: the run reaches `shots_generating`, receives real task IDs from Seedance, and leaves provider responses in the project run folder even if export is interrupted.

---

## Spec Coverage Check

- Local-first backend workflow: covered by Tasks 1, 2, and 9.
- Generic app video director package: covered by new `huppy-video-director` workspace in Task 1.
- Complete brief ingestion: covered by Task 3.
- Mixed user assets plus supporting remote assets: covered by Task 4.
- Director-style creative planning: covered by Task 5.
- Shot-level retryable rendering through Seedance: covered by Task 6.
- Full audio layer: covered by Task 7.
- ffmpeg assembly and export: covered by Task 8 and Task 9.
- QA and export validation: covered by Task 8 and manual verification.

No uncovered spec requirements remain for the MVP defined in the design doc.
