export interface RuntimeClock { now(): number }
export const systemClock: RuntimeClock = { now: () => Date.now() }

export class FakeClock implements RuntimeClock {
    constructor(private value = 0) {}
    now(): number { return this.value }
    advance(ms: number): void { this.value += ms }
    set(ms: number): void { this.value = ms }
}
