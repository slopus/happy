import { resolveMessageModeMeta } from "@/sync/messageMeta";
import {
  fetchSessionSnapshot,
  fetchSessionSnapshotPage,
} from "@/sync/apiSessions";
import { apiSocket } from "@/sync/apiSocket";
import { storage } from "@/sync/storage";
import { sync } from "@/sync/sync";
import { machineResumeSession } from "@/sync/ops";
import { isMachineOnline } from "@/utils/machineUtils";
import { resolveSessionResumeAvailability } from "@/utils/sessionResumeAvailability";
import { getServerUrl } from "@/sync/serverConfig";
import { ApiMessageSchema, type ApiSessionSnapshot } from "@/sync/apiTypes";
import { z } from "zod";
import {
  createSessionSteward,
  decodeStewardCatalog,
  type StewardRequest,
} from "./sessionSteward.web";
const pageSchema = z.object({
  messages: z.array(ApiMessageSchema),
  hasMore: z.boolean(),
});
/** Captures one authenticated account generation, never exports credentials to Bots. */
export function createSessionStewardHost() {
  const owner = sync.encryption,
    credentials = sync.getCredentials(),
    server = getServerUrl();
  const lifetime = new AbortController();
  const current = () =>
    !lifetime.signal.aborted &&
    sync.encryption === owner &&
    sync.getCredentials() === credentials &&
    getServerUrl() === server;
  const check = () => {
    if (!current()) throw new Error("account-changed");
  };
  const decode = async (snapshot: ApiSessionSnapshot) => {
    check();
    if (!(await sync.ensureSessionHydrated(snapshot.id)))
      throw new Error("session-not-found");
    check();
    const encryption = owner
      .getSessionEncryption(snapshot.id)
      ?.createDetached();
    if (!encryption) throw new Error("session-key-unavailable");
    const [metadata, agentState] = await Promise.all([
      encryption.decryptMetadata(snapshot.metadataVersion, snapshot.metadata),
      encryption.decryptAgentState(
        snapshot.agentStateVersion,
        snapshot.agentState,
      ),
    ]);
    check();
    if (!metadata) throw new Error("session-metadata-unavailable");
    return {
      id: snapshot.id,
      seq: snapshot.seq,
      active: snapshot.active,
      metadata,
      agentState,
      presence: storage.getState().sessions[snapshot.id]?.presence,
    };
  };
  const get = async (id: string) => {
    check();
    const snapshot = await fetchSessionSnapshot(credentials, id);
    check();
    if (!snapshot) throw new Error("session-not-found");
    return decode(snapshot);
  };
  const host = createSessionSteward({
    current,
    get,
    list: async (input) => {
      check();
      const page = await fetchSessionSnapshotPage(credentials, input);
      check();
      const decoded = await decodeStewardCatalog(page, decode);
      check();
      return decoded;
    },
    history: async (id, input) => {
      await get(id);
      check();
      const encryption = owner.getSessionEncryption(id)?.createDetached();
      if (!encryption) throw new Error("session-key-unavailable");
      const params = new URLSearchParams({ limit: String(input.limit) });
      if (input.afterSeq !== undefined)
        params.set("after_seq", String(input.afterSeq));
      else
        params.set(
          "before_seq",
          String(input.beforeSeq ?? Number.MAX_SAFE_INTEGER),
        );
      const response = await apiSocket.request(
        `/v3/sessions/${encodeURIComponent(id)}/messages?${params}`,
        {
          signal: AbortSignal.any([
            lifetime.signal,
            AbortSignal.timeout(20_000),
          ]),
        },
      );
      check();
      if (!response.ok) throw new Error("history-unavailable");
      const page = pageSchema.parse(await response.json());
      check();
      const messages = await encryption.decryptMessages(page.messages);
      check();
      if (messages.some((message) => !message?.content))
        throw new Error("history-decryption-failed");
      return {
        messages: messages
          .map((message) => {
            if (!message || typeof message.seq !== "number")
              throw new Error("invalid-message-sequence");
            return { ...message, seq: message.seq };
          })
          .sort((a, b) => a.seq - b.seq),
        hasMore: page.hasMore,
      };
    },
    send: async (id, text, signal) => {
      check();
      signal.throwIfAborted();
      return sync.sendMessage(id, text, {
        isCurrent: () => current() && !signal.aborted,
      });
    },
    resume: async (session, signal) => {
      const latest = await get(session.id);
      check();
      signal.throwIfAborted();
      const machine =
        storage.getState().machines[latest.metadata?.machineId ?? ""];
      const availability = resolveSessionResumeAvailability({
        isConnected:
          latest.presence === "online" &&
          latest.metadata?.lifecycleState !== "archived",
        hasMachineId: Boolean(latest.metadata?.machineId),
        hasBackendResumeId: Boolean(
          latest.metadata?.claudeSessionId || latest.metadata?.codexThreadId,
        ),
        hasMachine: Boolean(machine),
        machineOnline: Boolean(machine && isMachineOnline(machine)),
        rpcAvailable: machine?.metadata?.resumeSupport?.rpcAvailable,
      });
      if (availability !== "available")
        throw new Error(`resume-${availability}`);
      const mode = resolveMessageModeMeta(latest, storage.getState().settings);
      return machineResumeSession({
        machineId: latest.metadata!.machineId!,
        sessionId: latest.id,
        agent: latest.metadata?.flavor ?? "claude",
        model: mode.model ?? undefined,
        permissionMode: mode.permissionMode,
        effort: mode.effort,
        isCurrent: () => current() && !signal.aborted,
      });
    },
    waitForChange: (id, _seq, signal) =>
      new Promise((resolve) => {
        if (signal.aborted || !current()) {
          resolve(false);
          return;
        }
        let previous = storage.getState().sessions[id];
        const finish = (changed: boolean) => {
          unsubscribe();
          signal.removeEventListener("abort", abort);
          resolve(changed);
        };
        const abort = () => finish(false);
        const unsubscribe = storage.subscribe((state) => {
          const next = state.sessions[id];
          if (!current()) finish(false);
          else if (next !== previous) {
            previous = next;
            finish(true);
          }
        });
        signal.addEventListener("abort", abort, { once: true });
      }),
  });
  const cancel = () => lifetime.abort();
  window.addEventListener("pagehide", cancel, { once: true });
  return {
    execute: async (request: StewardRequest, signal: AbortSignal) => {
      try {
        const result = await host.execute(
          request,
          AbortSignal.any([signal, lifetime.signal]),
        );
        check();
        if (new TextEncoder().encode(JSON.stringify(result)).length > 120000)
          return {
            error: "result-too-large",
            note: "Request a smaller history or catalog page.",
          };
        return result;
      } catch (error) {
        if (!current() || signal.aborted)
          throw new Error("web-client-disconnected");
        return {
          error: error instanceof Error ? error.message : "session-tool-failed",
        };
      }
    },
    dispose: () => {
      window.removeEventListener("pagehide", cancel);
      lifetime.abort();
    },
  };
}
