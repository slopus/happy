import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DEFAULT_DESKTOP_ENV,
  ensureScreenCommand,
  TERMINAL_MENU_COMMAND,
} from "@rakazo/core/node/desktop-runtime";
import type Docker from "dockerode";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertVolumeSubpathSupport,
  COMPUTER_IMAGE,
  COMPUTER_IMAGE_CONTEXT_FILES,
  computerBridgeNameFor,
  computerDnsMatches,
  computerHomeStorage,
  computerMountsMatch,
  computerNetworkCreateOptions,
  computerNetworkNameFor,
  computerNetworkNamesForCleanup,
  computerNetworkOwnerFor,
  containerCreateOptions,
  containerNameFor,
  controlPortPublicationMatches,
  homeVolumeMatches,
  hostComputerUser,
  isIpv6NetworkUnavailable,
  isRegistryQualifiedImage,
  legacyNetworkOwnedSolelyBy,
  parseMemoryBytes,
  publishedLoopbackControlHostPort,
  resolveComputerControlEndpoint,
  resolveComputerDns,
  resolveComputerEgressMode,
  resolveComputerImage,
  resolveComputerMounts,
  resolveScreenNetworkMode,
  resolveScreenPublishTarget,
  resolveSpaceComputerLimit,
  resolveTeamScreenLimit,
  screenPeerNetworkConnectOptions,
  screenPorts,
  screenUrlFor,
  screenUrlWithToken,
  xdotoolCommand,
} from "./computer-spec.js";

