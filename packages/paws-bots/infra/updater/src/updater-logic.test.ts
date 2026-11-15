import { DEFAULT_COMPOSE_PROJECT_NAME, isLocalImageTag } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_COMPOSE_FILE,
  DEFAULT_UPDATER_PORT,
  missingSecretAssignments,
  readEnvAssignment,
  readTagState,
  resolveUpdaterConfig,
  truncateOutput,
} from "./updater-logic.js";

const base = {
  RAKAZO_DEPLOY_DIR: "/srv/rakazo",
  RAKAZO_UPDATER_TOKEN: "fake-review-updater-token-000000000000",
} as const;

describe("resolveUpdaterConfig", () => {
  it("derives the compose file, env file, and defaults from the deployment directory", () => {
    const config = resolveUpdaterConfig({ ...base });
    expect(config).toMatchObject({
      deployDir: "/srv/rakazo",
      composeFiles: [`/srv/rakazo/${DEFAULT_COMPOSE_FILE}`],
      updateServices: ["api", "worker", "web"],
      envFile: "/srv/rakazo/.env",
      projectName: DEFAULT_COMPOSE_PROJECT_NAME,
      token: base.RAKAZO_UPDATER_TOKEN,
      port: DEFAULT_UPDATER_PORT,
    });
  });

  it("uses the Compose-injected project name so -p matches the running stack", () => {
    expect(
      resolveUpdaterConfig({ ...base, COMPOSE_PROJECT_NAME: "operator-stack" }).projectName,
    ).toBe("operator-stack");
    expect(
      resolveUpdaterConfig({ ...base, RAKAZO_COMPOSE_PROJECT_NAME: "manual-stack" }).projectName,
    ).toBe("manual-stack");
  });

  it("refuses a project name it would not pass as a single -p argument", () => {
    expect(() => resolveUpdaterConfig({ ...base, COMPOSE_PROJECT_NAME: "-f" })).toThrow(
      /project name/,
    );
  });

  it("binds to loopback unless the deployment says otherwise, so a stray port is not a door", () => {
    expect(resolveUpdaterConfig({ ...base }).host).toBe("127.0.0.1");
    expect(resolveUpdaterConfig({ ...base, RAKAZO_UPDATER_HOST: "0.0.0.0" }).host).toBe("0.0.0.0");
  });

  it("refuses a deployment directory that is missing or relative", () => {
    expect(() => resolveUpdaterConfig({ RAKAZO_UPDATER_TOKEN: "t" })).toThrow(/RAKAZO_DEPLOY_DIR/);
    expect(() => resolveUpdaterConfig({ ...base, RAKAZO_DEPLOY_DIR: "srv/rakazo" })).toThrow(
      /RAKAZO_DEPLOY_DIR/,
    );
  });

  it("refuses a compose path that escapes the deployment directory", () => {
    for (const composeFile of ["/etc/compose.yml", "../../etc/compose.yml", "a/../../b.yml"]) {
      expect(() => resolveUpdaterConfig({ ...base, RAKAZO_COMPOSE_FILE: composeFile })).toThrow(
        /RAKAZO_COMPOSE_FILE/,
      );
    }
  });

  it("resolves a Compose file list in order, against the deployment directory", () => {
    expect(
      resolveUpdaterConfig({
        ...base,
        RAKAZO_COMPOSE_FILE: "infra/compose/docker-compose.prod.yml:ops/overlay.yml",
      }).composeFiles,
    ).toEqual(["/srv/rakazo/infra/compose/docker-compose.prod.yml", "/srv/rakazo/ops/overlay.yml"]);
  });

  it("honours COMPOSE_PATH_SEPARATOR the way Compose does", () => {
    expect(
      resolveUpdaterConfig({
        ...base,
        COMPOSE_PATH_SEPARATOR: ",",
        RAKAZO_COMPOSE_FILE: "a.yml,b.yml",
      }).composeFiles,
    ).toEqual(["/srv/rakazo/a.yml", "/srv/rakazo/b.yml"]);
  });

  it("checks every entry in a list, not just the first", () => {
    expect(() =>
      resolveUpdaterConfig({
        ...base,
        RAKAZO_COMPOSE_FILE: "infra/compose/docker-compose.prod.yml:../../etc/compose.yml",
      }),
    ).toThrow(/RAKAZO_COMPOSE_FILE/);
    expect(() =>
      resolveUpdaterConfig({
        ...base,
        RAKAZO_COMPOSE_FILE: "infra/compose/docker-compose.prod.yml:/etc/compose.yml",
      }),
    ).toThrow(/RAKAZO_COMPOSE_FILE/);
  });

  it("refuses a Compose file list that names nothing", () => {
    expect(() => resolveUpdaterConfig({ ...base, RAKAZO_COMPOSE_FILE: ":  :" })).toThrow(
      /RAKAZO_COMPOSE_FILE/,
    );
  });

  it("appends the deployment's extra services to the built-in set", () => {
    expect(
      resolveUpdaterConfig({ ...base, RAKAZO_UPDATE_SERVICES: "supervisor, caddy" }).updateServices,
    ).toEqual(["api", "worker", "web", "supervisor", "caddy"]);
  });

  it("cannot drop a built-in service, however RAKAZO_UPDATE_SERVICES is written", () => {
    const services = resolveUpdaterConfig({
      ...base,
      RAKAZO_UPDATE_SERVICES: "web,supervisor",
    }).updateServices;
    expect(services).toEqual(["api", "worker", "web", "supervisor"]);
  });

  it("refuses to recreate the updater, which would kill the run mid-flight", () => {
    expect(() =>
      resolveUpdaterConfig({ ...base, RAKAZO_UPDATE_SERVICES: "supervisor,updater" }),
    ).toThrow(/updater/);
  });

  it("refuses a service name it would not hand to compose as one argument", () => {
    for (const service of ["--build", "a b", "-f", "api;rm"]) {
      expect(() =>
        resolveUpdaterConfig({ ...base, RAKAZO_UPDATE_SERVICES: `supervisor,${service}` }),
      ).toThrow(/RAKAZO_UPDATE_SERVICES/);
    }
  });

  it("refuses an image name it would not be willing to hand to compose", () => {
    expect(() => resolveUpdaterConfig({ ...base, RAKAZO_IMAGE: "Bad Name" })).toThrow(
      /RAKAZO_IMAGE/,
    );
    expect(resolveUpdaterConfig({ ...base, RAKAZO_IMAGE: "ghcr.io/me/app" }).image).toBe(
      "ghcr.io/me/app",
    );
  });

  it("refuses a port that is not a port", () => {
    expect(() => resolveUpdaterConfig({ ...base, RAKAZO_UPDATER_PORT: "0" })).toThrow(/port/);
    expect(() => resolveUpdaterConfig({ ...base, RAKAZO_UPDATER_PORT: "seven" })).toThrow(/port/);
  });
});

