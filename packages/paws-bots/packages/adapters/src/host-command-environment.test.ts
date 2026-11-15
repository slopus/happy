import { describe, expect, it } from "vitest";
import { hostCommandEnvironment } from "./sandbox-command-environment.js";

describe("host command environment", () => {
  it("keeps only shell variables from the host, then applies the request", () => {
    const inherited = {
      PATH: "/usr/bin:/bin",
      HOME: "/fake-home",
      USER: "fake-user",
      SHELL: "/bin/zsh",
      LANG: "en_US.UTF-8",
      LC_CTYPE: "UTF-8",
      TMPDIR: "/fake-tmp",
      https_proxy: "http://proxy.invalid:3128",
      SSH_AUTH_SOCK: "/fake-tmp/agent.sock",
      NODE_EXTRA_CA_CERTS: "/fake-home/ca.pem",
      DATABASE_URL: "postgres://fake:fake@127.0.0.1/fake",
      ENCRYPTION_KEY: "fake-encryption-key",
      BETTER_AUTH_SECRET: "fake-auth-secret",
      OPENAI_API_KEY: "fake-provider-key",
    };
    expect(
      hostCommandEnvironment(
        { env: { BOT_TOKEN: "fake-bot-token", LANG: "C" }, unsetEnv: ["TMPDIR"] },
        inherited,
      ),
    ).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: "/fake-home",
      USER: "fake-user",
      SHELL: "/bin/zsh",
      LANG: "C",
      LC_CTYPE: "UTF-8",
      https_proxy: "http://proxy.invalid:3128",
      SSH_AUTH_SOCK: "/fake-tmp/agent.sock",
      NODE_EXTRA_CA_CERTS: "/fake-home/ca.pem",
      BOT_TOKEN: "fake-bot-token",
    });
  });

  it("keeps Windows system variables whatever their case", () => {
    expect(
      hostCommandEnvironment(
        { env: {} },
        {
          Path: "C:\\Windows\\system32",
          SystemRoot: "C:\\Windows",
          ComSpec: "C:\\Windows\\system32\\cmd.exe",
          PATHEXT: ".COM;.EXE",
          USERPROFILE: "C:\\Users\\fake",
          APPDATA: "C:\\Users\\fake\\AppData\\Roaming",
          "ProgramFiles(x86)": "C:\\Program Files (x86)",
          DATABASE_URL: "postgres://fake:fake@127.0.0.1/fake",
        },
      ),
    ).toEqual({
      Path: "C:\\Windows\\system32",
      SystemRoot: "C:\\Windows",
      ComSpec: "C:\\Windows\\system32\\cmd.exe",
      PATHEXT: ".COM;.EXE",
      USERPROFILE: "C:\\Users\\fake",
      APPDATA: "C:\\Users\\fake\\AppData\\Roaming",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
    });
  });
});
