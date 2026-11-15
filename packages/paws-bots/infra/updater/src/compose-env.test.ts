import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * The api and worker containers get an explicit environment allowlist instead of the whole
 * `.env`, so a process (and every command it spawns) only sees the settings it reads. These
 * tests derive what each process reads from its source and fail when a compose file forgets a
 * key it needs, or passes one it does not.
 */

interface ComposeService {
  env_file?: unknown;
  /** `KEY:` with no value parses as null: Compose passes it through only when it is set. */
  environment?: Record<string, unknown>;
}

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const composeDir = path.join(repoRoot, "infra/compose");

/** Server packages the api and worker both load. UI and test-only packages are not scanned. */
const SHARED_SOURCES = [
  "packages/adapter-kit/src",
  "packages/adapters/src",
  "packages/auth/src",
  "packages/contracts/src",
  "packages/core/src",
  "packages/db/src",
  "packages/logging/src",
  "packages/memory/src",
];

const SOURCES = {
  api: ["apps/api/src", ...SHARED_SOURCES],
  worker: ["apps/worker/src", ...SHARED_SOURCES],
} as const;

const KUBERNETES_SANDBOX =
  "SANDBOX_PROVIDER=kubernetes runs the api and worker in a cluster, not Compose";

/** Read by code but never passed to the api or worker containers, with the reason. */
const LOCAL_VM = "Mac VM computers, which only the desktop app's native stack runs";
const NOT_PASSED: Record<string, string> = {
  VITEST: "set by the test runner",
  OWNER_EMAIL: "bootstrap-owner CLI input, passed on its own command line",
  OWNER_PASSWORD: "bootstrap-owner CLI input, passed on its own command line",
  PM2_HOME: "restart-supervisor detection for PM2 hosts; Compose restarts containers",
  INVOCATION_ID: "restart-supervisor detection for systemd hosts; Compose restarts containers",
  RAKAZO_ALLOW_DEV_SECRETS: "development-only escape hatch for placeholder secrets",
  EMAIL_EMULATOR: "ignored when NODE_ENV=production",
  BILLING_EMULATOR: "ignored when NODE_ENV=production",
  NODE_USE_ENV_PROXY:
    "Node's own proxy switch, read to match it; Compose sends proxied traffic through HTTP_PROXY",
  NODE_OPTIONS: "Node's own startup flags, read to match its proxy switch; never set by Compose",
  AWS_KMS_PROFILE: "for maintainer laptops; servers use AWS_KMS_ACCESS_KEY_ID and its secret",
  GIT_SHA: "baked into the image at build time; a pass-through entry would unset it",
  SHELL: "host shell for the desktop computer, which only the Electron app runs",
  CLOUDFLARE_ACCOUNT_ID: "written into Pi's environment from stored gateway settings",
  CLOUDFLARE_GATEWAY_ID: "written into Pi's environment from stored gateway settings",
  COMPOSE_PROJECT_NAME: "read by the updater sidecar, which has its own environment",
  RAKAZO_COMPOSE_PROJECT_NAME: "read by the updater sidecar, which has its own environment",
  RAKAZO_IMAGE_TAG: "read by deployment tooling and the updater sidecar, not app processes",
  RAKAZO_DEPLOYED_MIGRATIONS: "passed only to the migration CLI by the production deploy script",
  RAKAZO_IMAGE_TAG_PREVIOUS: "read by the updater sidecar, which has its own environment",
  RAKAZO_DB_PACKAGE_DIR: "passed only to the migration CLI by the desktop app's native stack",
  RAKAZO_ENV_FILE: "set by the desktop app's native stack so no stray .env is read",
  LOCAL_VM_CLI: LOCAL_VM,
  LOCAL_VM_COMPUTER_IMAGE: LOCAL_VM,
  LOCAL_VM_CPUS: LOCAL_VM,
  LOCAL_VM_MEMORY: LOCAL_VM,
  KUBERNETES_SANDBOX_COMPUTER_IMAGE: KUBERNETES_SANDBOX,
  KUBERNETES_SANDBOX_HOME_CLAIM: KUBERNETES_SANDBOX,
  KUBERNETES_SANDBOX_HOME_COLOCATE_LABELS: KUBERNETES_SANDBOX,
  KUBERNETES_SANDBOX_HOME_COLOCATE_NAMESPACE: KUBERNETES_SANDBOX,
  KUBERNETES_SANDBOX_CPU_LIMIT: KUBERNETES_SANDBOX,
  KUBERNETES_SANDBOX_MEMORY_LIMIT: KUBERNETES_SANDBOX,
  KUBERNETES_SANDBOX_NAMESPACE: KUBERNETES_SANDBOX,
  KUBERNETES_SANDBOX_POD_ANNOTATIONS: KUBERNETES_SANDBOX,
  KUBERNETES_SANDBOX_POD_LABELS: KUBERNETES_SANDBOX,
  KUBERNETES_SANDBOX_READY_TIMEOUT_MS: KUBERNETES_SANDBOX,
  KUBERNETES_SANDBOX_RUNTIME_CLASS_NAME: KUBERNETES_SANDBOX,
};