describe("readEnvAssignment", () => {
  it("reads the last assignment, ignoring comments and blank lines", () => {
    const contents = ["# RAKAZO_IMAGE_TAG=commented", "", "A=1", "A=2"].join("\n");
    expect(readEnvAssignment(contents, "A")).toBe("2");
    expect(readEnvAssignment(contents, "RAKAZO_IMAGE_TAG")).toBeNull();
  });

  it("removes one layer of quoting", () => {
    expect(readEnvAssignment('A="v1.0.0"', "A")).toBe("v1.0.0");
    expect(readEnvAssignment("A='v1.0.0'", "A")).toBe("v1.0.0");
  });

  it.each([
    "A=v1.2.3 # pinned",
    "A=v1.2.3\t# pinned",
    'A="v1.2.3" # pinned',
    "A='v1.2.3' # pinned",
    'A="v1.2.3"# pinned',
    'A="v1.2.3" # "pinned"',
    "A='v1.2.3' # 'pinned'",
  ])("ignores Compose inline comments in %s", (contents) => {
    expect(readEnvAssignment(contents, "A")).toBe("v1.2.3");
  });

  it.each([
    ["A=value#literal", "value#literal"],
    ["A=#literal", "#literal"],
    ['A="value # literal" # comment', "value # literal"],
    ["A='value # literal' # comment", "value # literal"],
    ['A="value \\" # literal" # comment', 'value \\" # literal'],
    ["A= # comment", ""],
    ['A="" # comment', ""],
    ["A='' # comment", ""],
  ])("preserves the value in %s", (contents, expected) => {
    expect(readEnvAssignment(contents, "A")).toBe(expected);
  });

  it("does not match a key that merely shares a prefix", () => {
    expect(readEnvAssignment("RAKAZO_IMAGE_TAG_PREVIOUS=v1", "RAKAZO_IMAGE_TAG")).toBeNull();
  });
});

