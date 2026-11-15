import { afterEach, describe, expect, it } from "vitest";
import {
  assertAllowedOpenAiCompatibleRequestUrl,
  assertAllowedOpenAiCompatibleUrl,
  assertHttpsForKeyedOpenAiCompatibleUrl,
  normalizeOpenAiCompatibleBaseUrl,
  openAiCompatAllowPublicHosts,
  PRIVATE_MODEL_ENDPOINT_MESSAGE,
} from "./openai-compatible-url.js";

const OWNER = { allowPrivate: true };

const savedAllowPublic = process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC;
const savedPrivateHosts = process.env.RAKAZO_OPENAI_COMPAT_PRIVATE_HOSTS;

afterEach(() => {
  if (savedAllowPublic === undefined) delete process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC;
  else process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC = savedAllowPublic;
  if (savedPrivateHosts === undefined) delete process.env.RAKAZO_OPENAI_COMPAT_PRIVATE_HOSTS;
  else process.env.RAKAZO_OPENAI_COMPAT_PRIVATE_HOSTS = savedPrivateHosts;
});

describe("openai-compatible URL policy", () => {
  it("validates request URLs without changing their path", () => {
    expect(
      assertAllowedOpenAiCompatibleRequestUrl("http://127.0.0.1:8000/v1/chat/completions", OWNER)
        .href,
    ).toBe("http://127.0.0.1:8000/v1/chat/completions");
  });

  it("rejects non-http(s) and credential-bearing URLs", () => {
    expect(() => normalizeOpenAiCompatibleBaseUrl("file:///tmp/sock")).toThrow(/http or https/);
    expect(() => normalizeOpenAiCompatibleBaseUrl("http://user:pass@127.0.0.1:8000/v1")).toThrow(
      /credentials/,
    );
    expect(() => assertAllowedOpenAiCompatibleRequestUrl("file:///tmp/sock", OWNER)).toThrow(
      /http or https/,
    );
  });

  const privateUrls = [
    "http://127.0.0.1:8000/v1",
    "http://localhost:11434/v1",
    "http://192.168.1.20:8080/v1",
    "http://10.0.0.8:8000/v1",
    "http://[fd00::1]:8000/v1",
    "http://host.docker.internal:8000/v1",
  ];

  it("allows loopback, RFC1918, ULA and Docker host endpoints when private endpoints are allowed", () => {
    process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC = "0";
    for (const raw of privateUrls) {
      expect(assertAllowedOpenAiCompatibleUrl(raw, OWNER).href).toBe(raw);
    }
    expect(() => assertAllowedOpenAiCompatibleUrl("http://ollama.local:11434/v1", OWNER)).toThrow(
      /Public model endpoints are disabled/,
    );
  });

  it("refuses private endpoints unless they are allowed, even with public hosts open", () => {
    process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC = "1";
    for (const raw of privateUrls) {
      for (const policy of [undefined, {}, { allowPrivate: false }]) {
        expect(() => assertAllowedOpenAiCompatibleUrl(raw, policy)).toThrow(
          PRIVATE_MODEL_ENDPOINT_MESSAGE,
        );
        expect(() => assertAllowedOpenAiCompatibleRequestUrl(`${raw}/models`, policy)).toThrow(
          PRIVATE_MODEL_ENDPOINT_MESSAGE,
        );
      }
    }
    expect(() => assertAllowedOpenAiCompatibleUrl("http://192.168.1.20:1234/v1")).toThrow(
      "MCP_ALLOW_PRIVATE_ENDPOINT=true on the API and worker",
    );
  });

  it("blocks metadata and link-local endpoints even when private endpoints are allowed", () => {
    for (const raw of ["http://169.254.169.254/latest/meta-data/", "http://[fe80::1]/v1"]) {
      expect(() => assertAllowedOpenAiCompatibleUrl(raw, OWNER)).toThrow(
        /blocked metadata or link-local host/,
      );
    }
  });

  it("blocks metadata and link-local endpoints", () => {
    expect(() =>
      assertAllowedOpenAiCompatibleUrl("http://169.254.169.254/latest/meta-data/"),
    ).toThrow(/blocked metadata or link-local host/);
    expect(() => assertAllowedOpenAiCompatibleUrl("http://169.254.1.1/v1")).toThrow(
      /blocked metadata or link-local host/,
    );
    expect(() => assertAllowedOpenAiCompatibleUrl("http://[fe80::1]/v1")).toThrow(
      /blocked metadata or link-local host/,
    );
    expect(() => assertAllowedOpenAiCompatibleUrl("http://[::ffff:169.254.1.1]/v1")).toThrow(
      /blocked metadata or link-local host/,
    );
    expect(() => assertAllowedOpenAiCompatibleUrl("http://[::169.254.1.1]/v1")).toThrow(
      /blocked metadata or link-local host/,
    );
    expect(() => assertAllowedOpenAiCompatibleUrl("http://metadata.google.internal/")).toThrow(
      /blocked metadata or link-local host/,
    );
    expect(() =>
      assertAllowedOpenAiCompatibleUrl("http://100.100.100.200/latest/meta-data/"),
    ).toThrow(/blocked metadata or link-local host/);
    expect(() =>
      assertAllowedOpenAiCompatibleUrl("http://[::ffff:100.100.100.200]/latest/meta-data/"),
    ).toThrow(/blocked metadata or link-local host/);
    expect(() =>
      assertAllowedOpenAiCompatibleUrl("http://[fd00:ec2::254]/latest/meta-data/"),
    ).toThrow(/blocked metadata or link-local host/);
    expect(() =>
      assertAllowedOpenAiCompatibleUrl(
        "http://[fd00:0ec2:0000:0000:0000:0000:0000:0254]/latest/meta-data/",
      ),
    ).toThrow(/blocked metadata or link-local host/);
  });

  it("allows only exact configured private hostnames without opening the public gate", () => {
    process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC = "0";
    process.env.RAKAZO_OPENAI_COMPAT_PRIVATE_HOSTS =
      " Models.Example.Test. , other.example.test, , *.wild.example.test";
    for (const hostname of ["models.example.test", "MODELS.EXAMPLE.TEST.", "other.example.test"]) {
      expect(assertAllowedOpenAiCompatibleUrl(`https://${hostname}/v1`, OWNER).hostname).toBe(
        hostname.toLowerCase(),
      );
    }
    for (const hostname of [
      "sub.models.example.test",
      "models.example.test.evil.test",
      "example.test",
      "sub.wild.example.test",
    ]) {
      expect(() => assertAllowedOpenAiCompatibleUrl(`https://${hostname}/v1`)).toThrow(
        /Public model endpoints are disabled/,
      );
    }
  });

  it("requires private endpoint permission for allowlisted hostnames", () => {
    process.env.RAKAZO_OPENAI_COMPAT_PRIVATE_HOSTS = "models.example.test";
    expect(() => assertAllowedOpenAiCompatibleUrl("http://models.example.test/v1")).toThrow(
      PRIVATE_MODEL_ENDPOINT_MESSAGE,
    );
  });

  it("does not let the private hostname allowlist override blocked destinations", () => {
    process.env.RAKAZO_OPENAI_COMPAT_PRIVATE_HOSTS =
      "metadata.google.internal, metadata.goog, 169.254.169.254, 169.254.1.1";
    for (const hostname of [
      "metadata.google.internal",
      "metadata.goog",
      "169.254.169.254",
      "169.254.1.1",
    ]) {
      expect(() => assertAllowedOpenAiCompatibleUrl(`http://${hostname}/v1`)).toThrow(
        /blocked metadata or link-local host/,
      );
    }
  });

  it("allows public hosts unless the operator sets 0", () => {
    delete process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC;
    expect(openAiCompatAllowPublicHosts()).toBe(true);
    expect(assertAllowedOpenAiCompatibleUrl("https://api.example.com/v1").href).toBe(
      "https://api.example.com/v1",
    );

    process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC = "0";
    expect(openAiCompatAllowPublicHosts()).toBe(false);
    expect(() => assertAllowedOpenAiCompatibleUrl("https://api.example.com/v1")).toThrow(
      /Public model endpoints are disabled/,
    );
  });
});

