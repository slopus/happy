import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

interface ComposeService {
  image?: string;
  build?: unknown;
  command?: unknown;
  env_file?: unknown;
  /** YAML may parse unquoted scalars as null/number/boolean. */
  environment?: Record<string, unknown>;
  volumes?: string[];
  ports?: unknown[];
  user?: string;
  restart?: string;
  network_mode?: string;
  networks?: string[];
}

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const composeFile = path.resolve(repoRoot, "infra/compose/docker-compose.images.yml");
const publishWorkflowFile = path.resolve(repoRoot, ".github/workflows/publish-server-image.yml");
const compose = parse(readFileSync(composeFile, "utf8"), { merge: true }) as {
  services: Record<string, ComposeService>;
};
const publishWorkflow = parse(readFileSync(publishWorkflowFile, "utf8")) as {
  jobs?: {
    publish?: {
      strategy?: {
        matrix?: {
          include?: Array<{ name?: string }>;
        };
      };
    };
  };
};

const appServices = ["api", "worker", "web", "supervisor", "migrate"] as const;
const FIRST_PARTY_IMAGE = /ghcr\.io\/elie222\/rakazo\/([a-z0-9][a-z0-9._-]*)/g;

function firstPartyImageNames(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return [...value.matchAll(FIRST_PARTY_IMAGE)].map((match) => match[1] ?? "");
}

/**
 * The images compose file is the no-checkout happy path. It must stay pull-only and self-contained
 * so operators can drop it next to a .env outside any git worktree. Local Docker computers run via
 * an in-stack supervisor (app image + docker.sock) that stays unpublished on the host.
 */