describe("missingSecretAssignments", () => {
  const generate = () => "f".repeat(32);

  it("adds the app database password to a .env from before database roles", () => {
    expect(missingSecretAssignments("POSTGRES_PASSWORD=x\n", generate)).toEqual({
      POSTGRES_APP_PASSWORD: generate(),
    });
    expect(missingSecretAssignments("POSTGRES_APP_PASSWORD=\n", generate)).toEqual({
      POSTGRES_APP_PASSWORD: generate(),
    });
  });

  it("never replaces a password that is already set", () => {
    expect(missingSecretAssignments("POSTGRES_APP_PASSWORD='kept'\n", generate)).toEqual({});
  });

  it.each(["kept#literal", "'kept # literal' # comment", '"kept # literal" # comment'])(
    "keeps an existing password containing a hash: %s",
    (value) => {
      expect(missingSecretAssignments(`POSTGRES_APP_PASSWORD=${value}\n`, generate)).toEqual({});
    },
  );

  it("generates a password when the assignment contains only a comment", () => {
    expect(missingSecretAssignments("POSTGRES_APP_PASSWORD= # comment\n", generate)).toEqual({
      POSTGRES_APP_PASSWORD: generate(),
    });
  });

  it("generates a URI-safe value by default", () => {
    expect(missingSecretAssignments("").POSTGRES_APP_PASSWORD).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("readTagState", () => {
  it("reads the pinned tag and the rollback tag", () => {
    const contents = "RAKAZO_IMAGE_TAG=v1.1.0\nRAKAZO_IMAGE_TAG_PREVIOUS=v1.0.0\n";
    expect(readTagState(contents)).toEqual({ currentTag: "v1.1.0", previousTag: "v1.0.0" });
  });

  it.each(["", '"', "'"])("reads tags with inline comments and %j quoting", (quote) => {
    const contents = [
      `RAKAZO_IMAGE_TAG=${quote}v1.2.3${quote} # pinned`,
      `RAKAZO_IMAGE_TAG_PREVIOUS=${quote}v1.2.2${quote} # rollback`,
    ].join("\n");
    expect(readTagState(contents)).toEqual({ currentTag: "v1.2.3", previousTag: "v1.2.2" });
  });

  it("falls back to the locally built tag when nothing is pinned yet", () => {
    expect(readTagState("")).toEqual({ currentTag: "local", previousTag: null });
  });

  it("ignores values in the file that are not usable tags", () => {
    const contents = "RAKAZO_IMAGE_TAG=-rm\nRAKAZO_IMAGE_TAG_PREVIOUS=$(id)\n";
    expect(readTagState(contents)).toEqual({ currentTag: "local", previousTag: null });
  });

  /**
   * The fallback has to be a tag no registry serves. A deployment that has never been pinned has
   * only ever built its images locally, so a fallback of `latest` would send both a first
   * `docker compose up` and a rollback to a registry that may have nothing under that name.
   */
  it("falls back to a tag that is local-only, so nothing tries to pull it", () => {
    expect(isLocalImageTag(readTagState("").currentTag)).toBe(true);
  });
});

describe("truncateOutput", () => {
  it("keeps short output as-is and keeps the tail of long output", () => {
    expect(truncateOutput("done\n")).toBe("done");
    const long = truncateOutput("x".repeat(20_000));
    expect(long.startsWith("…")).toBe(true);
    expect(long.length).toBeLessThan(9_000);
  });
});
