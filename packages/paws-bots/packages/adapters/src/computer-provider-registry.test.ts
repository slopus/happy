import { ComputerProviderDescriptorSchema } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  computerProviderDescriptor,
  computerProviderDescriptors,
  computerProviderRegistry,
} from "./computer-provider-registry.js";
import { createSandboxProvider } from "./sandbox-factory.js";

// Every descriptor uses this same offline suite. No credentials or vendor connections are needed.
describe.each(computerProviderRegistry)("$id settings conformance", (descriptor) => {
  function validValues() {
    return Object.fromEntries(
      descriptor.fields
        .filter((field) => field.required)
        .map((field) => [
          field.key,
          field.kind === "url"
            ? "https://gateway.example.com/mcp"
            : field.kind === "select"
              ? field.options![0]!.value
              : "example-value",
        ]),
    );
  }
  it("has a public, serializable field schema with unique keys", () => {
    expect(ComputerProviderDescriptorSchema.safeParse(descriptor).success).toBe(true);
    expect(new Set(descriptor.fields.map((field) => field.key)).size).toBe(
      descriptor.fields.length,
    );
    expect(descriptor.id).not.toBe("default");
    for (const field of descriptor.fields) {
      expect(field.key).toMatch(/^[a-zA-Z][a-zA-Z0-9]*$/);
      if (field.destination)
        expect(descriptor.fields.some((f) => f.key === field.destination && f.kind === "url")).toBe(
          true,
        );
      if (field.kind === "select") expect(field.options?.length).toBeGreaterThan(0);
    }
    const publicView = computerProviderDescriptors().find((entry) => entry.id === descriptor.id)!;
    expect(Object.keys(publicView).sort()).toEqual(["capabilities", "displayName", "fields", "id"]);
    expect(JSON.stringify(publicView)).not.toContain("example-value");
  });
  it("rejects unknown fields and missing required input", () => {
    expect(() => descriptor.verify({ ...validValues(), unknown: "value" })).toThrow();
    for (const field of descriptor.fields.filter((field) => field.required)) {
      expect(() => descriptor.verify({ ...validValues(), [field.key]: "" })).toThrow();
    }
  });
  it("rejects insecure URLs and constructs options through the existing factory", async () => {
    for (const field of descriptor.fields.filter((field) => field.kind === "url")) {
      for (const bad of [
        "http://gateway.example.com",
        "https://127.0.0.1",
        "https://[::1]",
        "https://169.254.169.254",
        "https://localhost",
        "https://user:secret@example.com",
        "https://example.com/#secret",
      ]) {
        expect(() => descriptor.verify({ ...validValues(), [field.key]: bad })).toThrow();
      }
    }
    const provider = await createSandboxProvider(descriptor.id, descriptor.verify(validValues()));
    expect(provider.describe().id).toBe(descriptor.id);
  });
});

it("only offers declared account providers", () => {
  const offered = computerProviderDescriptors(true);
  expect(offered.length).toBeGreaterThan(0);
  expect(offered.every((provider) => provider.capabilities.perAccount)).toBe(true);
  expect(() => computerProviderDescriptor("unregistered")).toThrow();
});

it("returns only the options a provider's fields set, so other environment options remain", () => {
  const railway = computerProviderDescriptor("railway").verify({
    apiToken: "test-token",
    environmentId: "test-env",
  });
  expect(railway).toHaveProperty("railwaySandboxRegion", undefined);
  expect(railway).not.toHaveProperty("railwayMaxWorkspaceFileBytes");
  const wuying = computerProviderDescriptor("wuying").verify({
    desktopId: "ecd-test",
    endUserId: "test-user",
    accessKeyId: "test-id",
    accessKeySecret: "test-secret",
    mcpUrl: "https://gateway.example.com/mcp",
    mcpToken: "test-token",
  });
  // A blank region means the provider's default, not the environment's region.
  expect(wuying).toHaveProperty("wuyingRegionId", undefined);
});