/**
 * Shared-package reads a process must not receive. Only the API signs sessions and talks to
 * the identity provider, so the worker resolves no auth secret. Only the migrate container
 * gets the owner database login, so neither process holds one that bypasses row-level security.
 */
const DENIED = {
  api: ["DATABASE_MIGRATION_URL"],
  worker: ["BETTER_AUTH_SECRET", "DATABASE_MIGRATION_URL"],
} as const;

/** Reads a source scan cannot see: names held in constants or read by third-party SDKs. */
const INDIRECT = {
  shared: [
    // core/secrets-guard.ts resolves these by name.
    "SANDBOX_SUPERVISOR_TOKEN",
    // pi-local-provider.ts reads these through a small helper.
    "RAKAZO_LOCAL_CONTEXT_WINDOW",
    "RAKAZO_LOCAL_MAX_TOKENS",
    // The OTLP exporter reads its standard settings itself.
    "OTEL_EXPORTER_OTLP_HEADERS",
    "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
    "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
    // PI_DEFAULT_CREDENTIALS=host: the cloud SDKs also read these (Pi's own reads are below).
    "AWS_SESSION_TOKEN",
    "AWS_REGION",
    "AWS_DEFAULT_REGION",
    "AWS_ROLE_ARN",
    // Outbound proxy, read by the HTTP stack.
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
  ],
  api: [
    // core/secrets-guard.ts resolves these by name.
    "SCREEN_PROXY_SECRET",
  ],
  worker: [],
} as const;

const ENV_NAME = "[A-Z][A-Z0-9_]+";
const READ_PATTERNS = [
  // process.env.NAME, env.NAME, source?.NAME, environment.NAME
  new RegExp(`(?:process\\.env|\\benv|\\bsource|\\benvironment)\\??\\.(${ENV_NAME})\\b`, "g"),
  // process.env["NAME"]
  new RegExp(`(?:process\\.env|\\benv|\\bsource)\\[\\s*["'\`](${ENV_NAME})["'\`]\\s*\\]`, "g"),
  // required("NAME") / required(source, "NAME")
  new RegExp(`\\brequired\\(\\s*(?:\\w+,\\s*)?["'\`](${ENV_NAME})["'\`]`, "g"),
  // const SOMETHING_ENV = "NAME"
  new RegExp(`\\b[A-Z][A-Z0-9_]*_ENV\\s*=\\s*["'\`](${ENV_NAME})["'\`]`, "g"),
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    if (entry === "node_modules" || entry === "dist") return [];
    const file = path.join(dir, entry);
    if (statSync(file).isDirectory()) return sourceFiles(file);
    if (!/\.(?:ts|tsx|mts)$/.test(entry) || /\.d\.ts$/.test(entry)) return [];
    if (/\.(?:test|spec)\.|test-support/.test(entry)) return [];
    return [file];
  });
}

function scanEnvReads(dirs: readonly string[]): Set<string> {
  const names = new Set<string>();
  for (const dir of dirs) {
    for (const file of sourceFiles(path.join(repoRoot, dir))) {
      const text = readFileSync(file, "utf8");
      for (const pattern of READ_PATTERNS) {
        for (const match of text.matchAll(pattern)) names.add(match[1] ?? "");
      }
    }
  }
  return names;
}

/**
 * Provider keys Pi reads from the environment itself when a model has no stored credential.
 * Read from the installed package, so a Pi upgrade that adds a provider fails here.
 */
function piEnvKeys(): string[] {
  const file = path.join(
    repoRoot,
    "packages/adapters/node_modules/@earendil-works/pi-ai/dist/env-api-keys.js",
  );
  const names = [...readFileSync(file, "utf8").matchAll(new RegExp(`"(${ENV_NAME})"`, "g"))];
  return names.map((match) => match[1] ?? "");
}

function expectedKeys(service: "api" | "worker"): string[] {
  const keys = new Set([
    ...scanEnvReads(SOURCES[service]),
    ...piEnvKeys(),
    ...INDIRECT.shared,
    ...INDIRECT[service],
  ]);
  for (const key of Object.keys(NOT_PASSED)) keys.delete(key);
  for (const key of DENIED[service]) keys.delete(key);
  return [...keys].sort();
}

