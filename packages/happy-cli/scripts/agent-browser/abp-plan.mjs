#!/usr/bin/env node
// Command-line face of lib/abpPlan.mjs for abp-install (bash): prints generated
// files and tables on stdout. Reads only the files named on the command line.
// Never prints a secret except `secret`, whose output the installer writes
// straight into the target file.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  chromiumSeccompProfile, daemonEnv, egressRules, egressRulesFile, firewallRulesFile, mergeInstallOptions, permissionTable, runtimeConfig, stackLayout,
  sudoersDropIn, systemdUnits, tmpfilesConf,
} from "./lib/abpPlan.mjs";

function readJson(path, what) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`${what} is unreadable or not JSON`);
  }
}

/** abp-install flags that set install options (see README). */
export function parseOptionFlags(argv) {
  const flags = {};
  const list = (key, value) => { (flags[key] ??= []).push(value); };
  const pair = (value, name) => {
    const index = value.indexOf("=");
    if (index <= 0 || index === value.length - 1) throw new Error(`${name} must be <name>=<value>`);
    return [value.slice(0, index), value.slice(index + 1)];
  };
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i];
    const value = argv[++i];
    if (value === undefined) throw new Error(`${name} needs a value`);
    switch (name) {
      case "--machine-id": flags.machineId = value; break;
      case "--workspace-id": flags.workspaceId = value; break;
      case "--profile": { const [profileId, principalId] = pair(value, name); list("profiles", { profileId, principalId }); break; }
      case "--agent-profile": flags.agentProfileId = value; break;
      case "--issuer": {
        const [kid, file] = pair(value, name);
        let publicKeyPem;
        try { publicKeyPem = readFileSync(file, "utf8"); } catch { throw new Error(`--issuer ${kid}: public key file is unreadable`); }
        list("issuers", { kid, publicKeyPem });
        break;
      }
      case "--sites": flags.sites = readJson(value, "--sites file"); break;
      case "--runtime-port": flags.runtimePort = Number(value); break;
      case "--max-agent-windows": flags.maxAgentWindows = Number(value); break;
      case "--retention-days": flags.retentionDays = Number(value); break;
      case "--viewer-origin": list("viewerOrigins", value); break;
      case "--egress-domain": list("egressDomains", value); break;
      case "--happy-prefix": flags.happyPrefix = value; break;
      case "--browser-subnet-pool": flags.browserSubnetPool = value; break;
      case "--deny-cidr": list("denyCidrs", value); break;
      case "--test-allow-cidr": list("testAllowCidrs", value); break;
      case "--browser-dns": list("browserDns", value); break;
      default: throw new Error(`unknown option ${name}`);
    }
  }
  return flags;
}

/**
 * Content digest of an installed package tree: relative path, type, permission bits, file content
 * hash and symlink target of every entry, in a fixed order. Timestamps and ownership are ignored.
 */
export function packageDigest(root) {
  const lines = [];
  const walk = (relative) => {
    for (const name of readdirSync(join(root, relative)).sort()) {
      const path = relative ? `${relative}/${name}` : name;
      const stat = lstatSync(join(root, path));
      const mode = (stat.mode & 0o7777).toString(8);
      if (stat.isSymbolicLink()) lines.push(`L ${mode} ${path} ${readlinkSync(join(root, path))}`);
      else if (stat.isDirectory()) { lines.push(`D ${mode} ${path}`); walk(path); }
      else if (stat.isFile()) lines.push(`F ${mode} ${path} ${createHash("sha256").update(readFileSync(join(root, path))).digest("hex")}`);
      else lines.push(`O ${mode} ${path}`);
    }
  };
  walk("");
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

function option(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0 || argv[index + 1] === undefined) throw new Error(`${name} is required`);
  return argv[index + 1];
}

export function main(argv, out = (text) => process.stdout.write(text)) {
  const [command, ...args] = argv;
  switch (command) {
    case "install-options": {
      // install-options --saved <install.json (may be absent)> [flags...]
      const saved = existsSync(option(args, "--saved")) ? readJson(option(args, "--saved"), "saved install options") : undefined;
      const rest = args.slice(2);
      const flags = parseOptionFlags(rest);
      // "auto" is resolved from the agent's Happy settings after the users exist.
      const merged = mergeInstallOptions(saved, { ...flags, machineId: flags.machineId ?? saved?.machineId ?? "auto" });
      return out(`${JSON.stringify(merged, null, 2)}\n`);
    }
    case "resolve-machine-id": {
      // resolve-machine-id --install <file> --settings <agent ~/.happy/settings.json>: prints the id or nothing.
      const install = readJson(option(args, "--install"), "install options");
      if (install.machineId !== "auto") return out(`${install.machineId}\n`);
      const settingsPath = option(args, "--settings");
      const settings = existsSync(settingsPath) ? readJson(settingsPath, "Happy settings") : {};
      return typeof settings.machineId === "string" && settings.machineId ? out(`${settings.machineId}\n`) : undefined;
    }
    case "runtime-config": {
      // runtime-config --install <file> --machine-id <id> --session-gid <n> --daemon-token-file <path>
      const install = { ...readJson(option(args, "--install"), "install options"), machineId: option(args, "--machine-id") };
      const token = readFileSync(option(args, "--daemon-token-file"), "utf8").trim();
      if (token.length < 32) throw new Error("daemon token file is too short");
      const config = runtimeConfig(install, { sessionGid: Number(option(args, "--session-gid")), daemonTokenSha256: createHash("sha256").update(token).digest("hex") });
      return out(`${JSON.stringify(config, null, 2)}\n`);
    }
    case "daemon-env": return out(daemonEnv(readJson(option(args, "--install"), "install options")));
    case "egress-policy": {
      const { egressDomains } = readJson(option(args, "--install"), "install options");
      return egressDomains.length ? out(`${JSON.stringify({ allowedDomains: egressDomains }, null, 2)}\n`) : undefined;
    }
    case "firewall": return out(firewallRulesFile(Number(option(args, "--family")), Number(option(args, "--sbx-uid")), Number(option(args, "--proxy-uid"))));
    case "egress": {
      const install = readJson(option(args, "--install"), "install options");
      return out(egressRulesFile(egressRules(stackLayout(install), install)[Number(option(args, "--family"))]));
    }
    case "permissions": return out(permissionTable().map((row) => [row.path, row.type, row.owner, row.group, row.mode].join("\t")).join("\n") + "\n");
    case "sudoers": return out(sudoersDropIn());
    case "tmpfiles": return out(tmpfilesConf());
    case "unit": {
      const unit = systemdUnits({ happyPrefix: readJson(option(args, "--install"), "install options").happyPrefix })[option(args, "--name")];
      if (!unit) throw new Error("unknown unit");
      return out(unit);
    }
    case "units": return out(`${Object.keys(systemdUnits()).join("\n")}\n`);
    case "package-digest": return out(`${packageDigest(option(args, "--dir"))}\n`);
    case "seccomp": return out(`${JSON.stringify(chromiumSeccompProfile(readJson(option(args, "--base"), "seccomp base")), null, 2)}\n`);
    case "secret": {
      const kind = args[0];
      if (kind === "daemon-token") return out(randomBytes(32).toString("hex"));
      // RFB (VNC) authentication uses at most 8 characters.
      if (kind === "vnc-password") return out(randomBytes(6).toString("base64url"));
      throw new Error("unknown secret kind");
    }
    default: throw new Error(`unknown command ${command ?? ""}`.trim());
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`abp-plan: ${error instanceof Error ? error.message : "failed"}\n`);
    process.exit(1);
  }
}
