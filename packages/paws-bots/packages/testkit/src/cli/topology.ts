import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import type { RunsListOutput, ThreadSnapshot } from "@rakazo/contracts";
import { isTerminal } from "@rakazo/core";
import { computerNetworkNameFor } from "@rakazo/sandbox-supervisor/computer-spec";

const composeFile = path.resolve("infra/compose/docker-compose.topology.yml");
const keep = process.argv.includes("--keep");
const skipBuild = process.argv.includes("--skip-build");
const project = `rakazo-topology-${process.pid}-${Date.now().toString(36)}`;

async function main() {
  docker(["info", "--format", "{{.ServerVersion}}"]);
  const port = Number(process.env.TOPOLOGY_API_PORT ?? (await freePort()));
  const baseUrl = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    TOPOLOGY_API_PORT: String(port),
    TOPOLOGY_APP_IMAGE: process.env.TOPOLOGY_APP_IMAGE ?? "rakazo/app:topology",
    TOPOLOGY_COMPUTER_IMAGE: process.env.TOPOLOGY_COMPUTER_IMAGE ?? "rakazo/computer:topology",
  };
  const compose = (args: string[], capture = false) =>
    command(
      "docker",
      ["compose", "--project-name", project, "--file", composeFile, ...args],
      env,
      capture,
    );
  let cookie: string | undefined;
  let botId: string | undefined;

  try {
    compose([
      "up",
      ...(skipBuild ? [] : ["--build"]),
      "--detach",
      "postgres",
      "computer-image",
      "supervisor",
      "api",
      "web",
      "worker",
    ]);
    await waitForHealth(baseUrl, 120_000);
    await waitForWorker(compose, 60_000);
    await waitForComposeHealth(compose, "web", 60_000);

    compose(["stop", "worker"]);
    cookie = await signup(baseUrl);
    const bot = await rpc<{ id: string }>(baseUrl, cookie, "bots/create", {
      name: "Topology",
      title: "Topology smoke bot",
      description: "Exercises the production-shaped test topology",
      instructions: "Use the file tool when asked to write a file.",
      notifyOnFinish: false,
    });
    botId = bot.id;
    const sent = await rpc<{ runId: string }>(baseUrl, cookie, "threads/send", {
      botId: bot.id,
      text: "write a file in your home called notes/result.txt that says topology-recovery-ok",
    });
    const queued = await rpc<ThreadSnapshot>(baseUrl, cookie, "threads/get", { botId: bot.id });
    if (queued.run?.id !== sent.runId || queued.run.status !== "queued") {
      throw new Error(
        `run was not left queued while worker was stopped: ${JSON.stringify(queued.run)}`,
      );
    }

    compose(["start", "worker"]);
    const completed = await waitForRun(baseUrl, cookie, bot.id, sent.runId, 90_000);
    if (completed.runId !== sent.runId || completed.status !== "completed") {
      throw new Error(`worker did not complete queued run: ${JSON.stringify(completed)}`);
    }
    const file = await rpc<{ content: string }>(baseUrl, cookie, "computer/readFile", {
      botId: bot.id,
      path: "notes/result.txt",
    });
    if (file.content !== "topology-recovery-ok\n") {
      throw new Error(`unexpected sandbox file content: ${JSON.stringify(file.content)}`);
    }
    const computer = await rpc<{ state: string }>(baseUrl, cookie, "computer/status", {
      botId: bot.id,
    });
    if (computer.state !== "running") {
      throw new Error(`Docker computer did not remain running: ${JSON.stringify(computer)}`);
    }
    // File-only runs leave desktops unopened. Request the actual screen before
    // checking the supervisor/web peers that the screen connection attaches.
    const screen = await rpc<{ url: string | null }>(baseUrl, cookie, "computer/screenUrl", {
      botId: bot.id,
    });
    if (!screen.url) throw new Error("Docker computer did not expose a screen");
    assertComputerNetworkIsolation(compose, project);
    await rpc(baseUrl, cookie, "bots/remove", { botId: bot.id });
    botId = undefined;

    console.log(
      JSON.stringify(
        {
          ok: true,
          topology: [
            "postgres",
            "api",
            "web-proxy",
            "graphile-worker",
            "supervisor",
            "docker-computer",
          ],
          recovery: "queued while worker stopped, completed after worker restart",
          runId: sent.runId,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    console.error("\nTopology logs:\n");
    try {
      console.error(compose(["logs", "--no-color", "--tail", "250"], true));
    } catch {
      // Preserve the original failure if log collection also fails.
    }
    throw error;
  } finally {
    if (keep) {
      console.log(
        `Topology kept running. Clean up with: docker compose -p ${project} -f ${composeFile} down -v`,
      );
    } else {
      if (cookie && botId) {
        await rpc(baseUrl, cookie, "bots/remove", { botId }).catch(() => undefined);
      }
      removeManagedComputers(compose, project);
      try {
        compose(["down", "--volumes", "--remove-orphans"]);
      } catch (error) {
        console.error(`topology cleanup failed: ${error instanceof Error ? error.message : error}`);
      }
    }
  }
}

async function signup(baseUrl: string) {
  const response = await fetch(`${baseUrl}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseUrl },
    body: JSON.stringify({
      email: `topology-${Date.now()}@rakazo.test`,
      password: "password12",
      name: "Topology",
    }),
  });
  if (!response.ok) throw new Error(`signup failed ${response.status}: ${await response.text()}`);
  const cookies = response.headers.getSetCookie?.() ?? [];
  const cookie = cookies.length
    ? cookies.map((value) => value.split(";")[0]).join("; ")
    : response.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("signup response did not include a session cookie");
  return cookie;
}

async function rpc<T>(baseUrl: string, cookie: string, procedure: string, input: unknown = {}) {
  const response = await fetch(`${baseUrl}/rpc/${procedure}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin: baseUrl },
    body: JSON.stringify({ json: input }),
  });
  const text = await response.text();
  const parsed = JSON.parse(text) as { json?: T; error?: { message?: string } };
  if (!response.ok || parsed.error) {
    throw new Error(`${procedure} failed ${response.status}: ${parsed.error?.message ?? text}`);
  }
  return parsed.json as T;
}

