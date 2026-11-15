import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { RECREATED_SERVICES } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

interface ComposeService {
  image?: string;
  profiles?: string[];
  ports?: unknown[];
  networks?: string[];
  volumes?: string[];
  environment?: Record<string, string>;
  env_file?: unknown;
  command?: unknown;
  user?: string;
  build?: unknown;
}

const composeDir = path.resolve(import.meta.dirname, "../../compose");
const composeFile = path.join(composeDir, "docker-compose.prod.yml");
const compose = parse(readFileSync(composeFile, "utf8"), { merge: true }) as {
  services: Record<string, ComposeService>;
  networks: Record<string, unknown>;
};
const updater = compose.services.updater as ComposeService;

describe("the production computer provider", () => {
  it.each(["api", "worker"])("lets .env select the %s provider with an E2B default", (name) => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: this is the literal Compose expression
    expect(compose.services[name]?.environment?.SANDBOX_PROVIDER).toBe("${SANDBOX_PROVIDER:-e2b}");
  });
});

/**
 * The updater holds the Docker socket, which is root-equivalent on the host. These are the
 * properties that keep that from being reachable by anything but the API, and they are easy to
 * break by accident in YAML, so they are asserted rather than reviewed.
 */
/** The Compose interpolation this file is expected to carry, as Compose spells it. */
const interpolated = (name: string, fallback = "") => `\${${name}:-${fallback}}`;

describe("worker error reporting configuration", () => {
  it.each([
    "docker-compose.yml",
    "docker-compose.prod.yml",
    "docker-compose.images.yml",
    "docker-compose.prod.docker.yml",
  ])("passes optional settings through %s", (file) => {
    const { services } = parse(
      readFileSync(path.resolve(import.meta.dirname, "../../compose", file), "utf8"),
      { merge: true },
    ) as { services: Record<string, ComposeService> };
    for (const key of ["SENTRY_DSN", "SENTRY_ENVIRONMENT", "SENTRY_RELEASE"]) {
      expect(services.worker?.environment?.[key]).toBe(interpolated(key));
    }
  });
});

describe("the updater compose service", () => {
  it("exists and runs the updater image", () => {
    expect(updater).toBeDefined();
    expect(updater.image).toMatch(/updater/);
  });

  it("is opt-in because it grants root-equivalent Docker access", () => {
    expect(updater.profiles).toEqual(["updater"]);
  });

  it("publishes nothing on the host", () => {
    expect(updater.ports).toBeUndefined();
  });

  it("shares a dedicated control network with the API and not Caddy", () => {
    expect(updater.networks).toEqual(["control"]);
    expect(compose.services.api?.networks).toContain("control");
    expect(compose.services.caddy?.networks).not.toContain("control");
    expect(compose.networks).toHaveProperty("control");
  });

  it("is the only service holding the Docker socket", () => {
    const withSocket = Object.entries(compose.services)
      .filter(([, service]) =>
        (service.volumes ?? []).some((volume) => volume.includes("docker.sock")),
      )
      .map(([name]) => name);
    expect(withSocket).toEqual(["updater"]);
  });

  it("is bind-mounted at the same path it has on the host", () => {
    const mount = (updater.volumes ?? []).find((volume) => volume.includes("RAKAZO_DEPLOY_DIR"));
    // biome-ignore lint/suspicious/noTemplateCurlyInString: this is the literal Compose expression
    const deployDir = "${RAKAZO_DEPLOY_DIR:-/srv/rakazo}";
    const separatorIndex = mount?.indexOf("}:${") ?? -1;
    const source = separatorIndex < 0 ? undefined : mount?.slice(0, separatorIndex + 1);
    const destination = separatorIndex < 0 ? undefined : mount?.slice(separatorIndex + 2);
    expect(updater.environment?.RAKAZO_DEPLOY_DIR).toBe(deployDir);
    expect(mount).toBe(`${deployDir}:${deployDir}`);
    expect(source).toBe(destination);
  });

  it("is not one of the services an update recreates", () => {
    expect(RECREATED_SERVICES).not.toContain("updater");
    for (const service of RECREATED_SERVICES) {
      expect(Object.keys(compose.services)).toContain(service);
    }
  });

  it("pins its own image tag separately from the application image", () => {
    expect(updater.image).toContain("RAKAZO_UPDATER_IMAGE_TAG");
    for (const service of RECREATED_SERVICES) {
      expect(compose.services[service]?.image).toContain("RAKAZO_IMAGE_TAG");
    }
  });

  it("uses the official registry namespace and digest-pins third-party runtime images", () => {
    expect(updater.image).toContain("ghcr.io/elie222/rakazo/updater");
    expect(compose.services.api?.image).toContain("ghcr.io/elie222/rakazo/app");
    expect(compose.services.postgres?.image).toMatch(
      /^\$\{POSTGRES_IMAGE:-postgres:18@sha256:edb0c08dc33befd0262ab3b5cf1c4f3f8cfd8b09e88c05b45adee29d6761ddb6\}$/,
    );
    expect(compose.services.caddy?.image).toMatch(
      /^\$\{CADDY_IMAGE:-caddy:2@sha256:df7f1c2fb114453b951de51a98efc010db1655a92c2e86be6706714e2417a78d\}$/,
    );
  });

  it("lets a deployment name its own Compose files and extra services", () => {
    // resolveUpdaterConfig reads these from the sidecar's environment, and the sidecar's
    // environment is exactly what this file declares. Pinning them here would make the documented
    // variables inert: the operator sets them, the updater never sees them, and the overlay is
    // dropped on every recreate.
    expect(updater.environment?.RAKAZO_COMPOSE_FILE).toBe(
      interpolated("RAKAZO_COMPOSE_FILE", "infra/compose/docker-compose.prod.yml"),
    );
    expect(updater.environment?.RAKAZO_UPDATE_SERVICES).toBe(
      interpolated("RAKAZO_UPDATE_SERVICES"),
    );
    expect(updater.environment?.COMPOSE_PATH_SEPARATOR).toBe(
      interpolated("COMPOSE_PATH_SEPARATOR"),
    );
  });

  it("injects the actual Compose project name into the updater container", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: this is the literal Compose expression
    expect(updater.environment?.COMPOSE_PROJECT_NAME).toBe("${COMPOSE_PROJECT_NAME:-rakazo-prod}");
  });

  it("does not load the application env_file into the root-equivalent process", () => {
    expect(updater.env_file).toBeUndefined();
    // biome-ignore lint/suspicious/noTemplateCurlyInString: this is the literal Compose expression
    expect(updater.environment?.RAKAZO_UPDATER_TOKEN).toBe("${RAKAZO_UPDATER_TOKEN:-}");
  });

  it("does not let the api container reach the Docker socket to update itself", () => {
    expect(compose.services.api?.volumes ?? []).not.toContain("/var/run/docker.sock");
    expect(compose.services.api?.environment?.RAKAZO_UPDATER_URL).toBeUndefined();
    expect(compose.services.api?.environment?.RAKAZO_UPDATER_TOKEN).toBeUndefined();
  });

  it("passes logging configuration without using env_file", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: this is the literal Compose expression
    expect(updater.environment?.LOG_LEVEL).toBe("${LOG_LEVEL:-info}");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: this is the literal Compose expression
    expect(updater.environment?.AXIOM_TOKEN).toBe("${AXIOM_TOKEN:-}");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: this is the literal Compose expression
    expect(updater.environment?.AXIOM_DATASET).toBe("${AXIOM_DATASET:-}");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: this is the literal Compose expression
    expect(updater.environment?.AXIOM_EDGE_URL).toBe("${AXIOM_EDGE_URL:-}");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: this is the literal Compose expression
    expect(updater.environment?.SENTRY_DSN).toBe("${SENTRY_DSN:-}");
  });
});

