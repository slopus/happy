import type { Metadata } from '@/api/types';

/**
 * The model/effort a *user* chose for a session, as opposed to whatever the
 * session happens to be running this turn.
 *
 * The distinction is the whole point of this module. `currentModel` in the agent
 * loops is always a concrete model — it falls back to the runtime default when
 * nobody pinned anything — so it cannot be published as-is: clients read the
 * published value as "the user picked this" and stop auto-routing. An absent
 * field means "no pin", which is what keeps Default sessions routable.
 */
export interface SessionModelPin {
    model?: string;
    effort?: string;
}

export interface SessionModelPinTurn {
    /** The message carried an explicit `model` key — including an explicit reset. */
    specifiesModel: boolean;
    /** The turn's model; undefined when the user reset to the runtime default. */
    model?: string;
    specifiesEffort: boolean;
    effort?: string;
    /** Absent means 'user' (older clients never send it); 'auto' means the
     *  sender is on Auto, which clears the pin. */
    source?: 'user' | 'auto';
}

/** `null` deletes the key — an empty string would still read as a pin. */
export interface SessionModelPinPatch {
    currentModelCode: string | null;
    currentThoughtLevelCode: string | null;
}

function normalize(value: string | undefined): string | undefined {
    return value ? value : undefined;
}

function samePin(a: SessionModelPin, b: SessionModelPin): boolean {
    return a.model === b.model && a.effort === b.effort;
}

function patchFor(pin: SessionModelPin): SessionModelPinPatch {
    return {
        currentModelCode: pin.model ?? null,
        currentThoughtLevelCode: pin.effort ?? null,
    };
}

/**
 * Folds one turn into the session's pin and says what, if anything, the session
 * metadata should now advertise. Returns `patch: null` when the advertised value
 * is already correct, so a long session publishes only on actual change.
 */
export function applySessionModelPinTurn(input: {
    pin: SessionModelPin;
    published: SessionModelPin;
    turn: SessionModelPinTurn;
}): { pin: SessionModelPin; patch: SessionModelPinPatch | null } {
    const { pin, published, turn } = input;
    // A model the client's router picked for this turn is not a choice the user
    // made. Recording it would hand the next client a pin it reads as deliberate,
    // and auto-routing would never resume. A client only routes when its own
    // selection is Auto, so the turn also says the user is not pinned any more:
    // desktop and mobile have no other way to go back to Auto (they never send
    // `model: null` for a routable agent), and keeping the old pin leaves every
    // other device reading it as the user's choice.
    const next: SessionModelPin = turn.source === 'auto'
        ? {}
        : {
            model: turn.specifiesModel ? normalize(turn.model) : pin.model,
            effort: turn.specifiesEffort ? normalize(turn.effort) : pin.effort,
        };
    const pruned: SessionModelPin = {
        ...(next.model ? { model: next.model } : {}),
        ...(next.effort ? { effort: next.effort } : {}),
    };
    return {
        pin: pruned,
        patch: samePin(pruned, published) ? null : patchFor(pruned),
    };
}

export function applySessionModelPinPatch(metadata: Metadata, patch: SessionModelPinPatch): Metadata {
    const next: Metadata = { ...metadata };
    if (patch.currentModelCode === null) {
        delete next.currentModelCode;
    } else {
        next.currentModelCode = patch.currentModelCode;
    }
    if (patch.currentThoughtLevelCode === null) {
        delete next.currentThoughtLevelCode;
    } else {
        next.currentThoughtLevelCode = patch.currentThoughtLevelCode;
    }
    return next;
}

/** What the session metadata currently advertises, as a pin. */
export function publishedSessionModelPin(metadata: Metadata | undefined): SessionModelPin {
    return {
        ...(metadata?.currentModelCode ? { model: metadata.currentModelCode } : {}),
        ...(metadata?.currentThoughtLevelCode ? { effort: metadata.currentThoughtLevelCode } : {}),
    };
}

/**
 * Owns the per-session pin state and the "publish only on change" bookkeeping,
 * so the agent loops hold one object instead of three mutable variables each.
 * Exists mainly to make the wiring testable: the loops themselves are not.
 */
export function createSessionModelPinPublisher(input: {
    /** The pin implied by spawn options (`--model`, HAPPY_INITIAL_MODEL). */
    initialPin: SessionModelPin;
    /** What the session metadata already advertises, read once at startup. */
    publishedPin: SessionModelPin;
    updateMetadata: (update: (metadata: Metadata) => Metadata) => void;
    onPublish?: (patch: SessionModelPinPatch) => void;
}): {
    publish: (turn: SessionModelPinTurn) => void;
    /** Restores the spawn-time pin, mirroring the loops' turn-scoped abort reset. */
    reset: () => void;
} {
    // A restart or daemon reconnect spawns without --model, and the runtime
    // knowing nothing is not the user clearing their choice. Adopt whatever the
    // session already advertises for either half the spawn options did not speak
    // to — otherwise the first converge publishes a clear and every restart
    // wipes the pin the other devices were reading, which is the exact failure
    // this feature exists to prevent. An explicit spawn option still wins: that
    // one IS a fresh user choice.
    const spawnPin: SessionModelPin = {
        ...(input.initialPin.model ?? input.publishedPin.model
            ? { model: input.initialPin.model ?? input.publishedPin.model }
            : {}),
        ...(input.initialPin.effort ?? input.publishedPin.effort
            ? { effort: input.initialPin.effort ?? input.publishedPin.effort }
            : {}),
    };
    let pin = spawnPin;
    let published = input.publishedPin;

    const publish = (turn: SessionModelPinTurn): void => {
        const result = applySessionModelPinTurn({ pin, published, turn });
        pin = result.pin;
        if (!result.patch) return;
        published = result.pin;
        input.updateMetadata((metadata) => applySessionModelPinPatch(metadata, result.patch!));
        input.onPublish?.(result.patch);
    };

    return {
        publish,
        reset: () => {
            pin = spawnPin;
            // Converge what the session advertises too. Leaving the old value up
            // lets another device read the stale pin and send it right back as a
            // user pin, silently undoing the reset.
            publish({ specifiesModel: false, specifiesEffort: false });
        },
    };
}