async function waitForRun(
  baseUrl: string,
  cookie: string,
  botId: string,
  runId: string,
  timeoutMs: number,
) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    // Thread snapshots intentionally omit completed runs. Inspect persisted run
    // history so a reply from another run cannot stand in for this completion.
    const recent = await rpc<RunsListOutput>(baseUrl, cookie, "runs/list", { filter: "recent" });
    const run = recent.runs.find((run) => run.runId === runId && run.botId === botId);
    if (run && isTerminal(run.status)) return run;
    await delay(300);
  }
  throw new Error(`timed out waiting for run ${runId}`);
}

async function waitForHealth(baseUrl: string, timeoutMs: number) {
  const started = Date.now();
  let last = "";
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/internal/health`);
      const body = (await response.json()) as Record<string, unknown>;
      if (
        response.ok &&
        body.jobs === "graphile" &&
        body.runtime === "scripted" &&
        body.sandbox === "docker"
      ) {
        return;
      }
      last = JSON.stringify(body);
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await delay(500);
  }
  throw new Error(`topology API did not become healthy: ${last}`);
}

async function waitForWorker(
  compose: (args: string[], capture?: boolean) => string,
  timeoutMs: number,
) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const logs = compose(["logs", "--no-color", "--tail", "100", "worker"], true);
    // The worker logs readiness as a structured JSON record; match its message field alone so
    // the sink's key order does not matter.
    if (logs.includes('"message":"worker ready"')) return;
    await delay(500);
  }
  throw new Error("Graphile worker did not become ready");
}

async function waitForComposeHealth(
  compose: (args: string[], capture?: boolean) => string,
  service: string,
  timeoutMs: number,
) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const containerId = compose(["ps", "--quiet", service], true).trim();
    if (containerId) {
      const status = docker([
        "inspect",
        containerId,
        "--format",
        "{{.State.Health.Status}}",
      ]).trim();
      if (status === "healthy") return;
      if (status === "unhealthy") throw new Error(`${service} became unhealthy`);
    }
    await delay(500);
  }
  throw new Error(`${service} did not become healthy`);
}

function docker(args: string[]) {
  return command("docker", args, process.env, true);
}

function assertComputerNetworkIsolation(
  compose: (args: string[], capture?: boolean) => string,
  projectName: string,
) {
  const supervisorId = compose(["ps", "--quiet", "supervisor"], true).trim();
  const webId = compose(["ps", "--quiet", "web"], true).trim();
  const networkNames = isolatedSupervisorNetworks(supervisorId, projectName);
  if (networkNames.length !== 1) {
    throw new Error(`expected one isolated computer network: ${JSON.stringify(networkNames)}`);
  }
  const peers = JSON.parse(
    docker(["network", "inspect", networkNames[0]!, "--format", "{{json .Containers}}"]),
  ) as Record<string, { Name?: string }>;
  const computerIds = Object.keys(peers).filter(
    (containerId) => containerId !== supervisorId && containerId !== webId,
  );
  if (computerIds.length !== 1) {
    throw new Error(`expected one computer peer: ${JSON.stringify(Object.values(peers))}`);
  }
  const computerId = computerIds[0]!;
  const managed = docker([
    "inspect",
    computerId,
    "--format",
    '{{index .Config.Labels "rakazo.managed"}}',
  ]).trim();
  if (managed !== "true") throw new Error("isolated peer is not a managed computer");
  const [spec] = JSON.parse(docker(["inspect", computerId])) as Array<{
    Config?: { User?: string };
    HostConfig?: { CapDrop?: string[]; SecurityOpt?: string[]; PidsLimit?: number };
  }>;
  if (
    spec?.Config?.User !== "1000:1000" ||
    !spec.HostConfig?.CapDrop?.includes("ALL") ||
    !spec.HostConfig.SecurityOpt?.some((option) => option.startsWith("no-new-privileges")) ||
    spec.HostConfig.PidsLimit !== 2048
  ) {
    throw new Error(`computer hardening is incomplete: ${JSON.stringify(spec)}`);
  }
  const expected = new Set([computerId, supervisorId, webId]);
  const actual = Object.keys(peers);
  if (actual.length !== expected.size || actual.some((containerId) => !expected.has(containerId))) {
    const peerNames = Object.values(peers).flatMap((peer) => (peer.Name ? [peer.Name] : []));
    throw new Error(`unexpected isolated screen peers: ${JSON.stringify(peerNames)}`);
  }
}

function isolatedSupervisorNetworks(supervisorId: string, projectName: string): string[] {
  if (!supervisorId) return [];
  const networks = JSON.parse(
    docker(["inspect", supervisorId, "--format", "{{json .NetworkSettings.Networks}}"]),
  ) as Record<string, unknown>;
  return Object.keys(networks).filter((name) => name !== `${projectName}_default`);
}

function removeManagedComputers(
  compose: (args: string[], capture?: boolean) => string,
  projectName: string,
) {
  try {
    const supervisorId = compose(["ps", "--quiet", "supervisor"], true).trim();
    const networks = new Set(isolatedSupervisorNetworks(supervisorId, projectName));
    // A failed run may provision a computer without ever opening its screen.
    // Such a network has no supervisor peer; discover it from this disposable
    // topology's own database, never from unrelated managed host computers.
    try {
      const homes = compose(
        [
          "exec",
          "-T",
          "postgres",
          "psql",
          "-U",
          "rakazo",
          "-d",
          "rakazo",
          "-Atc",
          'SELECT "homeKey" FROM computers',
        ],
        true,
      );
      for (const home of homes.split("\n").filter(Boolean)) {
        networks.add(computerNetworkNameFor(home));
      }
    } catch {
      // The database may not exist yet when Compose startup itself fails.
    }
    for (const networkName of networks) {
      const ids = docker([
        "ps",
        "--all",
        "--quiet",
        "--filter",
        `network=${networkName}`,
        "--filter",
        "label=rakazo.managed=true",
      ])
        .split("\n")
        .map((id) => id.trim())
        .filter(Boolean);
      if (ids.length) docker(["rm", "--force", ...ids]);
      const networkId = docker([
        "network",
        "ls",
        "--quiet",
        "--filter",
        `name=^${networkName}$`,
      ]).trim();
      if (!networkId) continue;
      const peers = JSON.parse(
        docker(["network", "inspect", networkId, "--format", "{{json .Containers}}"]),
      ) as Record<string, unknown>;
      for (const peerId of Object.keys(peers)) {
        const owner = docker([
          "inspect",
          peerId,
          "--format",
          '{{index .Config.Labels "com.docker.compose.project"}}',
        ]).trim();
        if (owner === projectName) docker(["network", "disconnect", networkId, peerId]);
      }
      docker(["network", "rm", networkId]);
    }
  } catch (error) {
    console.error(
      `managed computer cleanup failed: ${error instanceof Error ? error.message : error}`,
    );
  }
}

function command(commandName: string, args: string[], env: NodeJS.ProcessEnv, capture: boolean) {
  const result = spawnSync(commandName, args, {
    env,
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
  });
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(
      `${commandName} ${args.join(" ")} exited ${result.status}${detail ? `\n${detail}` : ""}`,
    );
  }
  return result.stdout ?? "";
}

function freePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("could not allocate a topology port"));
        return;
      }
      const { port } = address;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