describe("the images compose file", () => {
  it("runs postgres, app roles, supervisor, and a published computer image", () => {
    expect(Object.keys(compose.services).sort()).toEqual([
      "api",
      "computer",
      "data-init",
      "migrate",
      "postgres",
      "supervisor",
      "web",
      "worker",
    ]);
    for (const service of appServices) {
      expect(compose.services[service]?.image).toContain("ghcr.io/elie222/rakazo/app");
      expect(compose.services[service]?.image).toContain("RAKAZO_IMAGE_TAG");
    }
    expect(compose.services.computer?.image).toContain("ghcr.io/elie222/rakazo/computer");
    expect(compose.services.computer?.image).toContain("RAKAZO_COMPUTER_IMAGE_TAG");
    expect(compose.services.postgres?.image).toMatch(
      /^\$\{POSTGRES_IMAGE:-postgres:16@sha256:[0-9a-f]{64}\}$/,
    );
    expect(compose.services["data-init"]?.image).toMatch(/^\$\{BUSYBOX_IMAGE:-busybox:1\}$/);
  });

  it("skips non-string Compose environment scalars when collecting image names", () => {
    expect(firstPartyImageNames(null)).toEqual([]);
    expect(firstPartyImageNames(true)).toEqual([]);
    expect(firstPartyImageNames(7091)).toEqual([]);
    expect(firstPartyImageNames("ghcr.io/elie222/rakazo/computer:edge")).toEqual(["computer"]);
  });

  it("only references first-party images that the publish matrix publishes", () => {
    const published = new Set(
      (publishWorkflow.jobs?.publish?.strategy?.matrix?.include ?? [])
        .map((entry) => entry.name)
        .filter((name): name is string => typeof name === "string" && name.length > 0),
    );
    const referenced = new Set<string>();
    for (const service of Object.values(compose.services)) {
      for (const name of firstPartyImageNames(service.image)) {
        referenced.add(name);
      }
      for (const value of Object.values(service.environment ?? {})) {
        for (const name of firstPartyImageNames(value)) {
          referenced.add(name);
        }
      }
    }
    expect(published.size).toBeGreaterThan(0);
    expect(referenced.has("computer")).toBe(true);
    for (const name of referenced) {
      expect(
        published.has(name),
        `${name} referenced by images compose but omitted from publish matrix`,
      ).toBe(true);
    }
  });

  it("passes optional HTTP(S)_PROXY / NO_PROXY into api and worker", () => {
    for (const name of ["api", "worker"] as const) {
      const env = compose.services[name]?.environment ?? {};
      expect(env.HTTP_PROXY).toBe("${HTTP_PROXY:-${http_proxy:-}}");
      expect(env.HTTPS_PROXY).toBe("${HTTPS_PROXY:-${https_proxy:-}}");
      expect(env.NO_PROXY).toBe("${NO_PROXY:-${no_proxy:-}}");
      expect(env.http_proxy).toBe("${http_proxy:-${HTTP_PROXY:-}}");
      expect(env.https_proxy).toBe("${https_proxy:-${HTTPS_PROXY:-}}");
      expect(env.no_proxy).toBe("${no_proxy:-${NO_PROXY:-}}");
    }
  });

  it("does not allocate a default network for offline init services", () => {
    for (const name of ["computer", "data-init"]) {
      expect(compose.services[name]?.network_mode).toBe("none");
      expect(compose.services[name]?.networks).toBeUndefined();
    }
    for (const name of ["postgres", ...appServices]) {
      expect(compose.services[name]?.networks?.length).toBeGreaterThan(0);
    }
    // Migrations only reach the database, never the internet.
    expect(compose.services.migrate?.networks).toEqual(["data"]);
  });

  it("never builds from a checkout", () => {
    for (const service of Object.values(compose.services)) {
      expect(service.build).toBeUndefined();
    }
  });

  it("passes secrets from the --env-file by name instead of loading the whole file", () => {
    for (const service of ["api", "worker"]) {
      expect(compose.services[service]?.env_file).toBeUndefined();
      // A key with no value is filled from the --env-file when set and left unset otherwise.
      expect(compose.services[service]?.environment).toHaveProperty("ENCRYPTION_KEY", null);
      expect(compose.services[service]?.environment).toHaveProperty("OPENROUTER_API_KEY", null);
    }
  });

  it("defaults API and worker to Docker computers via the supervisor", () => {
    expect(compose.services.api?.environment?.SANDBOX_PROVIDER).toContain("docker");
    expect(compose.services.worker?.environment?.SANDBOX_PROVIDER).toContain("docker");
    expect(compose.services.api?.environment?.SANDBOX_SUPERVISOR_URL).toBe(
      "http://supervisor:7091",
    );
    expect(compose.services.worker?.environment?.SANDBOX_SUPERVISOR_URL).toBe(
      "http://supervisor:7091",
    );
  });

  it("keeps the Docker socket on the unpublished supervisor only", () => {
    for (const [name, service] of Object.entries(compose.services)) {
      const hasSocket = (service.volumes ?? []).some((volume) => volume.includes("docker.sock"));
      if (name === "supervisor") {
        expect(hasSocket).toBe(true);
        expect(service.ports).toBeUndefined();
        expect(service.user).toBe("root");
        expect(String(service.command)).toContain("sandbox-supervisor");
      } else {
        expect(hasSocket).toBe(false);
      }
    }
  });

  it("defaults the configurable web bind to loopback and keeps the API private", () => {
    expect(compose.services.web?.ports).toEqual([
      "${RAKAZO_WEB_BIND:-127.0.0.1}:${RAKAZO_WEB_PORT:-5173}:5173",
    ]);
    expect(compose.services.api?.ports).toEqual(["127.0.0.1:${RAKAZO_API_PORT:-3100}:3100"]);
    for (const key of ["BETTER_AUTH_URL", "WEB_ORIGIN", "API_URL"]) {
      expect(compose.services.api?.environment?.[key]).toBe(`\${${key}:-http://127.0.0.1:5173}`);
    }
    expect(compose.services.postgres?.ports).toBeUndefined();
    expect(compose.services.supervisor?.ports).toBeUndefined();
  });

  it("passes logging variables to the supervisor without putting them on computer containers", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: this is the literal Compose expression
    expect(compose.services.supervisor?.environment?.AXIOM_TOKEN).toBe("${AXIOM_TOKEN:-}");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: this is the literal Compose expression
    expect(compose.services.supervisor?.environment?.AXIOM_DATASET).toBe("${AXIOM_DATASET:-}");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: this is the literal Compose expression
    expect(compose.services.supervisor?.environment?.SENTRY_DSN).toBe("${SENTRY_DSN:-}");
    expect(compose.services.computer?.environment?.AXIOM_TOKEN).toBeUndefined();
    expect(compose.services.computer?.environment?.SENTRY_DSN).toBeUndefined();
    expect(compose.services.computer?.environment?.LOG_LEVEL).toBeUndefined();
  });
});