describe("assertHttpsForKeyedOpenAiCompatibleUrl", () => {
  it("rejects public http when an API key is set", () => {
    process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC = "1";
    const url = assertAllowedOpenAiCompatibleUrl("http://api.example.com/v1");
    expect(() => assertHttpsForKeyedOpenAiCompatibleUrl(url, "secret-key")).toThrow(
      /must use HTTPS/,
    );
  });

  it("allows public https when an API key is set", () => {
    process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC = "1";
    const url = assertAllowedOpenAiCompatibleUrl("https://api.example.com/v1");
    expect(() => assertHttpsForKeyedOpenAiCompatibleUrl(url, "secret-key")).not.toThrow();
  });

  it("allows private http when an API key is set", () => {
    const url = assertAllowedOpenAiCompatibleUrl("http://127.0.0.1:8000/v1", OWNER);
    expect(() => assertHttpsForKeyedOpenAiCompatibleUrl(url, "local-secret")).not.toThrow();
    const lan = assertAllowedOpenAiCompatibleUrl("http://192.168.1.20:8080/v1", OWNER);
    expect(() => assertHttpsForKeyedOpenAiCompatibleUrl(lan, "local-secret")).not.toThrow();
  });

  it("treats explicitly trusted private hostnames like private IP endpoints", () => {
    process.env.RAKAZO_OPENAI_COMPAT_PRIVATE_HOSTS = "models.example.test";
    const url = assertAllowedOpenAiCompatibleUrl("http://models.example.test/v1", OWNER);
    expect(() => assertHttpsForKeyedOpenAiCompatibleUrl(url, "fake-local-key")).not.toThrow();
  });

  it("skips the HTTPS check when no API key is set", () => {
    process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC = "1";
    const url = assertAllowedOpenAiCompatibleUrl("http://api.example.com/v1");
    expect(() => assertHttpsForKeyedOpenAiCompatibleUrl(url, undefined)).not.toThrow();
    expect(() => assertHttpsForKeyedOpenAiCompatibleUrl(url, "  ")).not.toThrow();
  });
});

it("keeps API-key-only HTTPS copy separate from header-aware copy", () => {
  const url = new URL("http://models.example/v1");
  expect(() => assertHttpsForKeyedOpenAiCompatibleUrl(url, "key")).toThrow(
    "OpenAI-compatible endpoints that send an API key must use HTTPS.",
  );
  expect(() => assertHttpsForKeyedOpenAiCompatibleUrl(url, undefined, true)).toThrow(
    "OpenAI-compatible endpoints that send an API key or custom headers must use HTTPS.",
  );
});
