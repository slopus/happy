import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const COMPOSE = "docker compose --env-file .env -f infra/compose/docker-compose.prod.yml";
const APP_IMAGE = "ghcr.example.test/rakazo/app:local";
// Each rolled service gains a new container, which must pass its health check before the old
// one stops; the rest of the stack is reconciled afterwards.
const WORKERS = "docker inspect --format {{.Id}} {{.HostConfig.RestartPolicy.Name}}";
const startBeside = (service: string) => [
  `${COMPOSE} up -d --no-deps --no-recreate --scale ${service}=2 ${service}`,
  `${COMPOSE} ps --all --quiet ${service}`,
  `docker inspect --format {{.State.Status}}{{if .State.Health}} {{.State.Health.Status}}{{end}} ${service}-new`,
];
const rolloutSteps = (revision: string) => [
  // The image the running API uses, restored if the deploy fails.
  `${COMPOSE} ps --quiet api`,
  "docker inspect --format {{.Image}} api-old",
  `${COMPOSE} config --quiet`,
  `${COMPOSE} config`,
  `${COMPOSE} build --build-arg GIT_SHA=${revision}`,
  // No worker is still draining from an earlier deploy.
  `${COMPOSE} ps --all --quiet worker`,
  `${WORKERS} worker-old`,
  // Only this container gets the database owner login; the old API keeps serving meanwhile.
  `${COMPOSE} config --services`,
  `${COMPOSE} run --rm -T -e RAKAZO_DEPLOYED_MIGRATIONS= migrate`,
  ...["api", "web"].flatMap((service) => [
    `${COMPOSE} ps --all --quiet ${service}`,
    ...startBeside(service),
    `docker stop --time 30 ${service}-old`,
    `docker rm ${service}-old`,
  ]),
  // The old worker is told to finish its jobs instead of being stopped.
  `${COMPOSE} ps --all --quiet worker`,
  `${WORKERS} worker-old`,
  `${COMPOSE} ps --all --quiet worker`,
  `${WORKERS} worker-old`,
  ...startBeside("worker"),
  "docker update --restart no worker-old",
  "docker kill --signal SIGTERM worker-old",
  `${COMPOSE} config --services`,
  `${COMPOSE} up -d --no-deps --remove-orphans api`,
];
// After a healthy deploy, the deploy waits for the old worker to finish and removes it.
const finishDraining = [
  `${COMPOSE} ps --all --quiet worker`,
  `${WORKERS} worker-old worker-new`,
  "docker stop worker-old",
  "docker rm worker-old",
];
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function write(file: string, content: string, mode?: number) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  if (mode) chmodSync(file, mode);
}

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function commit(cwd: string, message: string) {
  write(path.join(cwd, "revision.txt"), `${message}\n`);
  git(cwd, "add", "revision.txt");
  git(
    cwd,
    "-c",
    "user.name=Example",
    "-c",
    "user.email=example@example.test",
    "commit",
    "-qm",
    message,
  );
  return git(cwd, "rev-parse", "HEAD");
}

