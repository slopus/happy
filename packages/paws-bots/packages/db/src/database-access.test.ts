import { describe, expect, it, vi } from "vitest";
import {
  databaseUrls,
  provisionRuntimeRole,
  rowSecurityWarning,
  scramSha256Verifier,
} from "./database-access.js";

const sent = vi.hoisted(() => [] as string[]);
vi.mock("pg", async (importActual) => ({
  ...(await importActual<typeof import("pg")>()),
  Client: class {
    async connect() {}
    async end() {}
    async query(sql: string) {
      sent.push(sql);
      if (sql.includes("current_user"))
        return { rowCount: 1, rows: [{ can: true, superuser: true }] };
      return sql.startsWith("SELECT 1") ? { rowCount: 1, rows: [{}] } : { rowCount: 0, rows: [] };
    }
  },
}));

const owner = "postgres://rakazo:owner-password@postgres:5432/rakazo";
const runtime = "postgres://rakazo_app:app-password@postgres:5432/rakazo";

describe("databaseUrls", () => {
  it("migrates as the owner and runs the app as the runtime login", () => {
    expect(databaseUrls({ DATABASE_URL: runtime, DATABASE_MIGRATION_URL: owner })).toEqual({
      url: runtime,
      migrationUrl: owner,
      separate: true,
    });
  });

  it("falls back to one shared login when only DATABASE_URL is set", () => {
    expect(databaseUrls({ DATABASE_URL: owner })).toEqual({
      url: owner,
      migrationUrl: owner,
      separate: false,
    });
    expect(databaseUrls({ DATABASE_URL: owner, DATABASE_MIGRATION_URL: " " }).separate).toBe(false);
  });

  it("treats two URLs for the same login as shared", () => {
    const sameLogin = "postgres://rakazo:owner-password@127.0.0.1:5433/rakazo";
    expect(databaseUrls({ DATABASE_URL: sameLogin, DATABASE_MIGRATION_URL: owner }).separate).toBe(
      false,
    );
  });

  it("requires DATABASE_URL", () => {
    expect(() => databaseUrls({ DATABASE_MIGRATION_URL: owner })).toThrow("DATABASE_URL");
  });
});

describe("rowSecurityWarning", () => {
  it("is silent when the policies apply", () => {
    expect(rowSecurityWarning({ enforced: true, role: "rakazo_app" })).toBeUndefined();
  });

  it("says to rerun db:migrate when the bypass key is stale", () => {
    expect(rowSecurityWarning({ enforced: true, role: "rakazo_app", systemBlocked: true })).toMatch(
      /db:migrate/,
    );
  });

  it("names the login and why it bypasses the policies", () => {
    expect(
      rowSecurityWarning({ enforced: false, role: "rakazo", reason: "is a superuser" }),
    ).toContain("connects as rakazo, which is a superuser");
  });
});

describe("scramSha256Verifier", () => {
  it("matches what PostgreSQL stores for the same password, salt and iterations", () => {
    expect(
      scramSha256Verifier("app-password", Buffer.from("sTvbJ/EJNVLOgpmYdsR30Q==", "base64")),
    ).toBe(
      "SCRAM-SHA-256$4096:sTvbJ/EJNVLOgpmYdsR30Q==$KyaqWOivMwaMBR/m/ef/wkRtX2w6mPEhZg8xjgAKi/Y=:rGhNKb4nxeU9ipcVOm0JEOaPoHFJO2QHItj2UNOcVV4=",
    );
  });

  it("prepares the password the way PostgreSQL does before hashing", () => {
    expect(
      scramSha256Verifier("\uFB01\u00A0x", Buffer.from("n3PEXisxfO3xisw8EGkLvw==", "base64")),
    ).toBe(
      "SCRAM-SHA-256$4096:n3PEXisxfO3xisw8EGkLvw==$dHX8hzcpW/+6sZ5VFjapRaC+7GEk08wlDfKwwF0m+BU=:y2HSQo6LJdUG4Z+vmfVE1ItSGQ4qo4LeqKSY0Zn+mgM=",
    );
  });
});

describe("provisionRuntimeRole", () => {
  it("sets the runtime password without sending it to the server", async () => {
    sent.length = 0;
    await provisionRuntimeRole(owner, runtime);
    const setPassword = sent.find((sql) => sql.includes("PASSWORD"));
    expect(setPassword).toMatch(/^CREATE ROLE "rakazo_app" LOGIN PASSWORD 'SCRAM-SHA-256\$4096:/);
    expect(sent.join("\n")).not.toContain("app-password");
  });
});
