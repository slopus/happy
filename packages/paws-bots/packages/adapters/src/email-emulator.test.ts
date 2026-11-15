import { describe, expect, it, vi } from "vitest";
import { EmailEmulator } from "./email-emulator.js";

describe("EmailEmulator", () => {
  it("captures independent copies of outbound email", async () => {
    const onSend = vi.fn();
    const emulator = new EmailEmulator(onSend);
    const message = {
      to: "ada@example.test",
      subject: "Reset password",
      text: "Use this link",
    };

    await emulator.send(message);
    message.text = "changed after delivery";

    expect(emulator.sent).toEqual([
      { to: "ada@example.test", subject: "Reset password", text: "Use this link" },
    ]);
    expect(onSend).toHaveBeenCalledWith(emulator.sent[0]);
  });

  it("can emulate a bounded delivery failure", async () => {
    const emulator = new EmailEmulator();
    emulator.failNextSends(1);

    await expect(
      emulator.send({ to: "ada@example.test", subject: "First", text: "fail" }),
    ).rejects.toThrow("Emulated email delivery failure");
    await expect(
      emulator.send({ to: "ada@example.test", subject: "Second", text: "works" }),
    ).resolves.toBeUndefined();
  });
});