function rollout(commands: string[]) {
  return commands
    .map((line) => line.split(" @ ")[0] ?? line)
    .filter(
      (line) =>
        / (config|build|up|ps) /.test(`${line} `) ||
        line.includes(" run --rm -T -e RAKAZO_DEPLOYED_MIGRATIONS=") ||
        /^docker (inspect|stop|rm|update|kill) /.test(line),
    );
}

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "rakazo-deploy-"));
  temporaryDirectories.push(root);
  const upstream = path.join(root, "upstream");
  const checkout = path.join(root, "checkout with spaces");
  const bin = path.join(root, "bin");
  mkdirSync(upstream);
  git(upstream, "init", "-q", "-b", "main");
  const first = commit(upstream, "first");
  git(root, "clone", "-q", upstream, checkout);
  write(path.join(checkout, ".env"), "RAKAZO_HOST=app.example.test\n");
  const log = path.join(root, "commands.log");
  // Record every privileged or network command instead of running it.
  write(path.join(bin, "sudo"), '#!/bin/bash\nexec "$@"\n', 0o755);
  write(
    path.join(bin, "timeout"),
    '#!/bin/bash\nwhile [[ "$1" == --* ]]; do shift; done\nshift\nexec "$@"\n',
    0o755,
  );
  write(
    path.join(bin, "docker"),
    `#!/bin/bash
revision="$(<revision.txt)"
echo "docker $* @ $revision" >> "$COMMAND_LOG"
if [[ "$*" == *" build "* && "$revision" == "\${FAIL_BUILD:-}" ]]; then exit 1; fi
if [[ "$1" == info ]]; then echo /var/lib/docker; fi
if [[ "$*" == *" config" ]]; then printf "services:\\n  api:\\n    image: ${APP_IMAGE}\\n"; fi
if [[ "$1" == inspect && "$*" == *"{{.Image}}"* ]]; then
  [[ -n "\${PREVIOUS_IMAGE-sha256:previous}" ]] || exit 1
  echo "\${PREVIOUS_IMAGE-sha256:previous}"
  exit 0
fi
if [[ "$*" == *" ps --quiet api" && -z "\${FRESH:-}" ]]; then echo api-old; fi
if [[ "$*" == *" run --rm --no-deps -T --entrypoint sh postgres "* && -n "\${POSTGRES_16:-}" ]]; then
  echo upgrade
fi
if [[ "$*" == *" config --services" && -n "\${MIGRATE_LISTED_FIRST:-}" ]]; then
  echo migrate
  sleep 0.2
  echo api
elif [[ "$*" == *" config --services" ]]; then
  echo api
  [[ "$revision" == "\${NO_MIGRATE_REVISION:-}" ]] || echo migrate
fi
if [[ "$*" == *" run --rm -T -e RAKAZO_DEPLOYED_MIGRATIONS="* && ( -n "\${FAIL_MIGRATE:-}" || "$revision" == "\${NO_MIGRATE_REVISION:-}" ) ]]; then exit 1; fi
if [[ "$1" == pull && -n "\${FAIL_PULL:-}" ]]; then exit 1; fi
if [[ "$*" == *" images -q" ]]; then echo sha256:running; fi
if [[ "$1" == tag && -n "\${FAIL_TAG:-}" ]]; then exit 1; fi
# Containers as "<name> <restart policy> <state>", named after their service. Each rolled service
# starts with one, --scale adds new ones, and EXTRA_WORKER adds a worker an earlier deploy drained.
containers="$COMMAND_LOG.containers"
if [[ ! -e "$containers" ]]; then
  : >"$containers"
  [[ -n "\${FRESH:-}" ]] || printf '%s unless-stopped running\n' api-old web-old worker-old >"$containers"
  [[ -z "\${EXTRA_WORKER:-}" ]] || echo "worker-older no \${EXTRA_WORKER}" >>"$containers"
fi
service="\${*: -1}"
if [[ "$*" == *" ps --all --quiet "* ]]; then
  awk -v prefix="$service-" 'index($1, prefix) == 1 { print $1 }' "$containers"
fi
if [[ "$*" == *" --scale "* ]]; then
  target="$*"
  target="\${target#*--scale $service=}"
  target="\${target%% *}"
  name="$service-new"
  for (( count = $(grep -c "^$service-" "$containers"); count < target; count++ )); do
    while grep -q "^$name " "$containers"; do name="\${name}x"; done
    echo "$name unless-stopped running" >>"$containers"
  done
fi
if [[ "$1" == rm ]]; then
  for name in "\${@:2}"; do sed -i.bak "/^$name /d" "$containers"; done
fi
if [[ "$1" == update ]]; then
  for name in "\${@:4}"; do sed -i.bak "s/^$name [^ ]*/$name no/" "$containers"; done
fi
if [[ "$1" == kill && -n "\${DRAIN_EXITS:-}" ]]; then
  for name in "\${@:4}"; do sed -i.bak "s/^$name \\([^ ]*\\) .*/$name \\1 exited/" "$containers"; done
fi
if [[ "$1" == inspect && "$*" == *RestartPolicy* ]]; then
  for name in "\${@:4}"; do grep "^$name " "$containers"; done
  exit 0
fi
if [[ "$1" == inspect ]]; then echo "\${CONTAINER_HEALTH:-running healthy}"; fi
if [[ "$*" == "image ls "* ]]; then echo rakazo-rollback:old; fi
exit 0
`,
    0o755,
  );
  write(
    path.join(bin, "df"),
    `#!/bin/bash
echo "df $*" >> "$COMMAND_LOG"
echo "Filesystem 1024-blocks Used Available Capacity Mounted on"
echo "/dev/fake 104857600 0 \${FREE_KB:-52428800} 0% /"
`,
    0o755,
  );
  write(
    path.join(bin, "curl"),
    `#!/bin/bash\necho "curl \${*: -1}" >> "$COMMAND_LOG"\n[[ -z "\${FAIL_HEALTH:-}" ]]\n`,
    0o755,
  );
  write(path.join(bin, "flock"), `#!/bin/bash\n[[ -z "\${LOCK_HELD:-}" ]]\n`, 0o755);
  const env = {
    PATH: [bin, "/usr/bin", "/bin"].join(path.delimiter),
    HOME: root,
    COMMAND_LOG: log,
    RAKAZO_DEPLOY_DIR: checkout,
    RAKAZO_DEPLOY_HEALTH_INTERVAL: "0",
  };
  return {
    upstream,
    checkout,
    first,
    run(overrides: Record<string, string> = {}) {
      const result = spawnSync("/bin/bash", [path.join(repoRoot, "infra/compose/deploy-main.sh")], {
        cwd: root,
        env: { ...env, ...overrides },
        encoding: "utf8",
        timeout: 20_000,
      });
      expect(result.error).toBeUndefined();
      return result;
    },
    commands(): string[] {
      try {
        return readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
      } catch {
        return [];
      }
    },
    head: () => git(checkout, "rev-parse", "HEAD"),
    deployed: () => readFileSync(path.join(checkout, ".last-deployed-revision"), "utf8").trim(),
  };
}