function loadServices(file: string): Record<string, ComposeService> {
  return (
    parse(readFileSync(path.join(composeDir, file), "utf8"), { merge: true }) as {
      services: Record<string, ComposeService>;
    }
  ).services;
}

/** Each deployable stack: a base file plus any overlay layered on it. */
const STACKS = [
  ["docker-compose.images.yml"],
  ["docker-compose.prod.yml"],
  ["docker-compose.prod.yml", "docker-compose.prod.docker.yml"],
  ["docker-compose.yml"],
];

function stackEnvironment(files: string[], service: string): Record<string, unknown> {
  return Object.assign({}, ...files.map((file) => loadServices(file)[service]?.environment ?? {}));
}

describe("api and worker environment allowlists", () => {
  it("finds the reads it is meant to find", () => {
    const api = expectedKeys("api");
    const worker = expectedKeys("worker");
    for (const key of ["DATABASE_URL", "ENCRYPTION_KEY", "OPENROUTER_API_KEY", "E2B_API_KEY"]) {
      expect(api).toContain(key);
      expect(worker).toContain(key);
    }
    for (const key of ["BETTER_AUTH_SECRET", "OIDC_CLIENT_SECRET", "SCREEN_PROXY_SECRET"]) {
      expect(api).toContain(key);
      expect(worker).not.toContain(key);
    }
    expect(api).toContain("OPENAI_API_KEY");
    expect(worker).toContain("AWS_BEARER_TOKEN_BEDROCK");
    expect(worker).toContain("GRAPHILE_WORKER_CONCURRENCY");
    expect(api).not.toContain("GRAPHILE_WORKER_CONCURRENCY");
  });

  it("only excludes settings the code still reads", () => {
    const read = scanEnvReads([...SOURCES.api, ...SOURCES.worker]);
    expect(Object.keys(NOT_PASSED).filter((key) => !read.has(key))).toEqual([]);
    expect([...DENIED.api, ...DENIED.worker].filter((key) => !read.has(key))).toEqual([]);
  });

  it.each(STACKS.map((files) => [files.join(" + "), files] as const))(
    "%s passes each process exactly the settings it reads",
    (_name, files) => {
      for (const service of ["api", "worker"] as const) {
        for (const file of files) expect(loadServices(file)[service]?.env_file).toBeUndefined();
        const keys = Object.keys(stackEnvironment(files, service)).sort();
        expect({ service, keys }).toEqual({ service, keys: expectedKeys(service) });
      }
    },
  );

  it.each(STACKS.map((files) => [files.join(" + "), files] as const))(
    "%s keeps auth and database owner secrets out of the worker and API",
    (_name, files) => {
      const worker = stackEnvironment(files, "worker");
      for (const key of [
        "BETTER_AUTH_SECRET",
        "OIDC_CLIENT_SECRET",
        "SCREEN_PROXY_SECRET",
        "RAKAZO_UPDATER_TOKEN",
        "STRIPE_SECRET_KEY",
        "POSTGRES_PASSWORD",
      ]) {
        expect(worker).not.toHaveProperty(key);
      }
      expect(stackEnvironment(files, "api")).not.toHaveProperty("RAKAZO_UPDATER_TOKEN");
      // The database password reaches both processes only inside DATABASE_URL.
      expect(stackEnvironment(files, "api")).not.toHaveProperty("POSTGRES_PASSWORD");
      // The owner login goes only to the migrate container, which gets nothing else.
      expect(stackEnvironment(files, "api")).not.toHaveProperty("DATABASE_MIGRATION_URL");
      expect(Object.keys(stackEnvironment(files, "migrate")).sort()).toEqual([
        "DATABASE_MIGRATION_URL",
        "DATABASE_URL",
      ]);
    },
  );

  it.each(STACKS.map((files) => [files.join(" + "), files] as const))(
    "%s never unsets a value the app image bakes in",
    (_name, files) => {
      // A key with no value is removed from the container when unset, image ENV included.
      const dockerfile = readFileSync(path.join(composeDir, "Dockerfile"), "utf8");
      const baked = [...dockerfile.matchAll(/^ENV\s+([A-Za-z_][A-Za-z0-9_]*)=/gm)].map(
        (match) => match[1] ?? "",
      );
      expect(baked).toContain("GIT_SHA");
      for (const service of ["api", "worker"]) {
        const environment = stackEnvironment(files, service);
        for (const key of baked) {
          if (key in environment)
            expect({ key, value: environment[key] }).not.toEqual({ key, value: null });
        }
      }
    },
  );
});
