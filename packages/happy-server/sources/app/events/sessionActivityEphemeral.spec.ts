import { describe, expect, it } from "vitest";
import { buildSessionActivityEphemeral } from "./eventRouter";

describe("buildSessionActivityEphemeral", () => {
    it("omits the reason by default", () => {
        expect(buildSessionActivityEphemeral("session-1", false, 123, false)).toEqual({
            type: "activity",
            id: "session-1",
            active: false,
            activeAt: 123,
            thinking: false,
        });
    });

    it("includes a session socket disconnect reason when provided", () => {
        expect(buildSessionActivityEphemeral(
            "session-1",
            false,
            123,
            false,
            "session-socket-disconnected",
        )).toEqual({
            type: "activity",
            id: "session-1",
            active: false,
            activeAt: 123,
            thinking: false,
            reason: "session-socket-disconnected",
        });
    });
});