describe("graphical computer spec", () => {
  it("binds the embed WebSocket path to the current screen capability", () => {
    const url = new URL(screenUrlWithToken("http://screen.test:6080/embed.html", "current-token"));
    expect(url.pathname).toBe("/embed.html");
    expect(url.searchParams.get("path")).toBe("websockify?token=current-token");
  });

  it("has no small default cap and accepts optional operator limits", () => {
    expect(resolveTeamScreenLimit(undefined)).toBeGreaterThan(1000);
    expect(resolveTeamScreenLimit("0")).toBe(resolveTeamScreenLimit(undefined));
    expect(resolveTeamScreenLimit("1000")).toBe(1000);
    expect(resolveTeamScreenLimit("4")).toBe(4);
    for (const value of ["-1", "1.5", "not-a-number"])
      expect(() => resolveTeamScreenLimit(value)).toThrow(/positive integer/);
  });

  it("resolves the computer image tag outside Compose", () => {
    // Explicit "" stands for unset, so exported RAKAZO_COMPUTER_IMAGE* values cannot leak in.
    expect(resolveComputerImage("", "")).toBe("rakazo/computer:local");
    expect(resolveComputerImage("", "edge")).toBe("rakazo/computer:local");
    expect(resolveComputerImage("ghcr.io/elie222/rakazo/computer", "edge")).toBe(
      "ghcr.io/elie222/rakazo/computer:edge",
    );
    expect(resolveComputerImage("ghcr.io/elie222/rakazo/computer", "")).toBe(
      "ghcr.io/elie222/rakazo/computer",
    );
    // Compose already appends the tag, so a tagged or pinned image is never tagged twice.
    expect(resolveComputerImage("ghcr.io/elie222/rakazo/computer:edge", "edge")).toBe(
      "ghcr.io/elie222/rakazo/computer:edge",
    );
    expect(resolveComputerImage("registry.example.com:5000/rakazo/computer", "v1.2.3")).toBe(
      "registry.example.com:5000/rakazo/computer:v1.2.3",
    );
    expect(resolveComputerImage("rakazo/computer@sha256:abc", "edge")).toBe(
      "rakazo/computer@sha256:abc",
    );
  });

  it("validates space computer limit", () => {
    expect(resolveSpaceComputerLimit(undefined)).toBe(0);
    expect(resolveSpaceComputerLimit("")).toBe(0);
    expect(resolveSpaceComputerLimit("0")).toBe(0);
    expect(resolveSpaceComputerLimit("unlimited")).toBe(0);
    expect(resolveSpaceComputerLimit("none")).toBe(0);
    expect(resolveSpaceComputerLimit("10")).toBe(10);
    expect(resolveSpaceComputerLimit("1")).toBe(1);
    for (const value of ["-1", "1.5", "not-a-number"])
      expect(() => resolveSpaceComputerLimit(value)).toThrow(/positive integer/);
  });

  it("creates a VNC desktop, not an alpine sleep fallback", () => {
    const options = containerCreateOptions({
      name: "rakazo-bot-abc",
      image: COMPUTER_IMAGE,
      botId: "abc",
      spaceId: "ws",
      homePath: "/var/rakazo/homes/abc",
      networkMode: "rakazo_default",
    });
    expect(options.Image).toBe("rakazo/computer:local");
    expect(options.Image).not.toMatch(/alpine/);
    expect(options).not.toHaveProperty("Entrypoint");
    expect(JSON.stringify(options)).not.toMatch(/sleep/);
    expect(options.HostConfig.Binds).toEqual(["/var/rakazo/homes/abc:/home/rakazo"]);
    expect(options.Env).toContain(
      "PATH=/home/rakazo/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    );
    expect(options.Env).toContain("NPM_CONFIG_PREFIX=/home/rakazo/.local");
    expect(options.Env?.join("\n")).not.toMatch(/AXIOM_|LOG_LEVEL|LOG_FORMAT/);
    expect(options.ExposedPorts).toEqual({ "6080/tcp": {} });
    // Browser debugging stays inside the computer trust boundary.
    for (let index = 0; index < 1000; index += 1) {
      const cdpPort = `${screenPorts(index).debugPort}/tcp`;
      expect(options.ExposedPorts).not.toHaveProperty(cdpPort);
      expect(options.HostConfig.PortBindings).not.toHaveProperty(cdpPort);
    }
    expect(options.ExposedPorts).not.toHaveProperty("7070/tcp");
    expect(options.HostConfig.PortBindings).not.toHaveProperty("7070/tcp");
    expect(options.HostConfig.PortBindings["6080/tcp"]?.[0]?.HostIp).toBe("127.0.0.1");
    expect(options.HostConfig.PortBindings).not.toHaveProperty("6081/tcp");
    expect(options.HostConfig.PortBindings).not.toHaveProperty("6082/tcp");
    expect(screenPorts(0)).toMatchObject({ display: ":1", viewPort: "6080", controlPort: "6080" });
    expect(screenPorts(1)).toMatchObject({ display: ":2", viewPort: "6080", controlPort: "6080" });
    expect(options.HostConfig.ShmSize).toBeGreaterThanOrEqual(256 * 1024 * 1024);
    expect(options.User).toBe("1000:1000");
    expect(options.HostConfig.CapDrop).toEqual(["ALL"]);
    expect(options.HostConfig.SecurityOpt).toEqual(["no-new-privileges:true"]);
    expect(options.HostConfig.PidsLimit).toBe(2048);
    expect(options.HostConfig.ReadonlyPaths).toContain("/usr/share/novnc");
    expect(options.HostConfig.NetworkMode).toBe("rakazo_default");
  });

  it("still publishes host ports when NetworkMode is a per-bot isolated network", () => {
    const networkMode = computerNetworkNameFor("bot_isolation");
    const options = containerCreateOptions({
      name: containerNameFor("bot_isolation"),
      image: COMPUTER_IMAGE,
      botId: "bot_isolation",
      spaceId: "ws",
      homePath: "/var/rakazo/homes/bot_isolation",
      networkMode,
    });
    expect(networkMode).toMatch(/^rakazo-computer-bot_isolation-[0-9a-f]{32}$/);
    expect(options.HostConfig.NetworkMode).toBe(networkMode);
    expect(options.HostConfig.PortBindings["6080/tcp"]).toEqual([
      { HostIp: "127.0.0.1", HostPort: "0" },
    ]);
    expect(options.ExposedPorts["6080/tcp"]).toEqual({});
  });

  it("keeps sanitized network names unique when botIds only differ by stripped characters", () => {
    expect(computerNetworkNameFor("a/b")).not.toBe(computerNetworkNameFor("ab"));
    expect(computerNetworkNameFor("a/b")).toBe(computerNetworkNameFor("a/b"));
  });

  it("parses the computer egress mode with an open default", () => {
    expect(resolveComputerEgressMode(undefined)).toBe("open");
    expect(resolveComputerEgressMode("")).toBe("open");
    expect(resolveComputerEgressMode("open")).toBe("open");
    expect(resolveComputerEgressMode("restricted")).toBe("restricted");
    expect(resolveComputerEgressMode("auto")).toBe("auto");
    for (const value of ["blocked", "RESTRICTED", "0"])
      expect(() => resolveComputerEgressMode(value)).toThrow(/SANDBOX_COMPUTER_EGRESS/);
  });

  it("parses computer DNS servers, with Docker's default when unset", () => {
    expect(resolveComputerDns(undefined)).toBeUndefined();
    expect(resolveComputerDns(" ")).toBeUndefined();
    expect(resolveComputerDns("1.1.1.1, 2606:4700:4700::1111")).toEqual([
      "1.1.1.1",
      "2606:4700:4700::1111",
    ]);
    for (const value of ["dns.example.com", "1.1.1.1,resolver", "300.1.1.1"])
      expect(() => resolveComputerDns(value)).toThrow(/SANDBOX_COMPUTER_DNS/);
  });

  it("sets DNS servers on computers only when configured", () => {
    const base = {
      name: "rakazo-bot-x",
      image: "img",
      botId: "x",
      spaceId: "s",
      homePath: "/data/x",
    };
    expect(containerCreateOptions(base).HostConfig).not.toHaveProperty("Dns");
    expect(containerCreateOptions({ ...base, dns: ["1.1.1.1"] }).HostConfig).toMatchObject({
      Dns: ["1.1.1.1"],
    });
  });

  it("parses computer host mounts, with none when unset", () => {
    expect(resolveComputerMounts(undefined)).toEqual([]);
    expect(resolveComputerMounts(" , ")).toEqual([]);
    expect(
      resolveComputerMounts("/srv/docs:/mnt/docs:ro, /srv/shares/:/media/shares:rw:rslave"),
    ).toEqual([
      { source: "/srv/docs", target: "/mnt/docs", readOnly: true },
      { source: "/srv/shares", target: "/media/shares", readOnly: false, propagation: "rslave" },
    ]);
    for (const value of [
      "/srv/docs",
      "srv/docs:/mnt/docs",
      "/srv/docs:mnt/docs",
      "/:/mnt/host",
      "/srv/docs:/home/rakazo/docs",
      "/srv/docs:/mnt",
      "/srv/docs:/usr/local/bin",
      "/srv/docs:/mnt/../etc/docs",
      "/srv/docs:/mnt/docs:shared",
      "/srv/docs:/mnt/docs:ro:rw",
      "/srv/a:/mnt/docs,/srv/b:/mnt/docs/inner",
      "/srv/a:/mnt/docs,/srv/b:/mnt/docs",
    ])
      expect(() => resolveComputerMounts(value)).toThrow(/SANDBOX_COMPUTER_MOUNTS/);
  });

  it("adds host mounts beside either kind of home", () => {
    const base = {
      name: "rakazo-bot-x",
      image: "img",
      botId: "x",
      spaceId: "s",
      homePath: "/data/x",
    };
    const mounts = resolveComputerMounts(
      "/srv/docs:/mnt/docs:ro,/srv/shares:/mnt/shares:rw:rslave",
    );
    const expected = [
      { Type: "bind", Source: "/srv/docs", Target: "/mnt/docs", ReadOnly: true },
      {
        Type: "bind",
        Source: "/srv/shares",
        Target: "/mnt/shares",
        ReadOnly: false,
        BindOptions: { Propagation: "rslave" },
      },
    ];
    expect(containerCreateOptions(base).HostConfig.Mounts).toBeUndefined();
    const bound = containerCreateOptions({ ...base, mounts }).HostConfig;
    expect(bound.Binds).toEqual(["/data/x:/home/rakazo"]);
    expect(bound.Mounts).toEqual(expected);
    const volume = containerCreateOptions({
      ...base,
      homeVolume: { name: "appdata", subpath: "homes/x" },
      mounts,
    }).HostConfig;
    expect(volume.Mounts?.[0]).toMatchObject({ Type: "volume", Target: "/home/rakazo" });
    expect(volume.Mounts?.slice(1)).toEqual(expected);
  });

  it("matches a computer's host mounts to the configured ones", () => {
    const desired = resolveComputerMounts(
      "/srv/docs:/mnt/docs:ro,/srv/shares:/mnt/shares:rw:rslave",
    );
    const home = { Type: "bind", Source: "/data/x", Target: "/home/rakazo" };
    const docs = { Type: "bind", Source: "/srv/docs", Target: "/mnt/docs", ReadOnly: true };
    const shares = {
      Type: "bind",
      Source: "/srv/shares",
      Target: "/mnt/shares",
      ReadOnly: false,
      BindOptions: { Propagation: "rslave" },
    };
    // Labels as the computer was created with `created` mounts.
    const labels = (created: typeof desired) =>
      containerCreateOptions({
        name: "rakazo-bot-x",
        image: "img",
        botId: "x",
        spaceId: "s",
        homePath: "/data/x",
        mounts: created,
      }).Labels;
    const match = (mounts: unknown[] | undefined, want = desired, created = want) =>
      computerMountsMatch(
        {
          Config: { Labels: labels(created) },
          HostConfig: { Mounts: mounts },
        } as unknown as Parameters<typeof computerMountsMatch>[0],
        want,
      );
    expect(match(undefined, [])).toBe(true);
    expect(match([home], [])).toBe(true);
    expect(match([home, shares, docs])).toBe(true);
    // Docker Desktop stores its own VM path as the source of a bind beside a volume home.
    const rewritten = "/run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/Ubuntu/abc";
    expect(match([home, { ...docs, Source: rewritten }, shares])).toBe(true);
    // A computer created before a mount was added, or after one was removed, is replaced.
    expect(match([home, docs])).toBe(false);
    expect(match([home, docs, shares], desired.slice(0, 1))).toBe(false);
    // So is one whose mount changed source, access or propagation.
    const moved = resolveComputerMounts(
      "/srv/other:/mnt/docs:ro,/srv/shares:/mnt/shares:rw:rslave",
    );
    expect(match([home, docs, shares], desired, moved)).toBe(false);
    expect(match([home, { ...docs, ReadOnly: false }, shares])).toBe(false);
    expect(match([home, docs, { ...shares, BindOptions: undefined }])).toBe(false);
    // And one created before its sources were labeled, since its source cannot be read back.
    expect(match([home, docs, shares], desired, [])).toBe(false);
  });

  it("mounts read-only unless rw is explicit", () => {
    expect(resolveComputerMounts("/srv/docs:/mnt/docs")[0]?.readOnly).toBe(true);
    // Later mounts propagated by rslave keep their own write flags.
    for (const value of ["/srv/docs:/mnt/docs:rslave", "/srv/docs:/mnt/docs:ro:rslave"])
      expect(() => resolveComputerMounts(value)).toThrow(/rslave requires rw/);
    expect(resolveComputerMounts("/srv/docs:/mnt/docs:rw")[0]?.readOnly).toBe(false);
  });

  it("refuses host sources that expose the host, Docker or bot homes", () => {
    for (const source of [
      "/",
      "/var/run/docker.sock",
      "/run/docker.sock",
      "/var/run",
      "/run",
      "/run/user/1000",
      "/proc",
      "/sys/fs",
      "/dev",
      "/etc",
      "/etc/ssh",
      "/boot",
      "/root",
      "/var/lib/docker",
      "/var/lib/docker/volumes/appdata/_data",
      // Ancestors expose what they hold.
      "/var",
      "/var/lib",
      "//etc/",
    ])
      expect(() => resolveComputerMounts(`${source}:/mnt/x`)).toThrow(
        /SANDBOX_COMPUTER_MOUNTS source/,
      );
    for (const value of ["/srv/../etc:/mnt/x", "/srv/docs/..:/mnt/x", "/srv/docs:/mnt/a/../x"])
      expect(() => resolveComputerMounts(value)).toThrow(/must not contain \.\./);

    const protectedPaths = ["/opt/rakazo/data", "/home/op/.docker/run/docker.sock", undefined];
    for (const source of [
      "/opt/rakazo/data",
      "/opt/rakazo/data/homes/bot",
      "/opt/rakazo",
      "/home/op",
    ])
      expect(() => resolveComputerMounts(`${source}:/mnt/x`, protectedPaths)).toThrow(
        /protected host path/,
      );
    expect(
      resolveComputerMounts("/opt/shared:/mnt/x,/varnish:/mnt/y,/srv/run:/mnt/z", protectedPaths),
    ).toHaveLength(3);
  });

  it("matches a computer's DNS servers to the configured ones", () => {
    expect(computerDnsMatches(null, undefined)).toBe(true);
    expect(computerDnsMatches([], undefined)).toBe(true);
    expect(computerDnsMatches(["1.1.1.1"], ["1.1.1.1"])).toBe(true);
    expect(computerDnsMatches(null, ["1.1.1.1"])).toBe(false);
    expect(computerDnsMatches(["1.1.1.1"], undefined)).toBe(false);
    expect(computerDnsMatches(["1.0.0.1", "1.1.1.1"], ["1.1.1.1", "1.0.0.1"])).toBe(false);
  });

  it("derives deterministic host bridge names within the 15-byte interface limit", () => {
    for (const botId of ["bot", "a/b", "bot with spaces", "x".repeat(80)]) {
      const name = computerBridgeNameFor(botId);
      expect(name).toMatch(/^rakazo-c[0-9a-f]{7}$/);
      expect(Buffer.byteLength(name)).toBeLessThanOrEqual(15);
      expect(computerBridgeNameFor(botId)).toBe(name);
    }
    expect(computerBridgeNameFor("a/b")).not.toBe(computerBridgeNameFor("ab"));
  });

  it("names the bridge only when egress is restricted", () => {
    const open = computerNetworkCreateOptions("bot_1", "owner", "open");
    expect(open).toEqual({
      Name: computerNetworkNameFor("bot_1"),
      Driver: "bridge",
      CheckDuplicate: true,
      EnableIPv6: true,
      Labels: { "rakazo.computerOwner": "owner", "rakazo.botId": "bot_1" },
    });
    expect(open).not.toHaveProperty("Options");

    const restricted = computerNetworkCreateOptions("bot_1", "owner", "restricted");
    expect(restricted.Options).toEqual({
      "com.docker.network.bridge.name": computerBridgeNameFor("bot_1"),
    });
    expect(computerNetworkCreateOptions("bot_1", "owner")).toEqual(open);
    // The bridge name differs from the network name so `docker network` output
    // still shows the readable rakazo-computer-* name while iptables matches the interface.
    expect(restricted.Options?.["com.docker.network.bridge.name"]).not.toBe(restricted.Name);
  });

  it("enables IPv6 with automatic subnets and can leave it out for daemons without it", () => {
    // No IPAM config: the daemon allocates its own IPv6 ULA /64 (Docker 27+),
    // unique per network, which keeps the payload daemon-agnostic.
    expect(computerNetworkCreateOptions("bot_1", "owner", "open")).not.toHaveProperty("IPAM");

    // The IPv4-only payload for daemons that refuse the dual-stack network
    // (Docker 26, Docker-in-Docker without ip6_tables, IPv6 off in the kernel).
    expect(computerNetworkCreateOptions("bot_1", "owner", "open", false)).not.toHaveProperty(
      "EnableIPv6",
    );
  });

  it("keeps restricted networks IPv4-only with their named bridge", () => {
    // Restricted egress is enforced and startup-verified for IPv4 only
    // (infra/compose/restrict-computer-egress.sh, egress-probe.ts); IPv6 would
    // leave a restricted computer paths the ruleset does not cover.
    const restricted = computerNetworkCreateOptions("bot_1", "owner", "restricted");
    expect(restricted).not.toHaveProperty("EnableIPv6");
    expect(restricted.Options).toEqual({
      "com.docker.network.bridge.name": computerBridgeNameFor("bot_1"),
    });
  });

  it("falls back for every IPv6 capability error the daemon wording uses", () => {
    // Transient failures without IPv6 in them must surface, so the next start
    // retries the dual-stack create.
    expect(isIpv6NetworkUnavailable(new Error("daemon busy"))).toBe(false);
    expect(isIpv6NetworkUnavailable(new Error("ETIMEDOUT"))).toBe(false);

    // The daemon's IPv6 capability errors across releases, all matched broadly
    // because the wording changes between releases.
    const unavailable = [
      // Engine 26, no IPv6 pool (libnetwork/ipam/allocator.go at v26.1.4).
      "could not find an available, non-overlapping IPv6 address pool among the defaults to assign to the network",
      // IPv6 off in the kernel (drivers/bridge/setup_ipv6_linux.go), wrapped by
      // the daemon ("failed to create network ...").
      "Error response from daemon: failed to create network rakazo-computer-bot_1: Cannot read IPv6 setup for bridge br-x: open /proc/sys/net/ipv6/conf/br-x/disable_ipv6: no such file or directory",
      "Unable to enable IPv6 addresses on bridge: ...",
      // ip6tables disabled in the daemon config (setup_ip_tables_linux.go at v26.1.4).
      "Cannot program chains, EnableIP6Tables is disabled",
      // Newer engines name ip6tables and forwarding directly.
      "ip6tables is missing",
      "ip6tables not found",
      "IPv6 global forwarding is disabled",
    ];
    for (const message of unavailable) {
      expect(isIpv6NetworkUnavailable(new Error(message)), message).toBe(true);
    }

    // A transient error that names ip6tables (fork pressure running the binary)
    // falls back too. That is bounded: a stop gives the network back and the
    // next start creates it again, retrying IPv6 (see reclaimComputerNetwork).
    expect(
      isIpv6NetworkUnavailable(
        new Error("fork/exec /usr/sbin/ip6tables: resource temporarily unavailable"),
      ),
    ).toBe(true);
  });

  it("lists prior network name variants for cleanup", () => {
    const names = computerNetworkNamesForCleanup("bot_1");
    expect(names[0]).toBe(computerNetworkNameFor("bot_1"));
    expect(names).toContain("rakazo-computer-bot_1");
    expect(names.some((name) => /-[0-9a-f]{8}$/.test(name))).toBe(true);
    expect(names.some((name) => /-[0-9a-f]{32}$/.test(name))).toBe(true);
  });

  it("skips legacy network removal when another bot is still attached", () => {
    expect(legacyNetworkOwnedSolelyBy("a/b", ["a/b", "a/b"])).toBe(true);
    expect(legacyNetworkOwnedSolelyBy("a/b", ["a/b", undefined])).toBe(false);
    expect(legacyNetworkOwnedSolelyBy("a/b", ["a/b", "ab"])).toBe(false);
    expect(legacyNetworkOwnedSolelyBy("ab", [undefined, undefined])).toBe(false);
  });

  it("builds the local image from files that exist in the computer context", () => {
    const root = path.resolve(import.meta.dirname, "../../computer");
    for (const file of COMPUTER_IMAGE_CONTEXT_FILES) {
      expect(existsSync(path.join(root, file)), file).toBe(true);
    }
  });

  it("sends every file the computer Dockerfile copies or adds when it builds the image locally", () => {
    const dockerfile = readFileSync(
      path.resolve(import.meta.dirname, "../../computer/Dockerfile"),
      "utf8",
    );
    const sources = dockerfile
      .replace(/\\[ \t]*\r?\n/g, " ")
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .filter(
        ([instruction, ...args]) =>
          ["COPY", "ADD"].includes(instruction?.toUpperCase() ?? "") &&
          !args.some((arg) => arg.startsWith("--from=")),
      )
      .flatMap(([, ...args]) => args.slice(0, -1).filter((arg) => !arg.startsWith("--")));
    const listed = new Set<string>(COMPUTER_IMAGE_CONTEXT_FILES);
    expect(sources.length).toBeGreaterThan(10);
    expect(sources.filter((source) => !listed.has(source))).toEqual([]);
  });

  it("pulls a missing computer image only from a registry the name spells out", () => {
    expect(isRegistryQualifiedImage("ghcr.io/elie222/rakazo/computer:edge")).toBe(true);
    expect(isRegistryQualifiedImage("registry.test/rakazo/computer@sha256:0123")).toBe(true);
    expect(isRegistryQualifiedImage("localhost:5000/rakazo/computer")).toBe(true);
    expect(isRegistryQualifiedImage("localhost/rakazo/computer:local")).toBe(true);
    expect(isRegistryQualifiedImage("docker.io/rakazo/computer:edge")).toBe(true);
    expect(isRegistryQualifiedImage("Registry/rakazo/computer:edge")).toBe(true);
    expect(isRegistryQualifiedImage("rakazO/computer:edge")).toBe(true);
    expect(isRegistryQualifiedImage("rakazo/computer:local")).toBe(false);
    expect(isRegistryQualifiedImage("rakazo/computer@sha256:0123")).toBe(false);
    expect(isRegistryQualifiedImage("computer:local")).toBe(false);
  });

  it("ships a browser desktop, not a fullscreen terminal", () => {
    const root = path.resolve(import.meta.dirname, "../../computer");
    const dockerfile = readFileSync(path.join(root, "Dockerfile"), "utf8");
    const start = readFileSync(path.join(root, "start.sh"), "utf8");
    const browser = readFileSync(path.join(root, "rakazo-browser"), "utf8");
    const desktop = readFileSync(path.join(root, "rakazo-browser.desktop"), "utf8");
    expect(dockerfile).toMatch(/chromium/);
    expect(dockerfile).toMatch(/rakazo-browser\.desktop/);
    expect(dockerfile).toMatch(/control.py/);
    expect(dockerfile).toMatch(/USER 1000:1000/);
    expect(start).toMatch(/rakazo-computer-control/);
    expect(start).toMatch(/rakazo-browser/);
    expect(start).not.toMatch(/browser\.log/);
    expect(start).toMatch(/xdg-mime default rakazo-browser\.desktop/);
    expect(start).toMatch(/register_browser_handler x-scheme-handler\/http/);
    expect(start).toMatch(/register_browser_handler x-scheme-handler\/https/);
    expect(start).toMatch(/register_browser_handler text\/html/);
    expect(start).toMatch(/xdg-mime query default/);
    expect(start).toMatch(/failed to register rakazo-browser/);
    expect(start).toMatch(/failed to set default web browser/);
    expect(start).toMatch(/xdg-settings set default-web-browser rakazo-browser\.desktop/);
    expect(start).not.toMatch(/xdg-mime default rakazo-browser\.desktop .*\|\| true/);
    expect(start).toMatch(/x11vnc .* -viewonly /);
    expect(browser).toMatch(/\.browser-profiles\/chromium/);
    expect(browser).toMatch(/chromium-screen-\$DISPLAY_NUM/);
    expect(browser).toMatch(/USER_DATA_DIR_SET/);
    expect(browser).toMatch(/RAKAZO_BROWSER_PROFILE/);
    expect(desktop).toMatch(/Exec=\/usr\/local\/bin\/rakazo-browser %U/);
    expect(dockerfile).toMatch(/rakazo-page-browser/);
    expect(browser).toMatch(/remote-debugging-port/);
    expect(desktop).toMatch(/x-scheme-handler\/http/);
    expect(desktop).toMatch(/x-scheme-handler\/https/);
    expect(start).not.toMatch(/windowsize 1280 800/);
    expect(dockerfile).toMatch(/wmctrl/);
    expect(dockerfile).toMatch(/rakazo-focus-or-launch/);
  });

  it("creates every browser policy directory before copying the policy into it", () => {
    const root = path.resolve(import.meta.dirname, "../../computer");
    const dockerfile = readFileSync(path.join(root, "Dockerfile"), "utf8");
    // COPY --chmod=644 gives the directories it creates that mode too, and the browser user
    // then cannot enter them, so the browser silently runs without the policy.
    const created = dockerfile.match(/mkdir -p (\/etc\/rakazo\/fluxbox [^\\\n]+)/)?.[1]?.split(" ");
    const targets = [...dockerfile.matchAll(/COPY --chmod=644 browser-policy\.json (\S+)\//g)].map(
      (match) => match[1],
    );
    expect(targets).toEqual([
      "/etc/chromium/policies/managed",
      "/etc/brave/policies/managed",
      "/etc/opt/chrome/policies/managed",
    ]);
    for (const target of targets) expect(created).toContain(target);
  });

  it.skipIf(process.platform === "win32")(
    "fetches Google's signing key only for a Google Chrome build on amd64",
    () => {
      const root = path.resolve(import.meta.dirname, "../../computer");
      const dockerfile = readFileSync(path.join(root, "Dockerfile"), "utf8");
      const stage = dockerfile.split(/^FROM /m).find((part) => / AS chrome-keyring\n/.test(part));
      const run = stage
        ?.replace(/\\\n/g, " ")
        .split("\n")
        .filter((line) => line.startsWith("RUN "))
        .at(-1)
        ?.slice(4);
      expect(run).toBeTruthy();
      const temp = mkdtempSync(path.join(tmpdir(), "rakazo-chrome-keyring-"));
      const bin = path.join(temp, "bin");
      const keyring = path.join(temp, "google-chrome.gpg");
      const calls = path.join(temp, "calls");
      mkdirSync(bin);
      // Every network step records itself; the download fails as if Google were unreachable.
      for (const [name, body] of [
        ["dpkg", 'printf "%s\\n" "$RAKAZO_TEST_ARCH"'],
        ["apt-security.sh", 'printf "apt-security\\n" >> "$RAKAZO_TEST_CALLS"'],
        ["apt-get", 'printf "apt-get\\n" >> "$RAKAZO_TEST_CALLS"'],
        ["curl", 'printf "curl\\n" >> "$RAKAZO_TEST_CALLS"; exit 7'],
        ["gpg", 'printf "gpg\\n" >> "$RAKAZO_TEST_CALLS"'],
      ] as const) {
        writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`);
        chmodSync(path.join(bin, name), 0o755);
      }
      const build = (browser: string, arch: string) => {
        rmSync(keyring, { force: true });
        writeFileSync(calls, "");
        const result = spawnSync(
          "sh",
          [
            "-c",
            run!
              .replaceAll("/google-chrome.gpg", keyring)
              .replaceAll("/tmp/apt-security.sh", path.join(bin, "apt-security.sh"))
              .replaceAll("/tmp/google.pub", path.join(temp, "google.pub")),
          ],
          {
            env: {
              ...process.env,
              BROWSER: browser,
              PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
              RAKAZO_TEST_ARCH: arch,
              RAKAZO_TEST_CALLS: calls,
            },
            encoding: "utf8",
          },
        );
        return {
          status: result.status,
          calls: readFileSync(calls, "utf8").trim().split("\n").filter(Boolean),
          stderr: result.stderr,
        };
      };
      try {
        for (const browser of ["chromium", "brave"]) {
          // No network at all, and an empty keyring for the image's COPY.
          expect(build(browser, "amd64"), browser).toMatchObject({ status: 0, calls: [] });
          expect(readFileSync(keyring, "utf8")).toBe("");
        }
        // Google publishes no Chrome for arm64: the build says so instead of falling back.
        const arm = build("chrome", "arm64");
        expect(arm).toMatchObject({ status: 1, calls: [] });
        expect(arm.stderr).toMatch(/amd64 only/);
        expect(build("chrome", "amd64")).toMatchObject({
          status: 7,
          calls: ["apt-security", "apt-get", "apt-get", "curl"],
        });
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "finds Google Chrome and passes over Ubuntu's snap chromium",
    () => {
      const root = path.resolve(import.meta.dirname, "../../computer");
      const temp = mkdtempSync(path.join(tmpdir(), "rakazo-browser-find-"));
      const bin = path.join(temp, "bin");
      const tools = path.join(temp, "tools");
      const capture = path.join(temp, "launched");
      const snapChromium = path.join(bin, "chromium-browser");
      const chrome = path.join(bin, "google-chrome");
      mkdirSync(bin);
      writeFileSync(snapChromium, '#!/bin/sh\nexec /snap/bin/chromium "$@"\n');
      writeFileSync(chrome, '#!/bin/sh\nprintf "%s" "$0" > "$RAKAZO_TEST_LAUNCHED"\n');
      chmodSync(snapChromium, 0o755);
      chmodSync(chrome, 0o755);

      try {
        mkdirSync(tools);
        // Expose only shell utilities, never browsers from the host PATH.
        const utilities = [
          "sh",
          "mkdir",
          "readlink",
          "head",
          "grep",
          "rm",
          "find",
          "tr",
          "sed",
          "cat",
        ];
        if (process.platform === "linux") utilities.push("timeout");
        for (const utility of utilities) {
          const resolved = spawnSync("/bin/sh", ["-c", 'command -v "$1"', "sh", utility], {
            encoding: "utf8",
          });
          expect(resolved.status, resolved.stderr).toBe(0);
          symlinkSync(resolved.stdout.trim(), path.join(tools, utility));
        }
        const result = spawnSync("sh", [path.join(root, "rakazo-browser")], {
          env: {
            ...process.env,
            DISPLAY: ":1",
            HOME: path.join(temp, "home"),
            PATH: `${bin}${path.delimiter}${tools}`,
            RAKAZO_TEST_LAUNCHED: capture,
          },
          encoding: "utf8",
        });
        expect(result.status, result.error?.message ?? result.stderr).toBe(0);
        expect(readFileSync(capture, "utf8")).toBe(chrome);
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
    },
  );

  it("ships a sha256-pinned gh CLI", () => {
    const root = path.resolve(import.meta.dirname, "../../computer");
    const dockerfile = readFileSync(path.join(root, "Dockerfile"), "utf8");
    expect(dockerfile).toMatch(/ARG GH_VERSION=\d+\.\d+\.\d+/);
    expect(dockerfile).toMatch(
      /cli\/cli\/releases\/download\/v\$\{GH_VERSION\}\/gh_\$\{GH_VERSION\}_linux_\$\{gh_arch\}\.tar\.gz/,
    );
    expect(dockerfile).toMatch(/amd64\) gh_arch=amd64; gh_sha256=[0-9a-f]{64}/);
    expect(dockerfile).toMatch(/arm64\) gh_arch=arm64; gh_sha256=[0-9a-f]{64}/);
    expect(dockerfile).toMatch(/sha256sum -c/);
    expect(dockerfile).toMatch(/\/usr\/local\/bin --strip-components=2 "gh_/);
    expect(dockerfile).toMatch(/gh --version/);
  });

  it("ships file search, identification, and SQLite commands", () => {
    const dockerfile = readFileSync(
      path.resolve(import.meta.dirname, "../../computer/Dockerfile"),
      "utf8",
    );
    const runtimeStage = dockerfile.slice([...dockerfile.matchAll(/^FROM .+$/gm)].at(-1)?.index ?? 0);
    const install = runtimeStage.match(
      /apt-get(?: -o \S+)* install -y --no-install-recommends ([\s\S]*?)&& rm -rf \/var\/lib\/apt\/lists\/\*/,
    )?.[1];
    expect(install).toBeDefined();
    const packages = install?.split(/\s+/);
    // Every apt package behind a command the shell environment map names.
    for (const name of [
      "curl",
      "git",
      "jq",
      "openssh-client",
      "unzip",
      "ripgrep",
      "fd-find",
      "file",
      "sqlite3",
    ]) {
      expect(packages).toContain(name);
    }
    expect(runtimeStage).toContain("ln -s /usr/bin/fdfind /usr/local/bin/fd");
    for (const command of ["rg", "fd", "file", "sqlite3"]) {
      expect(runtimeStage).toContain(`&& ${command} --version`);
    }
  });

  it("ships document text extractors", () => {
    const root = path.resolve(import.meta.dirname, "../../computer");
    const dockerfile = readFileSync(path.join(root, "Dockerfile"), "utf8");
    expect(dockerfile).toMatch(/--no-install-recommends/);
    expect(dockerfile).toMatch(/\bpoppler-utils\b/);
    expect(dockerfile).toMatch(/\bpandoc\b/);
    expect(dockerfile).toMatch(/\bpython3-openpyxl\b/);
    expect(dockerfile).not.toMatch(/libreoffice/i);
    expect(dockerfile).toMatch(/pdftotext -v/);
    expect(dockerfile).toMatch(/pdfinfo -v/);
    expect(dockerfile).toMatch(/pandoc --version/);
    expect(dockerfile).toMatch(/import openpyxl/);
  });

  it("ships search and inspection tools agents reach for", () => {
    const root = path.resolve(import.meta.dirname, "../../computer");
    const dockerfile = readFileSync(path.join(root, "Dockerfile"), "utf8");
    expect(dockerfile).toMatch(/\bripgrep\b/);
    expect(dockerfile).toMatch(/\bfd-find\b/);
    // "file" is a common word in the Dockerfile; anchor it to the package list.
    expect(dockerfile).toMatch(/^ {4}file \\/m);
    expect(dockerfile).toMatch(/\bsqlite3\b/);
    // Debian names fd-find's binary fdfind; the image exposes it as fd.
    expect(dockerfile).toMatch(/ln -s \/usr\/bin\/fdfind \/usr\/local\/bin\/fd/);
    expect(dockerfile).toMatch(/rg --version/);
    expect(dockerfile).toMatch(/fd --version/);
    expect(dockerfile).toMatch(/file --version/);
    expect(dockerfile).toMatch(/sqlite3 --version/);
  });

  it.skipIf(process.platform === "win32")(
    "delivers desktop menu exec arguments intact through /bin/sh",
    () => {
      const root = path.resolve(import.meta.dirname, "../../computer");
      const menu = readFileSync(path.join(root, "fluxbox.menu"), "utf8");
      const temp = mkdtempSync(path.join(tmpdir(), "fluxbox-menu-"));
      const bin = path.join(temp, "bin");
      mkdirSync(bin);
      try {
        for (const name of ["xterm", "rakazo-browser"]) {
          const stub = path.join(bin, name);
          writeFileSync(stub, '#!/bin/sh\nprintf "%s\\n" "$@" > "$RAKAZO_TEST_ARGS"\n');
          chmodSync(stub, 0o755);
        }
        const argvFor = (label: string) => {
          const command = menu
            .split("\n")
            .map((entry) => entry.match(/\[exec\] \(([^)]*)\) \{([^}]*)\}/))
            .find((match) => match?.[1] === label)?.[2];
          expect(command, label).toBeTruthy();
          const capture = path.join(temp, `${label}-args`);
          const result = spawnSync("sh", ["-c", command!], {
            env: {
              ...process.env,
              PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
              RAKAZO_TEST_ARGS: capture,
            },
            encoding: "utf8",
          });
          expect(result.status, result.stderr).toBe(0);
          return readFileSync(capture, "utf8").trim().split("\n").filter(Boolean);
        };
        expect(argvFor("Terminal")).toEqual([
          "-bg",
          "rgb:11/11/13",
          "-fg",
          "rgb:e8/e8/ea",
          "-cr",
          "rgb:e8/e8/ea",
          "-title",
          "Terminal",
          "-xrm",
          "XTerm*selectToClipboard: true",
        ]);
        expect(argvFor("Browser")).toEqual([]);
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "keeps the baked and generated desktop menus in sync",
    () => {
      const root = path.resolve(import.meta.dirname, "../../computer");
      const baked = readFileSync(path.join(root, "fluxbox.menu"), "utf8");
      const terminalLine = `[exec] (Terminal) {${TERMINAL_MENU_COMMAND}}`;
      expect(baked.split("\n").map((line) => line.trim())).toContain(terminalLine);

      const generated = ensureScreenCommand(0, "bot", "view-token", {
        ...DEFAULT_DESKTOP_ENV,
        preservePrimaryDisplay: false,
      });
      const temp = mkdtempSync(path.join(tmpdir(), "fluxbox-menu-"));
      const fluxHome = path.join(temp, "fluxbox-home-1");
      const menuPath = path.join(fluxHome, ".fluxbox", "menu");
      const initPath = path.join(fluxHome, ".fluxbox", "init");
      const init = "session.menuFile: kept\n";
      try {
        mkdirSync(path.dirname(menuPath), { recursive: true });
        writeFileSync(
          menuPath,
          "[begin] (Desktop)\n[exec] (Browser) {/tmp/rakazo/browser-launch-1}\n[end]\n",
        );
        writeFileSync(initPath, init);
        const lines = generated
          .replaceAll("/tmp/fluxbox-home-1", fluxHome)
          .replaceAll("/etc/rakazo/fluxbox/menu", path.join(temp, "no-image-menu"))
          .split("\n");
        const start = lines.indexOf(`mkdir -p ${fluxHome}/.fluxbox`);
        const end = lines.findIndex((line, index) => index > start && line === "fi");
        expect(start).toBeGreaterThanOrEqual(0);
        expect(end).toBeGreaterThan(start);
        const fragment = [
          "xdpyinfo() { return 0; }",
          "Xvfb() { echo Xvfb; }",
          "fluxbox() { echo fluxbox; }",
          "nohup() { echo nohup; }",
          lines.slice(start, end + 1).join("\n"),
        ].join("\n");
        for (let attempt = 0; attempt < 2; attempt++) {
          const result = spawnSync("bash", ["-eu", "-c", fragment], { encoding: "utf8" });
          expect(result.status, result.stderr).toBe(0);
          expect(result.stdout).toBe("");
        }
        const written = readFileSync(menuPath, "utf8");
        expect(written.split("\n").find((line) => line.includes("(Terminal)"))).toBe(terminalLine);
        expect(written).toBe(
          [
            "[begin] (Desktop)",
            "[exec] (Browser) {/tmp/rakazo/browser-launch-1}",
            terminalLine,
            "[end]",
            "",
          ].join("\n"),
        );
        expect(readFileSync(initPath, "utf8")).toBe(init);
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "removes only libnss_wrapper from the Chromium preload environment",
    () => {
      const root = path.resolve(import.meta.dirname, "../../computer");
      const temp = mkdtempSync(path.join(tmpdir(), "rakazo-browser-preload-"));
      try {
        const chromium = path.join(temp, "chromium");
        // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion
        writeFileSync(chromium, '#!/bin/sh\nprintf "%s" "${LD_PRELOAD-unset}"\n');
        chmodSync(chromium, 0o755);
        for (const [preload, expected] of [
          ["/usr/local/lib/libnss_wrapper.so", "unset"],
          [
            "/tmp/first.so:/usr/local/lib/libnss_wrapper.so:/tmp/last.so",
            "/tmp/first.so:/tmp/last.so",
          ],
          [":libnss_wrapper.so::", "unset"],
          ["/usr/local/lib/libnss_wrapper.so /tmp/other.so", "/tmp/other.so"],
          [" /tmp/first.so:libnss_wrapper.so /tmp/last.so ", "/tmp/first.so:/tmp/last.so"],
          ["/tmp/other.so", "/tmp/other.so"],
          ["", ""],
        ]) {
          const result = spawnSync(
            "sh",
            [path.join(root, "rakazo-browser"), "https://example.test"],
            {
              env: {
                ...process.env,
                HOME: temp,
                RAKAZO_BROWSER_PROFILE: path.join(temp, "profile"),
                PATH: `${temp}${path.delimiter}${process.env.PATH ?? ""}`,
                LD_PRELOAD: preload,
              },
              encoding: "utf8",
              timeout: 5_000,
            },
          );
          expect(result.status, result.stderr).toBe(0);
          expect(result.stdout).toBe(expected);
        }
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "selects a display-specific browser profile and preserves explicit profiles",
    () => {
      const root = path.resolve(import.meta.dirname, "../../computer");
      const temp = mkdtempSync(path.join(tmpdir(), "rakazo-browser-wrapper-"));
      const bin = path.join(temp, "bin");
      const capture = path.join(temp, "args");
      const home = path.join(temp, "home");
      const chromium = path.join(bin, "chromium");
      mkdirSync(bin);
      writeFileSync(chromium, '#!/bin/sh\nprintf "%s\\n" "$@" > "$RAKAZO_TEST_ARGS"\n');
      chmodSync(chromium, 0o755);

      const run = (display: string, args: string[] = []) => {
        const result = spawnSync("sh", [path.join(root, "rakazo-browser"), ...args], {
          env: {
            ...process.env,
            DISPLAY: display,
            HOME: home,
            PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
            RAKAZO_TEST_ARGS: capture,
          },
          encoding: "utf8",
        });
        expect(result.status, result.error?.message ?? result.stderr).toBe(0);
        return readFileSync(capture, "utf8").trim().split(/\r?\n/);
      };

      try {
        expect(run(":1")).toContain(`--user-data-dir=${home}/.browser-profiles/chromium`);
        expect(run(":1")).toContain("--restore-last-session");
        expect(run(":1")).toContain("--disable-gpu");
        expect(run(":1")).toContain("--enable-unsafe-swiftshader");
        expect(run(":1")).not.toContain("--disable-software-rasterizer");
        expect(run(":1").some((arg) => arg.startsWith("--remote-debugging-port="))).toBe(true);
        expect(run(":2")).toContain(`--user-data-dir=${home}/.browser-profiles/chromium-screen-2`);
        expect(run(":2")).toContain("--remote-debugging-port=9223");
        for (const display of [8, 9]) {
          const args = run(`:0${display}.0`);
          expect(args).toContain(`--remote-debugging-port=${9221 + display}`);
          expect(args).toContain(
            `--user-data-dir=${home}/.browser-profiles/chromium-screen-${display}`,
          );
        }
        const explicit = run(":3", [`--user-data-dir=${home}/custom-profile`]);
        expect(explicit).toContain(`--user-data-dir=${home}/custom-profile`);
        expect(explicit).toContain("--restore-last-session");
        expect(explicit).not.toContain(
          `--user-data-dir=${home}/.browser-profiles/chromium-screen-3`,
        );
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "offers pages the account's language on new and saved profiles",
    () => {
      const root = path.resolve(import.meta.dirname, "../../computer");
      const temp = mkdtempSync(path.join(tmpdir(), "rakazo-browser-language-"));
      const bin = path.join(temp, "bin");
      const capture = path.join(temp, "args");
      mkdirSync(bin);
      const chromium = path.join(bin, "chromium");
      writeFileSync(
        chromium,
        // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion
        '#!/bin/sh\nprintf "LANGUAGE=%s\\n" "${LANGUAGE-unset}" > "$RAKAZO_TEST_ARGS"\nprintf "%s\\n" "$@" >> "$RAKAZO_TEST_ARGS"\n',
      );
      chmodSync(chromium, 0o755);
      const run = (language: string | undefined) => {
        const { LANGUAGE: _host, ...env } = process.env;
        const result = spawnSync("sh", [path.join(root, "rakazo-browser")], {
          env: {
            ...env,
            ...(language === undefined ? {} : { LANGUAGE: language }),
            DISPLAY: ":1",
            HOME: path.join(temp, "home"),
            PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
            RAKAZO_TEST_ARGS: capture,
          },
          encoding: "utf8",
        });
        expect(result.status, result.error?.message ?? result.stderr).toBe(0);
        const [first, ...args] = readFileSync(capture, "utf8").trim().split(/\r?\n/);
        return { language: first, accept: args.filter((arg) => arg.startsWith("--accept-lang")) };
      };
      try {
        // Unknown: the browser's own default, as before.
        expect(run(undefined)).toEqual({ language: "LANGUAGE=unset", accept: [] });
        // Chrome reads LANGUAGE itself; --accept-lang also reaches a profile saved in English.
        expect(run("pl")).toEqual({
          language: "LANGUAGE=pl",
          accept: ["--accept-lang=pl,en-US,en"],
        });
        expect(run("pt_BR:pt").accept).toEqual(["--accept-lang=pt-BR,pt,en-US,en"]);
        expect(run("en-GB").accept).toEqual(["--accept-lang=en-GB,en"]);
        for (const value of ["", "pl;id", "-x", "pl pl"]) expect(run(value).accept).toEqual([]);
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform !== "linux")(
    "spawns Chromium when the caller passes the profile and debug flags itself",
    () => {
      const root = path.resolve(import.meta.dirname, "../../computer");
      const temp = mkdtempSync(path.join(tmpdir(), "rakazo-browser-self-"));
      const bin = path.join(temp, "bin");
      const capture = path.join(temp, "args");
      const home = path.join(temp, "home");
      const chromium = path.join(bin, "chromium");
      mkdirSync(bin);
      writeFileSync(chromium, '#!/bin/sh\nprintf "%s\\n" "$@" > "$RAKAZO_TEST_ARGS"\n');
      chmodSync(chromium, 0o755);

      // browser-launch-N execs this wrapper with --user-data-dir and
      // --remote-debugging-port already set, so the live-browser scan must not
      // match the wrapper's own argv and take the reuse path instead of
      // spawning.
      const profile = path.join(home, ".browser-profiles", "chromium-bot-screen");
      mkdirSync(profile, { recursive: true });

      try {
        const result = spawnSync(
          "sh",
          [
            path.join(root, "rakazo-browser"),
            `--user-data-dir=${profile}`,
            "--remote-debugging-port=9222",
          ],
          {
            env: {
              ...process.env,
              DISPLAY: ":1",
              HOME: home,
              PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
              RAKAZO_TEST_ARGS: capture,
            },
            encoding: "utf8",
          },
        );
        expect(result.status, result.error?.message ?? result.stderr).toBe(0);
        const args = readFileSync(capture, "utf8");
        expect(args).toContain(`--user-data-dir=${profile}`);
        expect(args).toContain("--remote-debugging-port=9222");
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform !== "linux")(
    "spawns Chromium when the wrapper is invoked as ./rakazo-browser",
    () => {
      const root = path.resolve(import.meta.dirname, "../../computer");
      const temp = mkdtempSync(path.join(tmpdir(), "rakazo-browser-rel-"));
      const bin = path.join(temp, "bin");
      const capture = path.join(temp, "args");
      const home = path.join(temp, "home");
      const chromium = path.join(bin, "chromium");
      mkdirSync(bin);
      writeFileSync(chromium, '#!/bin/sh\nprintf "%s\\n" "$@" > "$RAKAZO_TEST_ARGS"\n');
      chmodSync(chromium, 0o755);
      const profile = path.join(home, ".browser-profiles", "chromium-bot-screen");
      mkdirSync(profile, { recursive: true });
      // The kernel records the path passed to exec, so a relative invocation
      // shows up as ./rakazo-browser rather than an absolute script path.
      symlinkSync(path.join(root, "rakazo-browser"), path.join(temp, "rakazo-browser"));

      try {
        const result = spawnSync(
          "./rakazo-browser",
          [`--user-data-dir=${profile}`, "--remote-debugging-port=9222"],
          {
            cwd: temp,
            env: {
              ...process.env,
              DISPLAY: ":1",
              HOME: home,
              PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
              RAKAZO_TEST_ARGS: capture,
            },
            encoding: "utf8",
          },
        );
        expect(result.status, result.error?.message ?? result.stderr).toBe(0);
        const args = readFileSync(capture, "utf8");
        expect(args).toContain(`--user-data-dir=${profile}`);
        expect(args).toContain("--remote-debugging-port=9222");
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform !== "linux")(
    "keeps a live browser when its profile directory is named rakazo-browser",
    () => {
      const root = path.resolve(import.meta.dirname, "../../computer");
      const temp = mkdtempSync(path.join(tmpdir(), "rakazo-browser-named-"));
      const bin = path.join(temp, "bin");
      const capture = path.join(temp, "args");
      const home = path.join(temp, "home");
      const profile = path.join(temp, "rakazo-browser");
      const prefsPath = path.join(profile, "Default", "Preferences");
      const liveBin = path.join(temp, "live", "chromium");
      mkdirSync(bin);
      mkdirSync(path.dirname(liveBin));
      mkdirSync(path.dirname(prefsPath), { recursive: true });
      writeFileSync(
        path.join(bin, "chromium"),
        '#!/bin/sh\nprintf "%s\\n" "$@" > "$RAKAZO_TEST_ARGS"\n',
      );
      chmodSync(path.join(bin, "chromium"), 0o755);
      // /proc/pid/exe is this binary, so the basename is chromium without compiling.
      copyFileSync("/bin/sh", liveBin);
      chmodSync(liveBin, 0o755);
      writeFileSync(prefsPath, '{\n  "profile": {\n    "exit_type": "Crashed"\n  }\n}\n');
      const browser = spawn(
        liveBin,
        [
          "-c",
          "while :; do sleep 3600; done",
          "chromium",
          `--user-data-dir=${profile}`,
          "--remote-debugging-port=9",
          "--user-data-dir",
          profile,
        ],
        { stdio: "ignore", detached: true },
      );
      const liveLock = path.join(profile, "SingletonLock");
      symlinkSync(`testhost-${browser.pid}`, liveLock);
      try {
        const result = spawnSync(
          "sh",
          [
            path.join(root, "rakazo-browser"),
            `--user-data-dir=${profile}`,
            "--remote-debugging-port=9222",
          ],
          {
            env: {
              ...process.env,
              DISPLAY: ":1",
              HOME: home,
              PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
              RAKAZO_TEST_ARGS: capture,
            },
            encoding: "utf8",
          },
        );
        expect(result.status, result.error?.message ?? result.stderr).toBe(0);
        expect(readlinkSync(liveLock)).toBe(`testhost-${browser.pid}`);
        expect(readFileSync(prefsPath, "utf8")).toContain('"exit_type": "Crashed"');
        expect(readFileSync(capture, "utf8")).toContain(`--user-data-dir=${profile}`);
      } finally {
        if (browser.pid) {
          try {
            process.kill(-browser.pid, "SIGKILL");
          } catch {
            browser.kill("SIGKILL");
          }
        }
        rmSync(temp, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform !== "linux")(
    "keeps a live shell browser when the profile flag ends in /rakazo-browser",
    () => {
      const root = path.resolve(import.meta.dirname, "../../computer");
      const temp = mkdtempSync(path.join(tmpdir(), "rakazo-browser-flag-"));
      const bin = path.join(temp, "bin");
      const capture = path.join(temp, "args");
      const home = path.join(temp, "home");
      const profile = path.join(temp, "rakazo-browser");
      const prefsPath = path.join(profile, "Default", "Preferences");
      mkdirSync(bin);
      mkdirSync(path.dirname(prefsPath), { recursive: true });
      writeFileSync(
        path.join(bin, "chromium"),
        '#!/bin/sh\nprintf "%s\\n" "$@" > "$RAKAZO_TEST_ARGS"\n',
      );
      chmodSync(path.join(bin, "chromium"), 0o755);
      const sleeper = path.join(bin, "sleeper");
      writeFileSync(sleeper, "#!/bin/sh\nsleep 120\n");
      chmodSync(sleeper, 0o755);
      writeFileSync(prefsPath, '{\n  "profile": {\n    "exit_type": "Crashed"\n  }\n}\n');
      const browser = spawn(sleeper, [`--user-data-dir=${profile}`, "--remote-debugging-port=9"], {
        stdio: "ignore",
        detached: true,
      });
      const liveLock = path.join(profile, "SingletonLock");
      symlinkSync(`testhost-${browser.pid}`, liveLock);
      try {
        const result = spawnSync(
          "sh",
          [
            path.join(root, "rakazo-browser"),
            `--user-data-dir=${profile}`,
            "--remote-debugging-port=9222",
          ],
          {
            env: {
              ...process.env,
              DISPLAY: ":1",
              HOME: home,
              PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
              RAKAZO_TEST_ARGS: capture,
            },
            encoding: "utf8",
          },
        );
        expect(result.status, result.error?.message ?? result.stderr).toBe(0);
        expect(readlinkSync(liveLock)).toBe(`testhost-${browser.pid}`);
        expect(readFileSync(prefsPath, "utf8")).toContain('"exit_type": "Crashed"');
      } finally {
        if (browser.pid) {
          try {
            process.kill(-browser.pid, "SIGKILL");
          } catch {
            browser.kill("SIGKILL");
          }
        }
        rmSync(temp, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "clears crashed state from Chromium preferences and Local State",
    () => {
      const root = path.resolve(import.meta.dirname, "../../computer");
      const temp = mkdtempSync(path.join(tmpdir(), "rakazo-browser-crash-"));
      const bin = path.join(temp, "bin");
      const home = path.join(temp, "home");
      const chromium = path.join(bin, "chromium");
      const capture = path.join(temp, "args");
      mkdirSync(bin);
      writeFileSync(chromium, '#!/bin/sh\nprintf "%s\\n" "$@" > "$RAKAZO_TEST_ARGS"\n');
      chmodSync(chromium, 0o755);

      const profile = path.join(home, ".browser-profiles/chromium");
      const prefsDir = path.join(profile, "Default");
      mkdirSync(prefsDir, { recursive: true });
      const prefsPath = path.join(prefsDir, "Preferences");
      const localStatePath = path.join(profile, "Local State");
      writeFileSync(
        prefsPath,
        '{\n  "profile": {\n    "exit_type": "Crashed",\n    "exited_cleanly": false\n  }\n}\n',
      );
      writeFileSync(localStatePath, '{\n  "profile": {\n    "exited_cleanly": false\n  }\n}\n');

      try {
        const result = spawnSync("bash", [path.join(root, "rakazo-browser")], {
          env: {
            ...process.env,
            DISPLAY: ":1",
            HOME: home,
            PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
            RAKAZO_TEST_ARGS: capture,
          },
          encoding: "utf8",
        });
        expect(result.status, result.error?.message ?? result.stderr).toBe(0);

        const flags = readFileSync(capture, "utf8");
        expect(flags).toMatch(/--hide-crash-restore-bubble/);
        expect(flags).toMatch(/--disable-session-crashed-bubble/);

        const updatedPrefs = readFileSync(prefsPath, "utf8");
        expect(updatedPrefs).toContain('"exit_type":"Normal"');
        expect(updatedPrefs).toContain('"exited_cleanly":true');
        expect(updatedPrefs).not.toContain("Crashed");
        expect(updatedPrefs).not.toMatch(/"exited_cleanly"\s*:\s*false/);

        const updatedLocalState = readFileSync(localStatePath, "utf8");
        expect(updatedLocalState).toContain('"exited_cleanly":true');
        expect(updatedLocalState).not.toMatch(/"exited_cleanly"\s*:\s*false/);

        writeFileSync(prefsPath, '{\n  "profile": {\n    "exit_type": "Crashed"\n  }\n}\n');
        const sleeper = path.join(bin, "sleeper");
        writeFileSync(sleeper, "#!/bin/sh\nsleep 120\n");
        chmodSync(sleeper, 0o755);
        const liveBrowser = spawn(sleeper, [`--user-data-dir=${profile}`], {
          stdio: "ignore",
          detached: true,
        });
        const liveLock = path.join(profile, "SingletonLock");
        const launch = () =>
          spawnSync("bash", [path.join(root, "rakazo-browser")], {
            env: {
              ...process.env,
              DISPLAY: ":1",
              HOME: home,
              PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
              RAKAZO_TEST_ARGS: capture,
            },
            encoding: "utf8",
          });
        try {
          symlinkSync(`testhost-${liveBrowser.pid}`, liveLock);
          const skipped = launch();
          expect(skipped.status, skipped.error?.message ?? skipped.stderr).toBe(0);
          expect(readFileSync(prefsPath, "utf8")).toContain("Crashed");
          expect(readlinkSync(liveLock)).toBe(`testhost-${liveBrowser.pid}`);

          if (process.platform === "linux") {
            const renderer = spawn(sleeper, ["--type=renderer", `--user-data-dir=${profile}`], {
              stdio: "ignore",
              detached: true,
            });
            try {
              writeFileSync(prefsPath, '{\n  "profile": {\n    "exit_type": "Crashed"\n  }\n}\n');
              rmSync(liveLock);
              symlinkSync(`testhost-${process.pid}`, liveLock);
              const reused = launch();
              expect(reused.status, reused.error?.message ?? reused.stderr).toBe(0);
              expect(readFileSync(prefsPath, "utf8")).toContain('"exit_type":"Normal"');

              writeFileSync(prefsPath, '{\n  "profile": {\n    "exit_type": "Crashed"\n  }\n}\n');
              symlinkSync(`testhost-${renderer.pid}`, liveLock);
              const childLock = launch();
              expect(childLock.status, childLock.error?.message ?? childLock.stderr).toBe(0);
              expect(readFileSync(prefsPath, "utf8")).toContain('"exit_type":"Normal"');

              const joiner = path.join(bin, "join-cmdline.py");
              writeFileSync(
                joiner,
                [
                  "import os, time",
                  'raw = open("/proc/self/cmdline", "rb").read().rstrip(b"\\0")',
                  'joined = raw.replace(b"\\0", b" ")',
                  "start = end = None",
                  'for line in open("/proc/self/maps"):',
                  '    if "[stack]" in line:',
                  '        a, b = line.split()[0].split("-")',
                  "        start, end = int(a, 16), int(b, 16)",
                  "        break",
                  'mem = os.open("/proc/self/mem", os.O_RDWR)',
                  "pos = end",
                  "found = None",
                  "while pos > start:",
                  "    size = min(1024 * 1024, pos - start)",
                  "    pos -= size",
                  "    os.lseek(mem, pos, os.SEEK_SET)",
                  "    data = os.read(mem, size + len(raw))",
                  "    idx = data.find(raw)",
                  "    if idx != -1:",
                  "        found = pos + idx",
                  "        break",
                  "if found is None:",
                  '    raise SystemExit("cmdline not found")',
                  "os.lseek(mem, found, os.SEEK_SET)",
                  "os.write(mem, joined)",
                  "os.close(mem)",
                  'open(os.environ["JOINED_READY"], "w").write("ready\\n")',
                  "time.sleep(120)",
                  "",
                ].join("\n"),
              );
              const ready = path.join(temp, "joined-ready");
              const python = spawnSync("python3", ["-c", "import sys; print(sys.executable)"], {
                encoding: "utf8",
              }).stdout.trim();
              const spacedHome = path.join(temp, "home --type=renderer dir");
              const spacedProfile = path.join(spacedHome, ".browser-profiles/chromium");
              const spacedPrefs = path.join(spacedProfile, "Default", "Preferences");
              mkdirSync(path.dirname(spacedPrefs), { recursive: true });
              writeFileSync(spacedPrefs, '{\n  "profile": {\n    "exit_type": "Crashed"\n  }\n}\n');
              const joined = spawn(python, [joiner, `--user-data-dir=${spacedProfile}`], {
                stdio: "ignore",
                detached: true,
                env: { ...process.env, JOINED_READY: ready },
              });
              try {
                const deadline = Date.now() + 15_000;
                while (spawnSync("test", ["-s", ready]).status !== 0) {
                  if (Date.now() > deadline)
                    throw new Error("space-joined command line was not published");
                  spawnSync("sleep", ["0.02"]);
                }
                const spacedLock = path.join(spacedProfile, "SingletonLock");
                symlinkSync(`testhost-${joined.pid}`, spacedLock);
                const kept = spawnSync("bash", [path.join(root, "rakazo-browser")], {
                  env: {
                    ...process.env,
                    DISPLAY: ":1",
                    HOME: spacedHome,
                    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
                    RAKAZO_TEST_ARGS: capture,
                  },
                  encoding: "utf8",
                });
                expect(kept.status, kept.error?.message ?? kept.stderr).toBe(0);
                expect(readFileSync(spacedPrefs, "utf8")).toContain("Crashed");
                expect(readlinkSync(spacedLock)).toBe(`testhost-${joined.pid}`);
              } finally {
                if (joined.pid) {
                  try {
                    process.kill(-joined.pid, "SIGKILL");
                  } catch {
                    joined.kill("SIGKILL");
                  }
                }
              }
            } finally {
              if (renderer.pid) {
                try {
                  process.kill(-renderer.pid, "SIGKILL");
                } catch {
                  renderer.kill("SIGKILL");
                }
              }
            }
          }

          writeFileSync(prefsPath, '{\n  "profile": {\n    "exit_type": "Crashed"\n  }\n}\n');
          const gone = spawnSync("/bin/sleep", ["0"]);
          expect(gone.status).toBe(0);
          expect(spawnSync("kill", ["-0", String(gone.pid)]).status).not.toBe(0);
          rmSync(liveLock, { force: true });
          symlinkSync(`testhost-${gone.pid}`, liveLock);
          const cleared = launch();
          expect(cleared.status, cleared.error?.message ?? cleared.stderr).toBe(0);
          expect(readFileSync(prefsPath, "utf8")).toContain('"exit_type":"Normal"');
        } finally {
          if (liveBrowser.pid) {
            try {
              process.kill(-liveBrowser.pid, "SIGKILL");
            } catch {
              liveBrowser.kill("SIGKILL");
            }
          }
        }
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform !== "linux")(
    "forwards a URL to the live browser when SingletonLock misses that process",
    () => {
      const root = path.resolve(import.meta.dirname, "../../computer");
      const temp = mkdtempSync(path.join(tmpdir(), "rakazo-browser-live-"));
      const bin = path.join(temp, "bin");
      const home = path.join(temp, "home");
      const capture = path.join(temp, "args");
      const urlsFile = path.join(temp, "urls");
      const dropFile = path.join(temp, "drop");
      const portFile = path.join(temp, "port");
      mkdirSync(bin);
      writeFileSync(
        path.join(bin, "chromium"),
        '#!/bin/sh\nprintf "%s\\n" "$@" > "$RAKAZO_TEST_ARGS"\n',
      );
      chmodSync(path.join(bin, "chromium"), 0o755);
      symlinkSync(path.join(root, "rakazo-browser"), path.join(bin, "rakazo-browser"));
      const sleeper = path.join(bin, "sleeper");
      writeFileSync(sleeper, "#!/bin/sh\nsleep 120\n");
      chmodSync(sleeper, 0o755);
      const endpoint = path.join(temp, "debug-endpoint.py");
      writeFileSync(
        endpoint,
        [
          "import json, os, time, urllib.parse",
          "from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer",
          "pages = []",
          "state = {'consumed': False, 'listed': False, 'mode': ''}",
          "def mode():",
          "    try:",
          "        with open(os.environ['RAKAZO_TEST_DROP'], encoding='utf-8') as handle:",
          "            current = handle.read().strip()",
          "    except OSError:",
          "        current = ''",
          "    if current != state['mode']:",
          "        state['mode'] = current",
          "        state['consumed'] = False",
          "        state['listed'] = False",
          "    return current",
          "class Handler(BaseHTTPRequestHandler):",
          "    def do_GET(self):",
          "        self.route()",
          "    def do_PUT(self):",
          "        self.route()",
          "    def route(self):",
          "        base = self.path.split('?', 1)[0]",
          "        if base in ('/json/list', '/json'):",
          "            current = mode()",
          "            if current == 'slow-list' and not state['listed']:",
          "                state['listed'] = True",
          "                time.sleep(0.6)",
          "            if current == 'before' and state['consumed']:",
          "                state['listed'] = True",
          "            listed = pages",
          "            if current == 'stranger' and state['consumed']:",
          "                listed = pages + [{'id': 'stranger', 'type': 'page', 'url': 'https://other.example/unrelated'}]",
          "            body = json.dumps(listed).encode('utf-8')",
          "            self.send_response(200)",
          "            self.send_header('Content-Type', 'application/json')",
          "            self.send_header('Content-Length', str(len(body)))",
          "            self.end_headers()",
          "            self.wfile.write(body)",
          "            return",
          "        if base != '/json/new':",
          "            self.send_error(404)",
          "            return",
          "        query = self.path.split('?', 1)[1] if '?' in self.path else ''",
          "        opened = urllib.parse.unquote(query)",
          "        with open(os.environ['RAKAZO_TEST_URLS'], 'a', encoding='utf-8') as handle:",
          "            handle.write(self.path + '\\n')",
          "        current = mode()",
          "        if current == 'before' and not state['listed']:",
          "            state['consumed'] = True",
          "            self.connection.close()",
          "            return",
          "        if current == 'stranger' and not state['consumed']:",
          "            state['consumed'] = True",
          "            self.connection.close()",
          "            return",
          "        pages.append({'id': 'tab-%d' % (len(pages) + 1), 'type': 'page', 'url': opened})",
          "        if current == 'after':",
          "            self.connection.close()",
          "            return",
          "        self.send_response(200)",
          "        self.send_header('Content-Length', '0')",
          "        self.end_headers()",
          "    def log_message(self, fmt, *args):",
          "        return",
          "server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)",
          "with open(os.environ['RAKAZO_TEST_PORT'], 'w', encoding='utf-8') as handle:",
          "    handle.write(str(server.server_address[1]))",
          "server.serve_forever()",
          "",
        ].join("\n"),
      );
      const blackhole = path.join(temp, "blackhole.py");
      const acceptedFile = path.join(temp, "accepted");
      writeFileSync(
        blackhole,
        [
          "import os, socket, time",
          "sock = socket.socket()",
          "sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)",
          "sock.bind(('127.0.0.1', 0))",
          "sock.listen(8)",
          "with open(os.environ['RAKAZO_TEST_PORT'], 'w', encoding='utf-8') as handle:",
          "    handle.write(str(sock.getsockname()[1]))",
          "while True:",
          "    connection, _addr = sock.accept()",
          "    with open(os.environ['RAKAZO_TEST_ACCEPTED'], 'a', encoding='utf-8') as handle:",
          "        handle.write('accepted\\n')",
          "    time.sleep(30)",
          "    connection.close()",
          "",
        ].join("\n"),
      );

      const profile = path.join(home, ".browser-profiles/chromium-bot-live");
      const prefsPath = path.join(profile, "Default", "Preferences");
      const cookiesPath = path.join(profile, "Default", "Network", "Cookies");
      mkdirSync(path.dirname(cookiesPath), { recursive: true });
      const prefs = '{\n  "profile": {\n    "exit_type": "Crashed"\n  }\n}\n';
      writeFileSync(prefsPath, prefs);
      writeFileSync(cookiesPath, "session=kept");
      writeFileSync(urlsFile, "");
      writeFileSync(dropFile, "0\n");
      const launchEnv = {
        ...process.env,
        DISPLAY: ":1",
        HOME: home,
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
        RAKAZO_BROWSER_PROFILE: profile,
        RAKAZO_TEST_ARGS: capture,
      };
      const endpointProcess = spawn("python3", [endpoint], {
        stdio: "ignore",
        detached: true,
        env: {
          ...process.env,
          RAKAZO_TEST_PORT: portFile,
          RAKAZO_TEST_URLS: urlsFile,
          RAKAZO_TEST_DROP: dropFile,
        },
      });
      const children = [endpointProcess];
      const publishedPort = (file: string) => {
        const deadline = Date.now() + 15_000;
        while (spawnSync("test", ["-s", file]).status !== 0) {
          if (Date.now() > deadline) throw new Error("debug endpoint did not publish a port");
          spawnSync("sleep", ["0.02"]);
        }
        return readFileSync(file, "utf8").trim();
      };
      try {
        const debugPort = publishedPort(portFile);
        const browser = spawn(
          sleeper,
          [`--user-data-dir=${profile}`, `--remote-debugging-port=${debugPort}`],
          { stdio: "ignore", detached: true },
        );
        const renderer = spawn(sleeper, ["--type=renderer", `--user-data-dir=${profile}`], {
          stdio: "ignore",
          detached: true,
        });
        const wrapper = spawn(sleeper, [`--user-data-dir=${profile}`], {
          stdio: "ignore",
          detached: true,
        });
        children.push(browser, renderer, wrapper);
        const liveLock = path.join(profile, "SingletonLock");
        const launch = (args: string[] = []) =>
          spawnSync("bash", [path.join(root, "rakazo-browser"), ...args], {
            env: launchEnv,
            encoding: "utf8",
          });
        const newTabs = () =>
          readFileSync(urlsFile, "utf8")
            .split("\n")
            .filter((line) => line.startsWith("/json/new"));
        const forwarded = (url: string) =>
          newTabs().includes(`/json/new?${encodeURIComponent(url)}`);
        const pointLock = (pid: number | undefined) => {
          rmSync(liveLock, { force: true });
          symlinkSync(`testhost-${pid}`, liveLock);
        };
        pointLock(renderer.pid);
        const kept = launch();
        expect(kept.status, kept.error?.message ?? kept.stderr).toBe(0);
        expect(readFileSync(prefsPath, "utf8")).toBe(prefs);
        expect(readFileSync(cookiesPath, "utf8")).toBe("session=kept");
        expect(readlinkSync(liveLock)).toBe(`testhost-${renderer.pid}`);
        expect(() => readFileSync(capture, "utf8")).toThrow();

        const openedAt = newTabs().length;
        const opened = launch(["https://example.com/opened"]);
        expect(opened.status, opened.error?.message ?? opened.stderr).toBe(0);
        expect(newTabs().slice(openedAt)).toEqual([
          `/json/new?${encodeURIComponent("https://example.com/opened")}`,
        ]);
        expect(readFileSync(prefsPath, "utf8")).toBe(prefs);
        expect(readFileSync(cookiesPath, "utf8")).toBe("session=kept");
        expect(readlinkSync(liveLock)).toBe(`testhost-${renderer.pid}`);
        expect(() => readFileSync(capture, "utf8")).toThrow();

        for (const [target, openedUrl] of [
          ["example.com", "http://example.com"],
          ["localhost:3000", "http://localhost:3000"],
          ["/tmp/page.html", "file:///tmp/page.html"],
        ] as const) {
          const hostAt = newTabs().length;
          const host = launch([target]);
          expect(host.status, host.error?.message ?? host.stderr).toBe(0);
          expect(newTabs().slice(hostAt)).toEqual([`/json/new?${encodeURIComponent(openedUrl)}`]);
        }

        pointLock(wrapper.pid);
        const wrapperAt = newTabs().length;
        const viaWrapper = launch(["https://example.com/from-wrapper"]);
        expect(viaWrapper.status, viaWrapper.error?.message ?? viaWrapper.stderr).toBe(0);
        expect(newTabs().slice(wrapperAt)).toEqual([
          `/json/new?${encodeURIComponent("https://example.com/from-wrapper")}`,
        ]);
        expect(readFileSync(prefsPath, "utf8")).toBe(prefs);
        expect(readlinkSync(liveLock)).toBe(`testhost-${wrapper.pid}`);
        expect(() => readFileSync(capture, "utf8")).toThrow();

        writeFileSync(dropFile, "after\n");
        const droppedAt = newTabs().length;
        const dropped = launch(["https://example.com/drop-after-create"]);
        expect(dropped.status, dropped.error?.message ?? dropped.stderr).toBe(0);
        expect(newTabs().slice(droppedAt)).toEqual([
          `/json/new?${encodeURIComponent("https://example.com/drop-after-create")}`,
        ]);
        expect(readFileSync(prefsPath, "utf8")).toBe(prefs);
        expect(() => readFileSync(capture, "utf8")).toThrow();

        writeFileSync(dropFile, "before\n");
        const blindAt = newTabs().length;
        const blind = launch(["https://example.com/drop-before-create"]);
        expect(blind.status, blind.error?.message ?? blind.stderr).toBe(0);
        expect(newTabs().slice(blindAt)).toEqual([
          `/json/new?${encodeURIComponent("https://example.com/drop-before-create")}`,
          `/json/new?${encodeURIComponent("https://example.com/drop-before-create")}`,
        ]);

        writeFileSync(dropFile, "stranger\n");
        const strangerAt = newTabs().length;
        const stranger = launch(["https://example.com/not-the-stranger"]);
        expect(stranger.status).not.toBe(0);
        expect(newTabs().slice(strangerAt)).toEqual([
          `/json/new?${encodeURIComponent("https://example.com/not-the-stranger")}`,
        ]);

        writeFileSync(dropFile, "slow-list\n");
        const slowAt = newTabs().length;
        const slow = launch(["https://example.com/after-slow-list"]);
        expect(slow.status, slow.error?.message ?? slow.stderr).toBe(0);
        expect(newTabs().slice(slowAt)).toEqual([
          `/json/new?${encodeURIComponent("https://example.com/after-slow-list")}`,
        ]);
        writeFileSync(dropFile, "0\n");

        pointLock(browser.pid);
        const owned = launch(["https://example.com/owned-lock"]);
        expect(owned.status, owned.error?.message ?? owned.stderr).toBe(0);
        expect(readFileSync(capture, "utf8")).toContain("https://example.com/owned-lock");
        expect(readFileSync(prefsPath, "utf8")).toBe(prefs);
        expect(forwarded("https://example.com/owned-lock")).toBe(false);

        rmSync(capture, { force: true });
        pointLock(renderer.pid);
        endpointProcess.kill("SIGKILL");
        const closed = launch(["https://example.com/closed"]);
        expect(closed.status).not.toBe(0);
        expect(forwarded("https://example.com/closed")).toBe(false);
        expect(readFileSync(prefsPath, "utf8")).toBe(prefs);
        expect(readFileSync(cookiesPath, "utf8")).toBe("session=kept");
        expect(() => readFileSync(capture, "utf8")).toThrow();

        if (browser.pid) {
          try {
            process.kill(-browser.pid, "SIGKILL");
          } catch {
            browser.kill("SIGKILL");
          }
        }
        const hungPortFile = path.join(temp, "hung-port");
        const hung = spawn("python3", [blackhole], {
          stdio: "ignore",
          detached: true,
          env: {
            ...process.env,
            RAKAZO_TEST_PORT: hungPortFile,
            RAKAZO_TEST_ACCEPTED: acceptedFile,
          },
        });
        children.push(hung);
        const hungPort = publishedPort(hungPortFile);
        const hungBrowser = spawn(
          sleeper,
          [`--user-data-dir=${profile}`, `--remote-debugging-port=${hungPort}`],
          { stdio: "ignore", detached: true },
        );
        children.push(hungBrowser);
        pointLock(wrapper.pid);
        const reported = spawnSync(
          "python3",
          [
            "-c",
            [
              "import importlib.util, sys",
              "spec = importlib.util.spec_from_file_location('control', sys.argv[1])",
              "module = importlib.util.module_from_spec(spec)",
              "spec.loader.exec_module(module)",
              // The fixture launcher lives outside the image's trusted command folders.
              "module.CHILD_PATH = sys.argv[3] + ':' + module.CHILD_PATH",
              "argv = ['env', 'DISPLAY=:1', 'rakazo-browser', sys.argv[2]]",
              "try:",
              "    module.run_control_argv(argv, ':1')",
              "except RuntimeError as error:",
              "    if str(error) != 'computer action failed':",
              "        raise",
              "    raise SystemExit(0)",
              "raise SystemExit('open looked successful')",
            ].join("\n"),
            path.join(root, "control.py"),
            "https://example.com/unanswered",
            bin,
          ],
          { env: launchEnv, encoding: "utf8" },
        );
        expect(reported.status, reported.stdout + reported.stderr).toBe(0);
        expect(readFileSync(acceptedFile, "utf8")).toContain("accepted");
        expect(readFileSync(prefsPath, "utf8")).toBe(prefs);
        expect(() => readFileSync(capture, "utf8")).toThrow();
      } finally {
        for (const child of children) {
          if (!child.pid) continue;
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        }
        rmSync(temp, { recursive: true, force: true });
      }
    },
  );

  it("keeps container names stable so a bot can resume", () => {
    expect(containerNameFor("bot_1")).toBe("rakazo-bot-bot_1");
    expect(containerNameFor("bot_1")).toBe(containerNameFor("bot_1"));
  });

  it("points the screen at the chrome-less noVNC embed", () => {
    expect(screenUrlFor("16080")).toBe("http://127.0.0.1:16080/embed.html");
  });

  it("uses the published host mapping in the default topology even when a container IP exists", () => {
    // Regression: per-bot NetworkMode always yields a 172.x address. Returning
    // that to clients makes local/dev screens look dead — browsers cannot load
    // docker-internal IPs. Probe and return the host mapping instead.
    const networkMode = computerNetworkNameFor("bot_1");
    expect(
      resolveScreenPublishTarget({
        screenNetwork: "published",
        networkMode,
        networks: { [networkMode]: { IPAddress: "172.18.0.4" } },
        hostPort: "49152",
        containerPort: "6080",
      }),
    ).toEqual({ host: "127.0.0.1", port: "49152" });
    expect(
      resolveScreenPublishTarget({
        screenNetwork: "published",
        networkMode,
        networks: { [networkMode]: { IPAddress: "172.18.0.4" } },
        hostPort: undefined,
        containerPort: "6080",
      }),
    ).toBeUndefined();
  });

  it("validates the configured screen network mode", () => {
    expect(resolveScreenNetworkMode(undefined)).toBe("published");
    expect(resolveScreenNetworkMode("published")).toBe("published");
    expect(resolveScreenNetworkMode("isolated")).toBe("isolated");
    expect(() => resolveScreenNetworkMode("typo")).toThrow(/Unsupported/);
  });

  it("uses the host identity for host-run bind mounts without ever using root", () => {
    expect(hostComputerUser(501, 20)).toBe("501:20");
    expect(hostComputerUser(0, 0)).toBe("1000:1000");
  });

  it("uses the container IP only for the internal screen network topology", () => {
    const networkMode = "rakazo_default";
    expect(
      resolveScreenPublishTarget({
        screenNetwork: "internal",
        networkMode,
        networks: { [networkMode]: { IPAddress: "172.18.0.4" } },
        hostPort: "49152",
        containerPort: "6080",
      }),
    ).toEqual({ host: "172.18.0.4", port: "6080" });
    expect(
      resolveScreenPublishTarget({
        screenNetwork: "isolated",
        networkMode: "rakazo-computer-bot-1",
        networks: { "rakazo-computer-bot-1": { IPAddress: "172.20.0.4" } },
        hostPort: "49152",
        containerPort: "6080",
      }),
    ).toEqual({ host: "172.20.0.4", port: "6080" });
  });

  it("does not publish computer control port 7070 on the host", () => {
    const options = containerCreateOptions({
      name: "rakazo-bot-ctrl",
      image: COMPUTER_IMAGE,
      botId: "ctrl",
      spaceId: "ws",
      homePath: "/var/rakazo/homes/ctrl",
    });
    expect(options.HostConfig.PortBindings["7070/tcp"]).toBeUndefined();
    expect(options.ExposedPorts["7070/tcp"]).toBeUndefined();
    expect(JSON.stringify(options.HostConfig.PortBindings)).not.toMatch(/7070/);
  });

  it("publishes the control port to loopback only when explicitly opted in", () => {
    const options = containerCreateOptions({
      name: "rakazo-bot-ctrl",
      image: COMPUTER_IMAGE,
      botId: "ctrl",
      spaceId: "ws",
      homePath: "/var/rakazo/homes/ctrl",
      publishControlPort: true,
    });
    expect(options.ExposedPorts["7070/tcp"]).toEqual({});
    expect(options.HostConfig.PortBindings["7070/tcp"]).toEqual([
      { HostIp: "127.0.0.1", HostPort: "0" },
    ]);
  });

  it("resolves computer control through the container network IP, never a host mapping", () => {
    const networkMode = "rakazo_default";
    expect(
      resolveComputerControlEndpoint({
        token: "secret",
        networkMode,
        networks: { [networkMode]: { IPAddress: "172.18.0.4" } },
      }),
    ).toEqual({ url: "http://172.18.0.4:7070/v1/desktop", token: "secret" });
    expect(
      resolveComputerControlEndpoint({
        token: "secret",
        networkMode: computerNetworkNameFor("bot_1"),
        networks: { [computerNetworkNameFor("bot_1")]: { IPAddress: "172.19.0.2" } },
      }),
    ).toEqual({ url: "http://172.19.0.2:7070/v1/desktop", token: "secret" });
    expect(
      resolveComputerControlEndpoint({
        token: undefined,
        networkMode,
        networks: { [networkMode]: { IPAddress: "172.18.0.4" } },
      }),
    ).toBeUndefined();
    expect(
      resolveComputerControlEndpoint({
        token: "secret",
        networkMode,
        networks: {},
      }),
    ).toBeUndefined();
  });

  it("resolves computer control through a published loopback port when provided", () => {
    const networkMode = "rakazo_default";
    expect(
      resolveComputerControlEndpoint({
        token: "secret",
        networkMode,
        networks: { [networkMode]: { IPAddress: "172.18.0.4" } },
        publishedHostPort: "55101",
      }),
    ).toEqual({ url: "http://127.0.0.1:55101/v1/desktop", token: "secret" });
    expect(
      resolveComputerControlEndpoint({
        token: undefined,
        networkMode,
        networks: { [networkMode]: { IPAddress: "172.18.0.4" } },
        publishedHostPort: "55101",
      }),
    ).toBeUndefined();
  });

  it.each([undefined, null, {}, { "7070/tcp": null }, { "7070/tcp": [] }])(
    "recreates unpublished computers only when loopback control is enabled (%j)",
    (bindings) => {
      expect(controlPortPublicationMatches(bindings, true)).toBe(false);
      expect(controlPortPublicationMatches(bindings, false)).toBe(true);
      expect(publishedLoopbackControlHostPort(bindings)).toBeUndefined();
    },
  );

  it.each(["", "0", "55101"])(
    "accepts configured loopback ports on resume, including unassigned ports (%j)",
    (HostPort) => {
      const bindings = { "7070/tcp": [{ HostIp: "127.0.0.1", HostPort }] };
      expect(controlPortPublicationMatches(bindings, true)).toBe(true);
      // Opting out must remove existing publication on the next provision.
      expect(controlPortPublicationMatches(bindings, false)).toBe(false);
      expect(publishedLoopbackControlHostPort(bindings)).toBe(
        HostPort === "55101" ? HostPort : undefined,
      );
    },
  );

  it.each(["0.0.0.0", "", "::", "192.0.2.1", undefined])(
    "rejects external control bindings even alongside loopback (%j)",
    (HostIp) => {
      const external = { HostIp, HostPort: "55100" };
      const loopback = { HostIp: "127.0.0.1", HostPort: "55101" };
      for (const entries of [[external], [external, loopback], [loopback, external]]) {
        const bindings = { "7070/tcp": entries };
        expect(controlPortPublicationMatches(bindings, true)).toBe(false);
        expect(controlPortPublicationMatches(bindings, false)).toBe(false);
        expect(publishedLoopbackControlHostPort(bindings)).toBeUndefined();
      }
    },
  );

  it.each([undefined, "-1", "65536", "abc", "55101/other", "80@192.0.2.1"])(
    "rejects invalid configured and runtime control ports (%j)",
    (HostPort) => {
      const bindings = { "7070/tcp": [{ HostIp: "127.0.0.1", HostPort }] };
      expect(controlPortPublicationMatches(bindings, true)).toBe(false);
      expect(publishedLoopbackControlHostPort(bindings)).toBeUndefined();
      expect(
        resolveComputerControlEndpoint({
          token: "test-token",
          networkMode: "bridge",
          networks: { bridge: { IPAddress: "192.0.2.1" } },
          publishedHostPort: HostPort,
          requirePublishedHostPort: true,
        }),
      ).toBeUndefined();
    },
  );

  it("does not fall back to the container IP when a published control port is required", () => {
    const networkMode = "rakazo_default";
    expect(
      resolveComputerControlEndpoint({
        token: "secret",
        networkMode,
        networks: { [networkMode]: { IPAddress: "172.18.0.4" } },
        requirePublishedHostPort: true,
      }),
    ).toBeUndefined();
    expect(
      resolveComputerControlEndpoint({
        token: "secret",
        networkMode,
        networks: { [networkMode]: { IPAddress: "172.18.0.4" } },
        publishedHostPort: "55101",
        requirePublishedHostPort: true,
      }),
    ).toEqual({ url: "http://127.0.0.1:55101/v1/desktop", token: "secret" });
  });

  it("restricts computer control argv to supervisor shapes", () => {
    const controlPath = path.resolve(import.meta.dirname, "../../computer/control.py");
    const result = spawnSync(
      "python3",
      [
        "-c",
        [
          "import importlib.util",
          "import os",
          "import signal",
          "import tempfile",
          "import time",
          `spec = importlib.util.spec_from_file_location('control', ${JSON.stringify(controlPath)})`,
          "module = importlib.util.module_from_spec(spec)",
          "spec.loader.exec_module(module)",
          "allow = module.allowed_control_argv",
          "long_lived = module.is_long_lived_control",
          "assert allow(['env', 'DISPLAY=:1', 'xdotool', 'key', '--clearmodifiers', 'a'], ':1')",
          "assert allow(['env', 'DISPLAY=:1', 'xdotool', 'mousemove', '--', '10', '20', 'click', '1'], ':1')",
          "assert allow(['env', 'DISPLAY=:1', 'xdotool', 'click', '--repeat', '3', '4'], ':1')",
          "assert allow(['env', 'DISPLAY=:1', 'xdotool', 'type', '--clearmodifiers', '--', 'hi'], ':1')",
          "assert allow(['env', 'DISPLAY=:2', 'xdg-open', 'https://example.com'], ':2')",
          "assert allow(['env', 'DISPLAY=:1', 'rakazo-browser'], ':1')",
          "assert allow(['env', 'DISPLAY=:2', 'rakazo-browser', 'https://example.com'], ':2')",
          "assert allow(['env', 'DISPLAY=:1', 'xterm'], ':1')",
          "assert long_lived(['env', 'DISPLAY=:1', 'rakazo-browser'])",
          "assert long_lived(['env', 'DISPLAY=:1', 'rakazo-browser', 'https://example.com'])",
          "assert long_lived(['env', 'DISPLAY=:1', 'xterm'])",
          "assert long_lived(['env', 'DISPLAY=:1', 'xdg-open', 'https://example.com'])",
          "assert not long_lived(['env', 'DISPLAY=:1', 'xdotool', 'key', '--clearmodifiers', 'a'])",
          "assert not allow(['env', 'DISPLAY=:1', 'chromium', 'https://example.com'], ':1')",
          "assert not allow(['bash', '-c', 'id'], ':1')",
          "assert not allow(['env', 'DISPLAY=:1', 'bash', '-c', 'id'], ':1')",
          "assert not allow(['env', 'DISPLAY=:1', '/bin/sh', '-c', 'id'], ':1')",
          "assert not allow(['env', 'DISPLAY=:1', 'xdotool', 'exec', '/bin/sh', '-c', 'id'], ':1')",
          "assert not allow(['env', 'DISPLAY=:1', 'xdotool', 'key', 'a'], ':1')",
          "assert not allow(['env', 'DISPLAY=:2', 'xdotool', 'key', '--clearmodifiers', 'a'], ':1')",
          "assert not allow(['env', 'DISPLAY=wayland-0', 'xdotool', 'key', '--clearmodifiers', 'a'], ':1')",
          "assert not allow(['env', 'DISPLAY=:1', 'xdg-open', 'a', 'b'], ':1')",
          "known = set(module.KNOWN_LAUNCH)",
          "module.KNOWN_LAUNCH = frozenset({'sleep'})",
          "spawned = []",
          "real_popen = module.subprocess.Popen",
          "def tracking_popen(*args, **kwargs):",
          "  child = real_popen(*args, **kwargs)",
          "  spawned.append(child.pid)",
          "  return child",
          "module.subprocess.Popen = tracking_popen",
          "try:",
          "  started = time.monotonic()",
          "  module.run_control_argv(['env', 'DISPLAY=:1', 'sleep', '30'], ':1')",
          "  assert time.monotonic() - started < 2",
          "  assert len(spawned) == 1, 'expected one detached child'",
          "  os.kill(spawned[0], 0)",
          "  os.kill(spawned[0], signal.SIGTERM)",
          "finally:",
          "  module.subprocess.Popen = real_popen",
          "  module.KNOWN_LAUNCH = frozenset(known)",
          "try:",
          "  module.run_control_argv(['env', 'DISPLAY=:1', 'false'], ':1')",
          "  raise SystemExit('expected nonzero failure')",
          "except RuntimeError as error:",
          "  assert str(error) == 'computer action failed'",
          "timeout = module.CONTROL_TIMEOUT_SEC",
          "module.CONTROL_TIMEOUT_SEC = 0.2",
          "try:",
          "  module.run_control_argv(['env', 'DISPLAY=:1', 'sleep', '5'], ':1')",
          "  raise SystemExit('expected timeout')",
          "except RuntimeError as error:",
          "  assert str(error) == 'computer action timed out'",
          "finally:",
          "  module.CONTROL_TIMEOUT_SEC = timeout",
          "slow = tempfile.mkdtemp()",
          "launcher = os.path.join(slow, 'rakazo-browser')",
          "open(launcher, 'w').write('#!/bin/sh\\nsleep 0.25\\nexit 1\\n')",
          "os.chmod(launcher, 0o755)",
          "os.environ['PATH'] = slow + os.pathsep + os.environ.get('PATH', '')",
          "try:",
          "  module.run_control_argv(['env', 'DISPLAY=:1', 'rakazo-browser'], ':1')",
          "  raise SystemExit('slow failure looked successful')",
          "except RuntimeError as error:",
          "  assert str(error) == 'computer action failed', str(error)",
          "print('ok')",
        ].join("\n"),
      ],
      { encoding: "utf8" },
    );
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout.trim()).toBe("ok");
  });

  it("turns takeover input into xdotool", () => {
    expect(xdotoolCommand({ kind: "key", key: "Enter" })).toEqual([
      "xdotool",
      "key",
      "--clearmodifiers",
      "Return",
    ]);
    expect(xdotoolCommand({ kind: "pointer", x: 10, y: 20, type: "click" })).toEqual([
      "xdotool",
      "mousemove",
      "--",
      "10",
      "20",
      "click",
      "1",
    ]);
  });
});

describe("computer resource limits", () => {
  const KEYS = [
    "RAKAZO_COMPUTER_MEMORY",
    "RAKAZO_COMPUTER_CPUS",
    "RAKAZO_COMPUTER_PIDS_LIMIT",
  ] as const;
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const k of KEYS) {
      saved.set(k, process.env[k]);
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const createInput = {
    name: "rakazo-bot-x",
    image: "rakazo/computer:local",
    botId: "bot-x",
    spaceId: "ws",
    homePath: "/var/rakazo/homes/bot-x",
  };

  it("caps memory and cpu by default and keeps #343's pids ceiling", () => {
    const { HostConfig } = containerCreateOptions(createInput);
    expect(HostConfig.Memory).toBe(2 * 1024 ** 3);
    expect(HostConfig.MemorySwap).toBe(HostConfig.Memory);
    expect(HostConfig.NanoCpus).toBe(2 * 1e9);
    expect(HostConfig.PidsLimit).toBe(2048);
  });

  it("falls back to the defaults when a variable is blank", () => {
    // .env.example ships these keys blank; a blank value must read as "unset".
    process.env.RAKAZO_COMPUTER_MEMORY = "";
    process.env.RAKAZO_COMPUTER_CPUS = "  ";
    process.env.RAKAZO_COMPUTER_PIDS_LIMIT = "";
    const { HostConfig } = containerCreateOptions(createInput);
    expect(HostConfig.Memory).toBe(2 * 1024 ** 3);
    expect(HostConfig.NanoCpus).toBe(2e9);
    expect(HostConfig.PidsLimit).toBe(2048);
  });

  it("pins MemorySwap to Memory so the ceiling cannot be swapped past", () => {
    process.env.RAKAZO_COMPUTER_MEMORY = "1536m";
    const { HostConfig } = containerCreateOptions(createInput);
    expect(HostConfig.Memory).toBe(1536 * 1024 ** 2);
    expect(HostConfig.MemorySwap).toBe(1536 * 1024 ** 2);
  });

  it("accepts fractional CPUs", () => {
    process.env.RAKAZO_COMPUTER_CPUS = "1.5";
    expect(containerCreateOptions(createInput).HostConfig.NanoCpus).toBe(1_500_000_000);
  });

  it("lets an operator opt out explicitly", () => {
    process.env.RAKAZO_COMPUTER_MEMORY = "unlimited";
    process.env.RAKAZO_COMPUTER_CPUS = "0";
    process.env.RAKAZO_COMPUTER_PIDS_LIMIT = "none";
    const { HostConfig } = containerCreateOptions(createInput);
    expect(HostConfig.Memory).toBe(0);
    expect(HostConfig.NanoCpus).toBe(0);
    expect(HostConfig.PidsLimit).toBe(0);
  });

  it("rejects a malformed size instead of silently falling back", () => {
    process.env.RAKAZO_COMPUTER_MEMORY = "2 gigs";
    expect(() => containerCreateOptions(createInput)).toThrow(/RAKAZO_COMPUTER_MEMORY/);
  });

  it("rejects a negative cpu count", () => {
    process.env.RAKAZO_COMPUTER_CPUS = "-1";
    expect(() => containerCreateOptions(createInput)).toThrow(/RAKAZO_COMPUTER_CPUS/);
  });

  it("rejects a pids limit that is not a positive integer", () => {
    process.env.RAKAZO_COMPUTER_PIDS_LIMIT = "12.5";
    expect(() => containerCreateOptions(createInput)).toThrow(/RAKAZO_COMPUTER_PIDS_LIMIT/);
  });

  it("rejects a memory limit below Docker's 6 MiB minimum", () => {
    // The daemon refuses these at container creation, so accepting them here would turn a typo
    // into a 500 on the first bot rather than a startup failure naming the variable.
    for (const value of ["1", "1m", "5m", "5242880"]) {
      process.env.RAKAZO_COMPUTER_MEMORY = value;
      expect(() => containerCreateOptions(createInput)).toThrow(/RAKAZO_COMPUTER_MEMORY/);
    }
    process.env.RAKAZO_COMPUTER_MEMORY = "6m";
    expect(containerCreateOptions(createInput).HostConfig.Memory).toBe(6 * 1024 ** 2);
  });

  it("rejects a CPU count that would floor to Docker's unlimited", () => {
    // Math.floor(1e-10 * 1e9) is 0, and 0 NanoCpus means uncapped. An accepted value must never
    // turn a ceiling into no ceiling.
    process.env.RAKAZO_COMPUTER_CPUS = "0.0000000001";
    expect(() => containerCreateOptions(createInput)).toThrow(/RAKAZO_COMPUTER_CPUS/);
  });

  it("rejects a CPU count that leaves the safe-integer NanoCpus range", () => {
    // 1e300 is finite, but Math.floor(1e300 * 1e9) is Infinity. 1e7 CPUs yields a non-safe
    // integer. Both must fail closed rather than reach HostConfig.NanoCpus.
    for (const value of ["1e300", "10000000"]) {
      process.env.RAKAZO_COMPUTER_CPUS = value;
      expect(() => containerCreateOptions(createInput)).toThrow(/RAKAZO_COMPUTER_CPUS/);
    }
  });

  it("parses byte counts without a unit suffix", () => {
    expect(parseMemoryBytes("X", "1073741824")).toBe(1024 ** 3);
  });
});

describe("computer home storage", () => {
  const runtime = (mount: object) => ({ Mounts: [mount] }) as Docker.ContainerInspectInfo;
  it("keeps named volumes native and exposes only the bot subdirectory", () => {
    const storage = computerHomeStorage(
      "/data/homes/bot",
      "/data",
      runtime({
        Type: "volume",
        Name: "example_appdata",
        Source: "/var/lib/docker/volumes/example_appdata/_data",
        Destination: "/data",
      }),
    );
    const options = containerCreateOptions({
      name: "bot",
      image: "computer",
      botId: "bot",
      spaceId: "space",
      ...storage,
    });
    expect(options.HostConfig.Binds).toBeUndefined();
    expect(options.HostConfig.Mounts).toEqual([
      {
        Type: "volume",
        Source: "example_appdata",
        Target: "/home/rakazo",
        VolumeOptions: { NoCopy: true, Subpath: "homes/bot" },
      },
    ]);
    expect(homeVolumeMatches(options.HostConfig.Mounts, storage.homeVolume!)).toBe(true);
    expect(homeVolumeMatches(undefined, storage.homeVolume!)).toBe(false);
    expect(
      homeVolumeMatches(options.HostConfig.Mounts, {
        name: "example_appdata",
        subpath: "homes/other",
      }),
    ).toBe(false);
  });
  it("preserves native host paths and translates supervisor bind mounts", () => {
    expect(computerHomeStorage("/data/homes/bot", "/data", undefined)).toEqual({
      homePath: "/data/homes/bot",
    });
    expect(
      computerHomeStorage(
        "/data/homes/bot",
        "/data",
        runtime({ Type: "bind", Source: "/srv/data", Destination: "/data" }),
      ),
    ).toEqual({ homePath: "/srv/data/homes/bot" });
  });
  it("rejects paths outside the volume and missing volume names", () => {
    for (const home of ["/data", "/other", "/data/../other"])
      expect(() => computerHomeStorage(home, "/data", undefined)).toThrow();
    expect(() =>
      computerHomeStorage(
        "/data/homes/bot",
        "/data",
        runtime({ Type: "volume", Destination: "/data" }),
      ),
    ).toThrow(/no name/);
  });
  it("derives the network owner from where computer homes live, without exposing it", () => {
    const volume = (name: string) =>
      runtime({
        Type: "volume",
        Name: name,
        Source: `/var/lib/docker/volumes/${name}/_data`,
        Destination: "/data",
      });
    const owner = computerNetworkOwnerFor("/data", volume("example_appdata"));
    expect(owner).toMatch(/^[0-9a-f]{32}$/);
    expect(computerNetworkOwnerFor("/data", volume("example_appdata"))).toBe(owner);
    expect(computerNetworkOwnerFor("/data", volume("other_appdata"))).not.toBe(owner);
    const hostRun = computerNetworkOwnerFor("/srv/install-a/data", undefined);
    expect(computerNetworkOwnerFor("/srv/install-b/data", undefined)).not.toBe(hostRun);
    expect(
      computerNetworkOwnerFor(
        "/data",
        runtime({ Type: "bind", Source: "/srv/install-a/data", Destination: "/data" }),
      ),
    ).toBe(hostRun);
  });
  it("uses lower gateway priority only when Docker API supports it", () => {
    for (const apiVersion of ["1.45", "1.47", "invalid"]) {
      expect(screenPeerNetworkConnectOptions("peer", apiVersion)).toEqual({ Container: "peer" });
    }
    for (const apiVersion of ["1.48", "1.55", "2.0"]) {
      expect(screenPeerNetworkConnectOptions("peer", apiVersion)).toEqual({
        Container: "peer",
        EndpointConfig: { GwPriority: -1 },
      });
    }
  });

  it("fails closed on daemons that could ignore volume subpaths", () => {
    for (const version of ["1.44", "", "invalid", "0.99"])
      expect(() => assertVolumeSubpathSupport(version)).toThrow(/Docker Engine 26/);
    for (const version of ["1.45", "1.46", "2.0"])
      expect(() => assertVolumeSubpathSupport(version)).not.toThrow();
  });

  it("supervises computer control with a bounded restart delay", () => {
    const start = readFileSync(
      path.resolve(import.meta.dirname, "../../computer/start.sh"),
      "utf8",
    );
    expect(start).toMatch(
      /while true; do\s+\/usr\/local\/bin\/rakazo-computer-control\s+sleep 1\s+done >\/tmp\/rakazo\/control\.log 2>&1 &/,
    );
    // PID 1 terminates both the background loop and its current child on stop.
    expect(start).toContain("kill -TERM -- -1");
  });

  it.skipIf(process.platform === "win32")(
    "restarts computer control after an abnormal exit",
    () => {
      const start = readFileSync(
        path.resolve(import.meta.dirname, "../../computer/start.sh"),
        "utf8",
      );
      const loop = start.match(
        /while true; do[\s\S]*?done >\/tmp\/rakazo\/control\.log 2>&1 &/,
      )?.[0];
      expect(loop).toBeDefined();
      const result = spawnSync(
        "bash",
        [
          "-c",
          [
            "attempts=0",
            "control() { echo control; return 137; }",
            'sleep() { echo "delay $1"; attempts=$((attempts + 1)); if [ "$attempts" -eq 2 ]; then exit 0; fi; }',
            loop
              ?.replace("/usr/local/bin/rakazo-computer-control", "control")
              .replace(" >/tmp/rakazo/control.log 2>&1 &", ""),
          ].join("\n"),
        ],
        { encoding: "utf8", timeout: 5_000 },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("control\ndelay 1\ncontrol\ndelay 1\n");
    },
  );

  it("stops promptly when Docker sends SIGTERM to the start script", () => {
    const root = path.resolve(import.meta.dirname, "../../computer");
    const start = readFileSync(path.join(root, "start.sh"), "utf8");
    expect(start).toMatch(/trap shutdown TERM INT/);
    expect(start).toMatch(/kill -TERM "\$XVFB_PID"/);
    expect(start).not.toMatch(/while kill -0 "\$XVFB_PID"/);
    // The handler must be in place before the first child process starts, so a stop that
    // arrives during startup is honoured instead of waiting for Docker's grace period.
    const trapAt = start.indexOf("trap shutdown TERM INT");
    const firstChildAt = start.search(/^[^#\n]*&\s*$/m);
    expect(trapAt).toBeGreaterThan(-1);
    expect(firstChildAt).toBeGreaterThan(-1);
    expect(trapAt).toBeLessThan(firstChildAt);
    // A stop before Xvfb exists must not try to signal or wait on an empty PID.
    expect(start).toMatch(/^XVFB_PID=""$/m);
    expect(start.match(/if \[\[ -n "\$XVFB_PID" \]\]; then/g)?.length ?? 0).toBeGreaterThanOrEqual(
      2,
    );
    // Steady state waits on Xvfb instead of polling, so the trap runs immediately.
    expect(start).toMatch(/^wait "\$XVFB_PID"$/m);
  });
});
