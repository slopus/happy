export class AsyncLock {
  private permits = 1;
  private promiseResolverQueue: Array<(value: boolean) => void> = [];

  async inLock<T>(func: () => Promise<T> | T): Promise<T> {
    try {
      await this.lock();
      return await func();
    } finally {
      this.unlock();
    }
  }

  private async lock(): Promise<void> {
    if (this.permits > 0) {
      this.permits -= 1;
      return;
    }
    await new Promise<boolean>(resolve => this.promiseResolverQueue.push(resolve));
  }

  private unlock(): void {
    this.permits += 1;
    if (this.permits > 1 && this.promiseResolverQueue.length > 0) {
      throw new Error('this.permits should never be > 0 when there is someone waiting.');
    }

    if (this.permits === 1 && this.promiseResolverQueue.length > 0) {
      this.permits -= 1;
      const nextResolver = this.promiseResolverQueue.shift();
      if (nextResolver) {
        setTimeout(() => nextResolver(true), 0);
      }
    }
  }
}
