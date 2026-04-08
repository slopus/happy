import { backoff } from './time';

export class InvalidateSync {
  private invalidated = false;
  private invalidatedDouble = false;
  private stopped = false;
  private readonly command: () => Promise<void>;
  private pendings: Array<() => void> = [];

  constructor(command: () => Promise<void>) {
    this.command = command;
  }

  invalidate(): void {
    if (this.stopped) {
      return;
    }

    if (!this.invalidated) {
      this.invalidated = true;
      this.invalidatedDouble = false;
      void this.doSync();
      return;
    }

    if (!this.invalidatedDouble) {
      this.invalidatedDouble = true;
    }
  }

  async invalidateAndAwait(): Promise<void> {
    if (this.stopped) {
      return;
    }

    await new Promise<void>(resolve => {
      this.pendings.push(resolve);
      this.invalidate();
    });
  }

  stop(): void {
    if (this.stopped) {
      return;
    }
    this.notifyPendings();
    this.stopped = true;
  }

  private notifyPendings(): void {
    for (const pending of this.pendings) {
      pending();
    }
    this.pendings = [];
  }

  private async doSync(): Promise<void> {
    await backoff(async () => {
      if (this.stopped) {
        return;
      }
      await this.command();
    });

    if (this.stopped) {
      this.notifyPendings();
      return;
    }

    if (this.invalidatedDouble) {
      this.invalidatedDouble = false;
      void this.doSync();
      return;
    }

    this.invalidated = false;
    this.notifyPendings();
  }
}
