import { create } from 'zustand';
import { SessionStreamEnvelopeSchema, SessionTextDeltaSchema, SESSION_STREAM_MAX_TEXT_BYTES } from '@slopus/happy-wire';
import type { NormalizedMessage } from './typesRaw';

export type SessionTextPreview = Readonly<{ sessionId: string; turnId: string; itemId: string; text: string; createdAt: number }>;
type Decrypt = (ciphertext: string) => Promise<unknown>;
export class SessionTextStream {
    private sessionId: string | null = null;
    private generation = 0;
    private items = new Map<string, SessionTextPreview>();
    private closedItems = new Set<string>();
    private closedTurns = new Set<string>();
    private bytes = 0;
    private inFlight = 0;
    private suppressed = false;
    constructor(private readonly publish: (previews: readonly SessionTextPreview[]) => void) {}
    activate(sessionId: string | null): void {
        this.sessionId = sessionId;
        this.closedItems.clear(); this.closedTurns.clear(); this.suppressed = false;
        this.interrupt();
    }
    // Connection/route fences also discard decryptions already in flight.
    interrupt(): void {
        this.generation++; this.inFlight = 0; this.items.clear(); this.bytes = 0;
        this.publish([]);
    }
    async receive(data: unknown, decrypt: Decrypt, isCurrent: () => boolean = () => true): Promise<void> {
        const envelope = SessionStreamEnvelopeSchema.safeParse(data);
        if (!envelope.success || envelope.data.sid !== this.sessionId || this.suppressed || !isCurrent() || this.inFlight >= 8) return;
        const generation = this.generation;
        this.inFlight++;
        try {
            const decoded = await decrypt(envelope.data.content.c);
            if (generation !== this.generation || !isCurrent() || this.suppressed) return;
            const parsed = SessionTextDeltaSchema.safeParse(decoded);
            if (!parsed.success || !parsed.data.text) return;
            const { turnId, itemId, text } = parsed.data;
            const key = JSON.stringify([turnId, itemId]);
            if (this.closedTurns.has(turnId) || this.closedItems.has(key)) return;
            const previous = this.items.get(key);
            if (previous && (text.length <= previous.text.length || !text.startsWith(previous.text))) return;
            if (!previous && this.items.size >= 256) return;
            const bytes = this.bytes + new TextEncoder().encode(text).byteLength
                - (previous ? new TextEncoder().encode(previous.text).byteLength : 0);
            if (bytes > SESSION_STREAM_MAX_TEXT_BYTES) return;
            this.bytes = bytes;
            this.items.set(key, { sessionId: envelope.data.sid, turnId, itemId, text, createdAt: previous?.createdAt ?? Date.now() });
            this.publish([...this.items.values()]);
        } catch {
            // Ephemeral previews are best effort. Never log ciphertext/plaintext
            // or advance a durable cursor on a preview decryption failure.
        } finally {
            if (generation === this.generation) this.inFlight--;
        }
    }
    observeDurable(sessionId: string, messages: readonly NormalizedMessage[]): void {
        if (sessionId !== this.sessionId) return;
        let changed = false;
        for (const message of messages) {
            if (message.isSidechain || !message.streamKey) continue;
            const { turnId, itemId } = message.streamKey;
            if (message.role === 'agent' && itemId && message.content.some(c => c.type === 'text')) {
                const key = JSON.stringify([turnId, itemId]);
                this.closedItems.add(key);
                changed = this.items.delete(key) || changed;
            } else if (message.role === 'event' && message.content.type === 'ready' && message.content.terminal === true) {
                this.closedTurns.add(turnId);
                for (const [key, value] of this.items) if (value.turnId === turnId) changed = this.items.delete(key) || changed;
            }
        }
        // Bound terminal bookkeeping without permitting old packets to reappear.
        if (this.closedItems.size + this.closedTurns.size > 4096) {
            this.suppressed = true; this.closedItems.clear(); this.closedTurns.clear(); this.interrupt(); return;
        }
        if (changed) {
            const values = [...this.items.values()];
            this.bytes = values.reduce((sum, value) => sum + new TextEncoder().encode(value.text).byteLength, 0);
            this.publish(values);
        }
    }
}
const empty: readonly SessionTextPreview[] = [];
const previews = create<{ values: readonly SessionTextPreview[] }>(() => ({ values: empty }));
export const sessionTextStream = new SessionTextStream(values => previews.setState({ values }));
export const useSessionTextPreviews = (sessionId: string): readonly SessionTextPreview[] =>
    previews(state => state.values[0]?.sessionId === sessionId ? state.values : empty);
