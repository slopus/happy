import type { TransactionalEmail, TransactionalEmailProvider } from "@rakazo/adapter-kit";

/** Deterministic, offline transactional-email emulator for tests and local development. */
export class EmailEmulator implements TransactionalEmailProvider {
  readonly sent: TransactionalEmail[] = [];
  private failuresRemaining = 0;

  constructor(private readonly onSend?: (message: TransactionalEmail) => void) {}

  describe() {
    return {
      id: "email-emulator",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { transactional: true },
    };
  }

  async send(message: TransactionalEmail): Promise<void> {
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error("Emulated email delivery failure");
    }
    const captured = { ...message };
    this.sent.push(captured);
    this.onSend?.(captured);
  }

  failNextSends(count = 1): void {
    this.failuresRemaining = count;
  }
}