describe("production deploy script", () => {
  it("fails instead of reporting success while another deploy holds the lock", () => {
    const deploy = fixture();
    const next = commit(deploy.upstream, "next");
    const result = deploy.run({ LOCK_HELD: "1" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("holds the lock");
    expect(deploy.head()).not.toBe(next);
    expect(deploy.commands()).toEqual([]);
  });

  it("only checks health when production is already current", () => {
    const deploy = fixture();
    write(path.join(deploy.checkout, ".last-deployed-revision"), `${deploy.first}\n`);
    const result = deploy.run();
    expect(result.status).toBe(0);
    expect(deploy.commands().filter((line) => !/^(df|docker info) /.test(line))).toEqual([
      "curl https://app.example.test/health",
    ]);
  });

  it("deploys when the checkout matches but that revision was never recorded", () => {
    const deploy = fixture();
    const result = deploy.run();
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("already at");
    expect(deploy.head()).toBe(deploy.first);
    expect(deploy.deployed()).toBe(deploy.first);
    expect(rollout(deploy.commands())).toEqual([...rolloutSteps(deploy.first), ...finishDraining]);
  });

  it("deploys the revision the launcher pinned even after main moves on", () => {
    const deploy = fixture();
    const pinned = commit(deploy.upstream, "pinned");
    commit(deploy.upstream, "later");
    const result = deploy.run({ RAKAZO_DEPLOY_REVISION: pinned });
    expect(result.status).toBe(0);
    expect(deploy.head()).toBe(pinned);
    expect(deploy.deployed()).toBe(pinned);
    expect(rollout(deploy.commands())).toContain(`${COMPOSE} build --build-arg GIT_SHA=${pinned}`);
  });

  it("builds, starts, records, and prunes after a healthy rollout", () => {
    const deploy = fixture();
    const next = commit(deploy.upstream, "next");
    const result = deploy.run({ RAKAZO_DEPLOY_BUILD_CACHE_GB: "3" });
    expect(result.status).toBe(0);
    expect(deploy.head()).toBe(next);
    expect(deploy.deployed()).toBe(next);
    expect(rollout(deploy.commands())).toEqual([...rolloutSteps(next), ...finishDraining]);
    expect(deploy.commands().some((line) => line.includes(" caddy"))).toBe(false);
    const commands = deploy.commands().map((line) => line.split(" @ ")[0]!);
    expect(
      commands.slice(commands.findIndex((line) => line.includes("--remove-orphans")) + 1),
    ).toEqual([
      "curl https://app.example.test/health",
      "docker image ls --format {{.Repository}}:{{.Tag}} rakazo-rollback",
      "docker rmi rakazo-rollback:old",
      "docker tag sha256:running rakazo-rollback:running",
      "docker image prune --force",
      "docker builder prune --force --keep-storage 3GB",
      ...finishDraining,
    ]);
  });

  it("runs migrations when Compose is still listing services after migrate", () => {
    const deploy = fixture();
    commit(deploy.upstream, "next");
    expect(deploy.run({ MIGRATE_LISTED_FIRST: "1" }).status).toBe(0);
    expect(rollout(deploy.commands())).toContain(
      `${COMPOSE} run --rm -T -e RAKAZO_DEPLOYED_MIGRATIONS= migrate`,
    );
  });

  it("refuses malformed size settings before deploying", () => {
    const deploy = fixture();
    commit(deploy.upstream, "next");
    const cache = deploy.run({ RAKAZO_DEPLOY_BUILD_CACHE_GB: "8GB" });
    expect(cache.status).toBe(1);
    expect(cache.stderr).toContain("RAKAZO_DEPLOY_BUILD_CACHE_GB must be a whole number");
    const threshold = deploy.run({ RAKAZO_DEPLOY_MIN_FREE_GB: "08" });
    expect(threshold.status).toBe(1);
    expect(threshold.stderr).toContain("RAKAZO_DEPLOY_MIN_FREE_GB must be a whole number");
    expect(deploy.commands()).toEqual([]);
    expect(deploy.head()).toBe(deploy.first);
  });

  it("keeps every image when the previous ones could not be tagged", () => {
    const deploy = fixture();
    commit(deploy.upstream, "next");
    const result = deploy.run({ FAIL_TAG: "1" });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("skipping image prune");
    expect(deploy.commands().some((line) => line.startsWith("docker image prune"))).toBe(false);
  });

  it("refuses to build with too little free disk", () => {
    const deploy = fixture();
    commit(deploy.upstream, "next");
    const result = deploy.run({ FREE_KB: String(2 * 1024 * 1024), RAKAZO_DEPLOY_MIN_FREE_GB: "5" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Only 2GB free");
    expect(deploy.head()).toBe(deploy.first);
    expect(deploy.commands().some((line) => line.includes(" build"))).toBe(false);
  });

  it("replaces nothing while the database still needs its upgrade to Postgres 18", () => {
    const deploy = fixture();
    commit(deploy.upstream, "next");
    const result = deploy.run({ POSTGRES_16: "1" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("one-time upgrade to 18");
    expect(deploy.head()).toBe(deploy.first);
    expect(rollout(deploy.commands()).filter((line) => / (build|up) /.test(`${line} `))).toEqual(
      [],
    );
  });

  it("rolls back to the image the previous containers ran when the build fails", () => {
    const deploy = fixture();
    const broken = commit(deploy.upstream, "broken");
    const result = deploy.run({ FAIL_BUILD: "broken" });
    expect(result.status).toBe(1);
    expect(deploy.head()).toBe(deploy.first);
    const commands = deploy.commands().map((line) => line.split(" @ ")[0]!);
    expect(commands.filter((line) => line.startsWith(`${COMPOSE} build`))).toEqual([
      `${COMPOSE} build --build-arg GIT_SHA=${broken}`,
    ]);
    expect(commands).toContain(`docker tag sha256:previous ${APP_IMAGE}`);
    expect(deploy.commands()).toContainEqual(
      expect.stringMatching(/ up -d --no-deps --remove-orphans api @ first$/),
    );
    expect(commands.slice(-2)).toEqual(["docker stop worker-old", "docker rm worker-old"]);
  });

  it("rebuilds the previous revision when the running image is unknown", () => {
    const deploy = fixture();
    const broken = commit(deploy.upstream, "broken");
    const result = deploy.run({ FAIL_BUILD: "broken", PREVIOUS_IMAGE: "" });
    expect(result.status).toBe(1);
    expect(deploy.head()).toBe(deploy.first);
    expect(
      rollout(deploy.commands()).filter((line) => line.startsWith(`${COMPOSE} build`)),
    ).toEqual([
      `${COMPOSE} build --build-arg GIT_SHA=${broken}`,
      `${COMPOSE} build --build-arg GIT_SHA=${deploy.first}`,
    ]);
  });

  describe("with published images", () => {
    const REGISTRY = "registry.example.test/rakazo/app";
    const published = (revision: string) => `${REGISTRY}:sha-${revision}`;
    const commandsOf = (deploy: ReturnType<typeof fixture>) =>
      deploy.commands().map((line) => line.split(" @ ")[0]!);

    it("pulls the image published for the commit instead of building", () => {
      const deploy = fixture();
      const next = commit(deploy.upstream, "next");
      const result = deploy.run({ RAKAZO_DEPLOY_IMAGE: REGISTRY });
      expect(result.status).toBe(0);
      expect(deploy.deployed()).toBe(next);
      const commands = commandsOf(deploy);
      expect(commands.some((line) => line.startsWith(`${COMPOSE} build`))).toBe(false);
      const pull = commands.indexOf(`docker pull --quiet ${published(next)}`);
      expect(pull).toBeGreaterThan(-1);
      // Tagged as the image Compose runs, and the sha- tag dropped so they cannot pile up.
      expect(commands.slice(pull + 1, pull + 3)).toEqual([
        `docker tag ${published(next)} ${APP_IMAGE}`,
        `docker rmi ${published(next)}`,
      ]);
      const up = commands.indexOf(`${COMPOSE} up -d --no-deps --remove-orphans api`);
      expect(up).toBeGreaterThan(pull);
      expect(commands.slice(up + 1)).toEqual([
        "curl https://app.example.test/health",
        "docker image ls --format {{.Repository}}:{{.Tag}} rakazo-rollback",
        "docker rmi rakazo-rollback:old",
        "docker tag sha256:running rakazo-rollback:running",
        "docker image prune --force",
        "docker builder prune --force --keep-storage 8GB",
        ...finishDraining,
      ]);
    });

    it("uses the GHCR image of the GitHub repository the checkout tracks by default", () => {
      const deploy = fixture();
      const next = commit(deploy.upstream, "next");
      const github = "https://github.com/Example/Rakazo.git";
      git(deploy.checkout, "remote", "set-url", "origin", github);
      // The deploy runs with HOME set to the fixture root, so fetches still reach the local upstream.
      write(
        path.join(path.dirname(deploy.checkout), ".gitconfig"),
        `[url "${deploy.upstream}"]\n\tinsteadOf = ${github}\n`,
      );
      expect(deploy.run().status).toBe(0);
      expect(commandsOf(deploy)).toContain(
        `docker pull --quiet ghcr.io/example/rakazo/app:sha-${next}`,
      );
    });

    it("builds on the host, loudly, when the image cannot be pulled", () => {
      const deploy = fixture();
      const next = commit(deploy.upstream, "next");
      const result = deploy.run({ RAKAZO_DEPLOY_IMAGE: REGISTRY, FAIL_PULL: "1" });
      expect(result.status).toBe(0);
      expect(result.stderr).toContain(`::warning::Could not pull ${published(next)}`);
      expect(deploy.deployed()).toBe(next);
      const commands = commandsOf(deploy);
      expect(commands).toContain(`${COMPOSE} build --build-arg GIT_SHA=${next}`);
      expect(commands).not.toContain(`docker tag ${published(next)} ${APP_IMAGE}`);
    });

    it("rolls back by retagging the previous image when production never becomes healthy", () => {
      const deploy = fixture();
      commit(deploy.upstream, "unhealthy");
      const result = deploy.run({ RAKAZO_DEPLOY_IMAGE: REGISTRY, FAIL_HEALTH: "1" });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("did not recover");
      expect(deploy.head()).toBe(deploy.first);
      const commands = commandsOf(deploy);
      expect(commands.filter((line) => line.startsWith("docker pull"))).toHaveLength(1);
      expect(commands).toContain(`docker tag sha256:previous ${APP_IMAGE}`);
    });

    it("pulls the previous commit image to roll back when the running image is unknown", () => {
      const deploy = fixture();
      const next = commit(deploy.upstream, "unhealthy");
      const result = deploy.run({
        RAKAZO_DEPLOY_IMAGE: REGISTRY,
        FAIL_HEALTH: "1",
        PREVIOUS_IMAGE: "",
      });
      expect(result.status).toBe(1);
      const commands = commandsOf(deploy);
      expect(commands.filter((line) => line.startsWith("docker pull"))).toEqual([
        `docker pull --quiet ${published(next)}`,
        `docker pull --quiet ${published(deploy.first)}`,
      ]);
      expect(commands.some((line) => line.startsWith(`${COMPOSE} build`))).toBe(false);
    });
  });

  it("starts the first containers directly when none are running", () => {
    const deploy = fixture();
    commit(deploy.upstream, "next");
    expect(deploy.run({ FRESH: "1" }).status).toBe(0);
    const commands = rollout(deploy.commands());
    expect(commands).toContain(`${COMPOSE} up -d --no-deps --wait api`);
    expect(commands).toContain(`${COMPOSE} up -d --no-deps --wait web`);
    expect(commands).toContain(`${COMPOSE} up -d --no-deps --wait worker`);
    expect(
      commands.filter((line) => line.includes(" run --rm -T -e RAKAZO_DEPLOYED_MIGRATIONS=")),
    ).toHaveLength(1);
    expect(commands.some((line) => line.includes("--scale"))).toBe(false);
  });

  it("uses only successful release migrations after rollback, retry and a later release", () => {
    const deploy = fixture();
    const migrations = "packages/db/prisma/migrations";
    write(path.join(deploy.upstream, migrations, "001_add", "migration.sql"), "SELECT 1;\n");
    git(deploy.upstream, "add", migrations);
    commit(deploy.upstream, "release-a");
    expect(deploy.run().status).toBe(0);

    write(
      path.join(deploy.upstream, migrations, "002_drop", "migration.sql"),
      "-- deferred\nSELECT 1;\n",
    );
    git(deploy.upstream, "add", migrations);
    commit(deploy.upstream, "release-b");
    let start = deploy.commands().length;
    expect(deploy.run({ FAIL_HEALTH: "1" }).status).toBe(1);
    const migrationCommands = () =>
      deploy
        .commands()
        .slice(start)
        .filter((line) => line.includes(" run --rm -T -e "));
    // Both the failed rollout and its rollback retain the last healthy release's eligibility.
    expect(migrationCommands()).toHaveLength(2);
    for (const line of migrationCommands()) {
      expect(line).toContain("RAKAZO_DEPLOYED_MIGRATIONS=001_add migrate");
    }
    start = deploy.commands().length;
    expect(deploy.run({ FAIL_HEALTH: "1" }).status).toBe(1);
    for (const line of migrationCommands()) {
      expect(line).toContain("RAKAZO_DEPLOYED_MIGRATIONS=001_add migrate");
    }
    commit(deploy.upstream, "release-c");
    start = deploy.commands().length;
    expect(deploy.run().status).toBe(0);
    expect(migrationCommands()[0]).toContain("RAKAZO_DEPLOYED_MIGRATIONS=001_add migrate");

    commit(deploy.upstream, "release-d");
    start = deploy.commands().length;
    expect(deploy.run().status).toBe(0);
    expect(migrationCommands()[0]).toContain("RAKAZO_DEPLOYED_MIGRATIONS=001_add,002_drop migrate");
  });

  it("starts no new container and keeps the old one serving when migrations fail", () => {
    const deploy = fixture();
    commit(deploy.upstream, "next");
    expect(deploy.run({ FAIL_MIGRATE: "1" }).status).toBe(1);
    const commands = rollout(deploy.commands());
    expect(commands).toContain(`${COMPOSE} run --rm -T -e RAKAZO_DEPLOYED_MIGRATIONS= migrate`);
    expect(commands.some((line) => line.includes(" up "))).toBe(false);
    expect(commands.some((line) => line.startsWith("docker stop"))).toBe(false);
    expect(deploy.head()).toBe(deploy.first);
  });

  it("rolls back to a release whose API still migrates on start", () => {
    const deploy = fixture();
    commit(deploy.upstream, "unhealthy");
    const result = deploy.run({ FAIL_HEALTH: "1", NO_MIGRATE_REVISION: "first" });
    expect(result.status).toBe(1);
    expect(deploy.head()).toBe(deploy.first);
    const commands = rollout(deploy.commands());
    expect(
      commands.filter((line) => line.includes(" run --rm -T -e RAKAZO_DEPLOYED_MIGRATIONS=")),
    ).toHaveLength(1);
    expect(commands).toContain(`${COMPOSE} up -d --wait postgres`);
    // The rollback still replaces the failed release's containers.
    expect(commands.filter((line) => line.startsWith("docker stop --time 30 api-"))).toEqual([
      "docker stop --time 30 api-old",
      "docker stop --time 30 api-new",
    ]);
    // The failed release's worker stops claiming jobs, and the restored one starts once it and
    // the worker the deploy replaced have both exited.
    const failed = commands.indexOf("docker kill --signal SIGTERM worker-new");
    expect(failed).toBeGreaterThan(commands.indexOf("docker kill --signal SIGTERM worker-old"));
    expect(
      commands
        .slice(failed)
        .filter((line) => /^docker (stop|rm) |up -d --no-deps --wait worker$/.test(line)),
    ).toEqual([
      "docker stop worker-old worker-new",
      "docker rm worker-old worker-new",
      `${COMPOSE} up -d --no-deps --wait worker`,
    ]);
  });

  it("waits for a worker an earlier deploy left draining before migrating", () => {
    const deploy = fixture();
    commit(deploy.upstream, "next");
    expect(deploy.run({ EXTRA_WORKER: "running" }).status).toBe(0);
    const commands = rollout(deploy.commands());
    const migrate = commands.indexOf(
      `${COMPOSE} run --rm -T -e RAKAZO_DEPLOYED_MIGRATIONS= migrate`,
    );
    expect(commands.slice(migrate - 4, migrate)).toEqual([
      `${WORKERS} worker-old worker-older`,
      "docker stop worker-older",
      "docker rm worker-older",
      `${COMPOSE} config --services`,
    ]);
  });

  it("never scales up beside a worker that may have exited while a rollback drains it", () => {
    const deploy = fixture();
    commit(deploy.upstream, "unhealthy");
    expect(deploy.run({ FAIL_HEALTH: "1", DRAIN_EXITS: "1" }).status).toBe(1);
    const commands = rollout(deploy.commands());
    const replaced = commands.indexOf("docker kill --signal SIGTERM worker-old");
    const removed = commands.indexOf("docker rm worker-old worker-new");
    expect(removed).toBeGreaterThan(replaced);
    expect(commands.slice(replaced).some((line) => line.includes("--scale worker"))).toBe(false);
    expect(commands.slice(removed)).toContain(`${COMPOSE} up -d --no-deps --wait worker`);
  });

  it("starts the configured number of API and worker containers beside the old ones", () => {
    const deploy = fixture();
    write(
      path.join(deploy.checkout, ".env"),
      "RAKAZO_HOST=app.example.test\nRAKAZO_API_REPLICAS=2\nRAKAZO_WORKER_REPLICAS=3\n",
    );
    commit(deploy.upstream, "next");
    expect(deploy.run().status).toBe(0);
    const commands = rollout(deploy.commands());
    const health = (name: string) =>
      `docker inspect --format {{.State.Status}}{{if .State.Health}} {{.State.Health.Status}}{{end}} ${name}`;
    const apiStarted = commands.indexOf(
      `${COMPOSE} up -d --no-deps --no-recreate --scale api=3 api`,
    );
    expect(commands.slice(apiStarted + 2, apiStarted + 5)).toEqual([
      health("api-new"),
      health("api-newx"),
      "docker stop --time 30 api-old",
    ]);
    expect(commands).toContain(`${COMPOSE} up -d --no-deps --no-recreate --scale web=2 web`);
    const workerStarted = commands.indexOf(
      `${COMPOSE} up -d --no-deps --no-recreate --scale worker=4 worker`,
    );
    expect(commands.slice(workerStarted + 2, workerStarted + 6)).toEqual([
      health("worker-new"),
      health("worker-newx"),
      health("worker-newxx"),
      "docker update --restart no worker-old",
    ]);
  });

  it("refuses a replica count below one before deploying", () => {
    const deploy = fixture();
    write(
      path.join(deploy.checkout, ".env"),
      "RAKAZO_HOST=app.example.test\nRAKAZO_API_REPLICAS=0\n",
    );
    commit(deploy.upstream, "next");
    const result = deploy.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must be whole numbers of at least 1");
    expect(deploy.commands().some((line) => line.includes(" up "))).toBe(false);
  });

  it("keeps the old container serving when the new one fails its health check", () => {
    const deploy = fixture();
    commit(deploy.upstream, "unhealthy");
    const result = deploy.run({ CONTAINER_HEALTH: "running unhealthy" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("did not become healthy");
    const commands = rollout(deploy.commands());
    expect(commands).toContain("docker rm --force api-new");
    expect(commands).not.toContain("docker stop --time 30 api-old");
    expect(deploy.head()).toBe(deploy.first);
  });

  it("accepts a running container whose revision has no health check", () => {
    const deploy = fixture();
    commit(deploy.upstream, "next");
    expect(deploy.run({ CONTAINER_HEALTH: "running" }).status).toBe(0);
    expect(rollout(deploy.commands())).toContain("docker stop --time 30 web-old");
  });

  it("removes a replacement that exits before it is ready", () => {
    const deploy = fixture();
    commit(deploy.upstream, "next");
    const result = deploy.run({ CONTAINER_HEALTH: "exited healthy" });
    expect(result.status).toBe(1);
    expect(rollout(deploy.commands())).toContain("docker rm --force api-new");
  });

  it("recreates Caddy when its config changed", () => {
    const deploy = fixture();
    write(path.join(deploy.upstream, "infra/compose/Caddyfile.prod"), ":80\n");
    git(deploy.upstream, "add", "infra/compose/Caddyfile.prod");
    commit(deploy.upstream, "caddy");
    expect(deploy.run().status).toBe(0);
    expect(deploy.commands()).toContainEqual(
      expect.stringContaining(`${COMPOSE} up -d --no-deps --force-recreate caddy`),
    );
  });
});

describe("production deploy launcher", () => {
  const launcher = path.join(repoRoot, "infra/compose/deploy-launcher.sh");
  let root: string;
  let checkout: string;
  let tested: string;
  let later: string;

  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "rakazo-launcher-"));
    const upstream = path.join(root, "upstream");
    checkout = path.join(root, "checkout with spaces");
    const script = path.join("infra", "compose", "deploy-main.sh");
    mkdirSync(upstream);
    git(upstream, "init", "-q", "-b", "main");
    write(path.join(upstream, script), 'echo "stale $*"\n');
    git(upstream, "add", script);
    commit(upstream, "first");
    git(root, "clone", "-q", upstream, checkout);
    write(path.join(upstream, script), 'echo "deploy $RAKAZO_DEPLOY_REVISION $0 $*"\n');
    git(upstream, "add", script);
    tested = commit(upstream, "tested");
    later = commit(upstream, "merged after the green run");
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  function launch(command?: string, ...args: string[]) {
    return spawnSync("/bin/bash", [launcher, ...args], {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        HOME: root,
        RAKAZO_DEPLOY_DIR: checkout,
        ...(command === undefined ? {} : { SSH_ORIGINAL_COMMAND: command }),
      },
      encoding: "utf8",
      timeout: 20_000,
    });
  }

  it("runs the deploy script from origin/main, not the checkout", () => {
    const result = launch(undefined, "--flag");
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(`deploy ${later} rakazo-deploy-main --flag`);
  });

  it("deploys the commit CI tested, not a newer main", () => {
    const result = launch(`deploy-main ${tested}`);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(`deploy ${tested} rakazo-deploy-main`);
  });

  it("does not roll back to an older commit than production runs", () => {
    const recorded = path.join(checkout, ".last-deployed-revision");
    write(recorded, `${later}\n`);
    try {
      const result = launch(`deploy-main ${tested}`);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("nothing to deploy");
      expect(result.stdout).not.toContain("deploy ");
    } finally {
      rmSync(recorded);
    }
  });

  it("refuses a commit that is not on main or not a full SHA", () => {
    const offMain = launch(`deploy-main ${"a".repeat(40)}`);
    expect(offMain.status).toBe(1);
    expect(offMain.stderr).toContain("not on main");
    const short = launch("deploy-main main");
    expect(short.status).toBe(1);
    expect(short.stderr).toContain("full commit SHA");
  });

  it("refuses a relative checkout path", () => {
    const result = spawnSync("/bin/bash", [launcher], {
      env: { PATH: process.env.PATH, RAKAZO_DEPLOY_DIR: "relative" },
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("absolute path");
  });
});
