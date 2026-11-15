import { McpServerConfigInput } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { buildMcpUpdateMaterial as buildFromParsed } from "./mcp-material.js";

// The router parses an update before building its material, so the tests do too.
const buildMcpUpdateMaterial = (
  existing: Parameters<typeof buildFromParsed>[0],
  input: unknown,
  options?: Parameters<typeof buildFromParsed>[2],
) => buildFromParsed(existing, McpServerConfigInput.parse(input), options);

describe("buildMcpUpdateMaterial", () => {
  it("keeps the stored blob untouched when the update carries no credential data", () => {
    expect(
      buildMcpUpdateMaterial(
        {},
        {
          transport: "streamable_http",
          slug: "x",
          name: "x",
          endpoint: "https://mcp.example.test",
          headers: {},
        },
      ),
    ).toEqual({ action: "keep" });
  });

  it("clears a stored blob that holds only an empty env record", () => {
    expect(
      buildMcpUpdateMaterial(
        { env: {} },
        { transport: "stdio", slug: "x", name: "x", command: "/bin/mcp", args: [], env: {} },
      ),
    ).toEqual({ action: "store", material: {} });
  });

  it("clears a stored blob that holds only an empty headers record", () => {
    expect(
      buildMcpUpdateMaterial(
        { headers: {} },
        {
          transport: "streamable_http",
          slug: "x",
          name: "x",
          endpoint: "https://mcp.example.test",
          headers: {},
        },
      ),
    ).toEqual({ action: "store", material: {} });
  });

  it("clears an empty headers record left behind when a command change drops the arguments", () => {
    // A remote server that became stdio can hold `{ headers: {}, args }`; once the new
    // command discards the arguments, nothing real is left to store.
    expect(
      buildMcpUpdateMaterial(
        { headers: {}, args: ["--token", "old"] },
        { transport: "stdio", slug: "x", name: "x", command: "/bin/other", args: [], env: {} },
        { commandChanged: true },
      ),
    ).toEqual({ action: "store", material: {} });
  });

  it("clears the credential when an update removes every stored header", () => {
    expect(
      buildMcpUpdateMaterial(
        { headers: { Authorization: "Bearer fake-token" } },
        {
          transport: "streamable_http",
          slug: "x",
          name: "x",
          endpoint: "https://mcp.example.test",
          headers: {},
        },
      ),
    ).toEqual({ action: "store", material: {} });
  });

  it("keeps a material without container keys when nothing is supplied", () => {
    // A secret-less row reaches the builder as {} or with only synthesized empty
    // arguments; keep must stay keep so the caller neither stores nor clears a row.
    expect(
      buildMcpUpdateMaterial(
        { args: [] },
        { transport: "stdio", slug: "x", name: "x", command: "/bin/mcp", args: [], env: {} },
      ),
    ).toEqual({ action: "keep" });
  });

  it("stores a merged blob when a new secret is supplied, preserving OAuth state", () => {
    const existing = { secret: "old-token", oauth: { tokens: { access_token: "t" } } };
    const result = buildMcpUpdateMaterial(existing, {
      transport: "streamable_http",
      slug: "x",
      name: "x",
      endpoint: "https://mcp.example.test",
      headers: {},
      secret: "new-token",
    });
    expect(result).toEqual({
      action: "store",
      material: { secret: "new-token", oauth: { tokens: { access_token: "t" } } },
    });
  });

  it("persists env/headers even without any static secret (no silent drop)", () => {
    const result = buildMcpUpdateMaterial(
      {},
      {
        transport: "stdio",
        slug: "x",
        name: "x",
        command: "/bin/mcp",
        env: { API_KEY: "k" },
      },
    );
    expect(result).toEqual({ action: "store", material: { env: { API_KEY: "k" } } });
  });

  it("keeps a stored value sent back blank, and drops a name no longer sent", () => {
    const stored = {
      env: { API_KEY: "stored-key", OLD: "old" },
      files: { CREDS: "stored-file" },
      headers: { Authorization: "stored-header" },
    };
    expect(
      buildMcpUpdateMaterial(stored, {
        transport: "stdio",
        slug: "x",
        name: "x",
        command: "/bin/mcp",
        env: { API_KEY: "", REGION: "eu" },
        files: { CREDS: "" },
      }),
    ).toEqual({
      action: "store",
      material: {
        env: { API_KEY: "stored-key", REGION: "eu" },
        files: { CREDS: "stored-file" },
        headers: { Authorization: "stored-header" },
      },
    });
    expect(
      buildMcpUpdateMaterial(stored, {
        transport: "streamable_http",
        slug: "x",
        name: "x",
        endpoint: "https://mcp.example.test",
        headers: { Authorization: "", "X-Team": "t" },
      }),
    ).toMatchObject({
      action: "store",
      material: { headers: { Authorization: "stored-header", "X-Team": "t" } },
    });
  });

  it("never carries a stored header over to a new endpoint", () => {
    const update = buildMcpUpdateMaterial(
      { headers: { Authorization: "stored-header" } },
      {
        transport: "streamable_http",
        slug: "x",
        name: "x",
        endpoint: "https://other.example.test",
        headers: { Authorization: "" },
      },
      { clearOAuth: true, endpointChanged: true },
    );
    expect(JSON.stringify(update)).not.toContain("stored-header");
  });

  it("clearing removes static credentials but keeps OAuth state", () => {
    const existing = { secret: "token", env: { A: "b" }, oauth: { tokens: { access_token: "t" } } };
    const result = buildMcpUpdateMaterial(existing, {
      transport: "streamable_http",
      slug: "x",
      name: "x",
      endpoint: "https://mcp.example.test",
      headers: {},
      clearCredential: true,
    });
    expect(result).toEqual({
      action: "store",
      material: { oauth: { tokens: { access_token: "t" } } },
    });
  });

  it("clearing with no OAuth state yields an empty blob so the caller can delete the secret row", () => {
    const result = buildMcpUpdateMaterial(
      { secret: "token" },
      {
        transport: "streamable_http",
        slug: "x",
        name: "x",
        endpoint: "https://mcp.example.test",
        headers: {},
        clearCredential: true,
      },
    );
    expect(result).toEqual({ action: "store", material: {} });
  });

  it("clears endpoint-bound OAuth state while preserving static credentials", () => {
    const result = buildMcpUpdateMaterial(
      { secret: "token", oauth: { tokens: { access_token: "endpoint-token" } } },
      {
        transport: "streamable_http",
        slug: "x",
        name: "x",
        endpoint: "https://new-mcp.example.test",
        headers: {},
      },
      { clearOAuth: true },
    );
    expect(result).toEqual({
      action: "store",
      material: { secret: "token" },
    });
  });

  it("deletes an OAuth-only blob when its endpoint changes", () => {
    const result = buildMcpUpdateMaterial(
      { oauth: { tokens: { access_token: "endpoint-token" } } },
      {
        transport: "streamable_http",
        slug: "x",
        name: "x",
        endpoint: "https://new-mcp.example.test",
        headers: {},
      },
      { clearOAuth: true },
    );
    expect(result).toEqual({ action: "store", material: {} });
  });

  describe("pre-registered OAuth client", () => {
    const remote = {
      transport: "streamable_http" as const,
      slug: "x",
      name: "x",
      endpoint: "https://mcp.example.test",
      headers: {},
    };
    const connected = {
      oauthClient: { client_id: "client-a", client_secret: "secret-a" },
      oauth: { tokens: { access_token: "t" } },
    };

    it("stores extra authorization parameters and treats a change as a new client", () => {
      const stored = {
        oauthClient: { client_id: "client-a", authorization_params: "access_type=offline" },
        oauth: { tokens: { access_token: "t" } },
      };
      expect(
        buildMcpUpdateMaterial(stored, {
          ...remote,
          oauthClient: { clientId: "client-a", authorizationParams: "access_type=offline" },
        }),
      ).toEqual({ action: "store", material: { ...stored } });
      expect(
        buildMcpUpdateMaterial(stored, {
          ...remote,
          oauthClient: {
            clientId: "client-a",
            authorizationParams: "access_type=offline&prompt=consent",
          },
        }),
      ).toEqual({
        action: "store",
        material: {
          oauthClient: {
            client_id: "client-a",
            authorization_params: "access_type=offline&prompt=consent",
          },
        },
      });
    });

    it("stores a client supplied on update", () => {
      expect(
        buildMcpUpdateMaterial(
          {},
          { ...remote, oauthClient: { clientId: "client-a", clientSecret: "secret-a" } },
        ),
      ).toEqual({
        action: "store",
        material: {
          oauthClient: { client_id: "client-a", client_secret: "secret-a" },
        },
      });
    });

    it("keeps the client and its grant when the update leaves the client out", () => {
      expect(buildMcpUpdateMaterial(connected, remote)).toEqual({
        action: "store",
        material: { ...connected },
      });
    });

    it("keeps the stored secret and grant when the same client ID is resent without one", () => {
      expect(
        buildMcpUpdateMaterial(connected, { ...remote, oauthClient: { clientId: "client-a" } }),
      ).toEqual({ action: "store", material: { ...connected } });
    });

    it("drops the grant when the client changes, since its tokens belong to the old client", () => {
      expect(
        buildMcpUpdateMaterial(connected, {
          ...remote,
          oauthClient: { clientId: "client-b", clientSecret: "secret-b" },
        }),
      ).toEqual({
        action: "store",
        material: {
          oauthClient: { client_id: "client-b", client_secret: "secret-b" },
        },
      });
    });

    it("does not carry the old secret over to a different client ID", () => {
      expect(
        buildMcpUpdateMaterial(connected, { ...remote, oauthClient: { clientId: "client-b" } }),
      ).toEqual({
        action: "store",
        material: { oauthClient: { client_id: "client-b" } },
      });
    });

    it("keeps the client's authorization server binding until the client changes", () => {
      const bound = {
        oauthClient: {
          client_id: "client-a",
          client_secret: "secret-a",
          authorization_server: "https://auth.example.test/",
        },
      };
      expect(
        buildMcpUpdateMaterial(bound, { ...remote, oauthClient: { clientId: "client-a" } }),
      ).toEqual({ action: "store", material: { ...bound } });
      expect(
        buildMcpUpdateMaterial(bound, {
          ...remote,
          oauthClient: { clientId: "client-a", clientSecret: "rotated" },
        }),
      ).toEqual({
        action: "store",
        material: { oauthClient: { client_id: "client-a", client_secret: "rotated" } },
      });
    });

    it("removes the client and its grant when the update clears it", () => {
      expect(buildMcpUpdateMaterial(connected, { ...remote, oauthClient: null })).toEqual({
        action: "store",
        material: {},
      });
    });

    it("stores the scope and drops it when the update leaves it empty", () => {
      expect(
        buildMcpUpdateMaterial(
          {},
          { ...remote, oauthClient: { clientId: "client-a", scope: "mail.read mail.send" } },
        ),
      ).toEqual({
        action: "store",
        material: {
          oauthClient: { client_id: "client-a", scope: "mail.read mail.send" },
        },
      });
      expect(
        buildMcpUpdateMaterial({}, { ...remote, oauthClient: { clientId: "client-a", scope: "" } }),
      ).toEqual({
        action: "store",
        material: { oauthClient: { client_id: "client-a" } },
      });
    });

    it("drops the grant when the scope changes, since its tokens carry the old scope", () => {
      const scoped = {
        oauthClient: { client_id: "client-a", client_secret: "secret-a", scope: "mail.read" },
        oauth: { tokens: { access_token: "t" } },
      };
      expect(
        buildMcpUpdateMaterial(scoped, {
          ...remote,
          oauthClient: { clientId: "client-a", scope: "mail.read mail.send" },
        }),
      ).toEqual({
        action: "store",
        material: {
          oauthClient: {
            client_id: "client-a",
            client_secret: "secret-a",
            scope: "mail.read mail.send",
          },
        },
      });
    });

    describe("stdio authorization server", () => {
      const stdio = {
        transport: "stdio" as const,
        slug: "x",
        name: "x",
        command: "/bin/mcp",
        env: { TOKEN: "{{oauth.access_token}}" },
      };
      const bound = {
        oauthClient: {
          client_id: "client-a",
          client_secret: "secret-a",
          authorization_server: "https://accounts.example.test/",
          scope: "mail.read",
        },
        oauth: { tokens: { access_token: "t" } },
      };
      const sameClient = {
        clientId: "client-a",
        scope: "mail.read",
        authorizationServer: "https://accounts.example.test",
      };

      it("stores the normalized authorization server", () => {
        expect(buildMcpUpdateMaterial({}, { ...stdio, oauthClient: sameClient })).toEqual({
          action: "store",
          material: {
            env: stdio.env,
            oauthClient: {
              client_id: "client-a",
              scope: "mail.read",
              authorization_server: "https://accounts.example.test/",
            },
          },
        });
      });

      it("keeps the grant when the same client is resent unchanged", () => {
        expect(buildMcpUpdateMaterial(bound, { ...stdio, oauthClient: sameClient })).toEqual({
          action: "store",
          material: { ...bound, env: stdio.env },
        });
      });

      it("drops the grant when the authorization server changes", () => {
        expect(
          buildMcpUpdateMaterial(bound, {
            ...stdio,
            oauthClient: { ...sameClient, authorizationServer: "https://login.example.test" },
          }),
        ).toEqual({
          action: "store",
          material: {
            env: stdio.env,
            oauthClient: {
              client_id: "client-a",
              client_secret: "secret-a",
              scope: "mail.read",
              authorization_server: "https://login.example.test/",
            },
          },
        });
      });
    });

    it("keeps a remote client's first-use binding when the same client is resent", () => {
      const bound = {
        oauthClient: {
          client_id: "client-a",
          scope: "mail.read",
          authorization_server: "https://auth.example.test/",
        },
        oauth: { tokens: { access_token: "t" } },
      };
      expect(
        buildMcpUpdateMaterial(bound, {
          ...remote,
          oauthClient: { clientId: "client-a", scope: "mail.read" },
        }),
      ).toEqual({ action: "store", material: { ...bound } });
    });

    it("keeps the client when only the static credential is cleared", () => {
      expect(
        buildMcpUpdateMaterial(
          { ...connected, secret: "token" },
          { ...remote, clearCredential: true },
        ),
      ).toEqual({ action: "store", material: connected });
    });
  });

  it("replaces headers on update and leaves env untouched when the transport cannot express it", () => {
    const result = buildMcpUpdateMaterial(
      { secret: "s", env: { OLD: "x" }, headers: { Authorization: "a" } },
      {
        transport: "streamable_http",
        slug: "x",
        name: "x",
        endpoint: "https://mcp.example.test",
        headers: { Authorization: "b" },
      },
    );
    expect(result).toEqual({
      action: "store",
      material: { secret: "s", env: { OLD: "x" }, headers: { Authorization: "b" } },
    });
  });

  describe("stdio credential files", () => {
    const stdio = {
      transport: "stdio" as const,
      slug: "x",
      name: "x",
      command: "npx",
      args: [],
      env: {},
    };
    const template = '{"refresh_token":"{{oauth.refresh_token}}"}';

    it("stores supplied files with the rest of the material", () => {
      expect(
        buildMcpUpdateMaterial({}, { ...stdio, files: { CREDENTIALS_PATH: template } }),
      ).toEqual({ action: "store", material: { files: { CREDENTIALS_PATH: template } } });
    });

    it("replaces the stored files with the supplied set", () => {
      const result = buildMcpUpdateMaterial(
        { files: { OLD_PATH: "old", CREDENTIALS_PATH: "old" } },
        { ...stdio, files: { CREDENTIALS_PATH: template } },
      );
      expect(result).toEqual({
        action: "store",
        material: { files: { CREDENTIALS_PATH: template } },
      });
    });

    it("keeps the stored files when the update omits them", () => {
      const result = buildMcpUpdateMaterial(
        { files: { CREDENTIALS_PATH: template } },
        { ...stdio, env: { A: "b" } },
      );
      expect(result).toEqual({
        action: "store",
        material: { env: { A: "b" }, files: { CREDENTIALS_PATH: template } },
      });
    });

    it("removes the files when an empty set is supplied", () => {
      expect(
        buildMcpUpdateMaterial(
          { secret: "s", files: { CREDENTIALS_PATH: template } },
          { ...stdio, files: {} },
        ),
      ).toEqual({ action: "store", material: { secret: "s" } });
    });

    it("drops the files when the static credential is cleared", () => {
      const oauthClient = { client_id: "client-a" };
      expect(
        buildMcpUpdateMaterial(
          { oauthClient, files: { CREDENTIALS_PATH: template } },
          { ...stdio, files: { CREDENTIALS_PATH: template }, clearCredential: true },
        ),
      ).toEqual({ action: "store", material: { oauthClient } });
      expect(
        buildMcpUpdateMaterial(
          { files: { CREDENTIALS_PATH: template } },
          { ...stdio, clearCredential: true },
        ),
      ).toEqual({ action: "store", material: {} });
    });

    it("drops the files and arguments when the server is no longer stdio", () => {
      expect(
        buildMcpUpdateMaterial(
          { secret: "s", args: ["--api-key", "fake-key"], files: { CREDENTIALS_PATH: template } },
          {
            transport: "streamable_http",
            slug: "x",
            name: "x",
            endpoint: "https://mcp.example.test",
            headers: {},
          },
        ),
      ).toEqual({ action: "store", material: { secret: "s" } });
    });
  });

  describe("stdio arguments", () => {
    const stdio = { transport: "stdio", slug: "x", name: "x", command: "npx" } as const;

    it("stores new arguments in the material", () => {
      expect(buildMcpUpdateMaterial({}, { ...stdio, args: ["--api-key", "fake-key"] })).toEqual({
        action: "store",
        material: { args: ["--api-key", "fake-key"] },
      });
    });

    it("keeps the stored arguments when none are sent back", () => {
      expect(
        buildMcpUpdateMaterial({ args: ["--api-key", "fake-key"] }, { ...stdio, args: [] }),
      ).toEqual({ action: "store", material: { args: ["--api-key", "fake-key"] } });
    });

    it("does not hand stored arguments to a different command", () => {
      expect(
        buildMcpUpdateMaterial(
          { args: ["--api-key", "fake-key"] },
          { ...stdio, command: "uvx", args: [] },
          { commandChanged: true },
        ),
      ).toEqual({ action: "store", material: {} });
    });

    it("keeps the arguments when credentials are cleared", () => {
      expect(
        buildMcpUpdateMaterial(
          { args: ["serve"], env: { API_KEY: "k" } },
          { ...stdio, args: [], clearCredential: true },
        ),
      ).toEqual({ action: "store", material: { args: ["serve"] } });
    });
  });
});
