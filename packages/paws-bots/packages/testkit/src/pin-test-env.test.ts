import { describe, expect, it } from "vitest";

const describeFast = process.env.VERIFY_PROVIDERS ? describe.skip : describe;
const itOffline = process.env.VERIFY_DATABASE ? it.skip : it;

describeFast("pnpm test emulator pin", () => {
  it("forces scripted runtime, fake sandbox, and in-memory wakeup", () => {
    expect(process.env.AGENT_RUNTIME).toBe("scripted");
    expect(process.env.RAKAZO_LIVE_MODEL_CATALOG).toBe("off");
    expect(process.env.SANDBOX_PROVIDER).toBe("fake");
    expect(process.env.WAKEUP_DRIVER).toBe("memory");
  });

  it("never enables billed media generation through inherited configuration", () => {
    expect(process.env.MEDIA_GENERATION_PROVIDER).toBe("disabled");
    expect(process.env.MEDIA_GENERATION_API_KEY).toBeUndefined();
  });

  it("never enables billed paid services through inherited configuration", () => {
    expect(process.env.PAID_SERVICES_PROVIDER).toBe("disabled");
    expect(process.env.PAID_SERVICES_API_KEY).toBeUndefined();
  });

  it("does not keep a live Composio key in the test process", () => {
    expect(process.env.COMPOSIO_API_KEY).toBeUndefined();
    expect(process.env.INTEGRATIONS_CATALOG_URL).toBeUndefined();
  });

  it("does not inherit live email delivery configuration", () => {
    expect(process.env.EMAIL_PROVIDER).toBeUndefined();
    expect(process.env.EMAIL_API_KEY).toBeUndefined();
    expect(process.env.SMTP_URL).toBeUndefined();
  });

  itOffline(
    "does not connect to an inherited database without an explicit integration flag",
    () => {
      expect(process.env.DATABASE_URL).toBeUndefined();
      expect(process.env.REALTIME_DATABASE_URL).toBeUndefined();
    },
  );
});
