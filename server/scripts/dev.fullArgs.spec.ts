import { describe, expect, it } from "vitest";
import { parseDevFullArgs } from "./dev.fullArgs";

describe('parseDevFullArgs', () => {
    it('defaults to port 3005', () => {
        expect(parseDevFullArgs([], {} as any)).toEqual({ port: 3005, killPort: false });
    });

    it('reads PORT from env', () => {
        expect(parseDevFullArgs([], { PORT: '3007' } as any)).toEqual({ port: 3007, killPort: false });
    });

    it('supports --port 3007', () => {
        expect(parseDevFullArgs(['--port', '3007'], {} as any)).toEqual({ port: 3007, killPort: false });
    });

    it('supports --port=3007', () => {
        expect(parseDevFullArgs(['--port=3007'], {} as any)).toEqual({ port: 3007, killPort: false });
    });

    it('supports --kill-port', () => {
        expect(parseDevFullArgs(['--kill-port'], {} as any)).toEqual({ port: 3005, killPort: true });
    });
});