/**
 * Point-in-time recovery is opt-in, and the database it reads must stay without egress. These
 * properties keep enabling it from exposing Postgres or restarting it for anyone else.
 */
describe("the point-in-time recovery sidecar", () => {
  const pitr = compose.services.pitr as ComposeService;

  it("only runs with its profile", () => {
    expect(pitr.profiles).toEqual(["pitr"]);
  });

  it("leaves Postgres on the internal data network alone", () => {
    expect(compose.services.postgres?.networks).toEqual(["data"]);
    expect(compose.networks.data).toEqual({ internal: true });
    expect(pitr.networks).toEqual(["data", "backup"]);
    const onBackup = Object.entries(compose.services)
      .filter(([, service]) => service.networks?.includes("backup"))
      .map(([name]) => name);
    expect(onBackup).toEqual(["pitr"]);
  });

  it("gets the replication login and storage settings, not the owner or app secrets", () => {
    expect(Object.keys(pitr.environment ?? {}).sort()).toEqual([
      "PGDATABASE",
      "PGHOST",
      "PGPASSWORD",
      "PGUSER",
      "PITR_ACCESS_KEY_ID",
      "PITR_AGE_RECIPIENTS",
      "PITR_BUCKET",
      "PITR_ENDPOINT",
      "PITR_MAX_WAL_GB",
      "PITR_PATH_STYLE",
      "PITR_PREFIX",
      "PITR_REGION",
      "PITR_RETAIN_DAYS",
      "PITR_SECRET_ACCESS_KEY",
      "TINI_KILL_PROCESS_GROUP",
    ]);
    expect(pitr.environment?.PGUSER).toBe("rakazo_pitr");
    expect(pitr.environment?.PGPASSWORD).toBe(interpolated("PITR_DATABASE_PASSWORD"));
    expect(pitr.env_file).toBeUndefined();
    expect(pitr.ports).toBeUndefined();
    expect(pitr.user).toBe("postgres");
  });

  it("is tagged with a hash of what it is built from, so a deploy rebuilds it only on change", () => {
    const hash = createHash("sha256");
    for (const file of ["Dockerfile.pitr", "pitr-agent.sh", "apt-security.sh"]) {
      hash.update(readFileSync(path.join(composeDir, file)));
    }
    expect(pitr.image).toBe(`rakazo-pitr:${hash.digest("hex").slice(0, 16)}`);
  });

  it("runs the apt security helper smoke, including the copy equality check", () => {
    execFileSync("bash", [path.join(composeDir, "apt-security.smoke.sh")], { stdio: "inherit" });
  });

  it("builds on the same pinned Postgres image as the database", () => {
    const dockerfile = readFileSync(path.join(composeDir, "Dockerfile.pitr"), "utf8");
    const pinned = compose.services.postgres?.image?.match(/postgres:18@sha256:[0-9a-f]{64}/)?.[0];
    expect(pinned).toBeDefined();
    expect(dockerfile).toContain(`ARG POSTGRES_IMAGE=${pinned}`);
    expect(pitr.build).toMatchObject({
      args: { POSTGRES_IMAGE: interpolated("POSTGRES_IMAGE", pinned) },
    });
  });
});
