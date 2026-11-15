import { describe, expect, it } from "vitest";
import { configuredBotEmailProvider } from "./email-provider.js";

describe("bot email connection", () => {
  it("is disabled without its own connection and requires an address domain", async () => {
    expect(configuredBotEmailProvider({ domain: "bots.example.test" })).toBeUndefined();
    expect(() => configuredBotEmailProvider({ smtpUrl: "smtps://smtp.example.test" })).toThrow(
      "INBOUND_EMAIL_DOMAIN",
    );
    const email = configuredBotEmailProvider({
      smtpUrl: "smtps://smtp.example.test",
      domain: "bots.example.test",
    });
    expect(email?.describe().id).toBe("smtp");
    await email?.drain?.();
  });
});
