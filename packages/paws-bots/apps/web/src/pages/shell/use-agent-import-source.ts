import { useLingui } from "@lingui/react/macro";
import type {
  AgentImportFile,
  AgentImportMemoryDestination,
  AgentImportPlan,
} from "@rakazo/contracts";
import {
  BOT_INSTRUCTIONS_MAX_LENGTH,
  GROK_BOT_EXPORT_MAX_LENGTH,
  GROK_BOT_EXPORT_PATH,
} from "@rakazo/contracts";
import type { AgentImportReader, GrokBot } from "@rakazo/core";
import {
  AGENT_IMPORT_ARCHIVE_LIMITS,
  AGENT_IMPORT_NOT_FOUND,
  AgentImportArchiveError,
  agentImportSkillFiles,
  agentImportUpload,
  chooseAgentImportFiles,
  combineImportedInstructions,
  GROK_BOT_REPLY_MAX_LENGTH,
  GrokBotExportError,
  grokBotExportJson,
  hasAgentImportSecrets,
  newClientId,
  openAgentImportArchive,
  parseGrokBotExport,
} from "@rakazo/core";
import { useEffect, useRef, useState } from "react";
import { readAgentDocument } from "../../lib/agent-document";
import { agentImportErrorText, grokBotErrorText } from "../../lib/agent-import-errors";
import { rpc } from "../../lib/rpc";
import { errorText } from "../../lib/user-error";

export type AgentImportSource = ReturnType<typeof useAgentImportSource>;

/**
 * Reads a folder, backup, or agent document on this device, previews what it would import, and
 * holds the choices that preview starts with.
 */
export function useAgentImportSource() {
  const { t } = useLingui();
  const [files, setFiles] = useState<AgentImportFile[]>([]);
  const [source, setSource] = useState<AgentImportReader | null>(null);
  const [sourceFiles, setSourceFiles] = useState<{ path: string; home: string; content: string }[]>(
    [],
  );
  const [hasSecretFiles, setHasSecretFiles] = useState(false);
  const [includeSecrets, setIncludeSecrets] = useState(false);
  // One key per import, so a retried create returns the bot the first one made.
  const importKey = useRef<string | null>(null);
  // Names of the other files in each skill's folder; never their contents.
  const [skillFiles, setSkillFiles] = useState<Record<string, string[]>>({});
  const [plan, setPlan] = useState<AgentImportPlan | null>(null);
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set());
  const [destinations, setDestinations] = useState<Record<string, AgentImportMemoryDestination>>(
    {},
  );
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  // Bots in one Grok Bot reply, while the user picks which to import.
  const [grokBots, setGrokBots] = useState<GrokBot[]>([]);
  // Bumped by every new read, so a slower earlier one never lands over it.
  const latestRead = useRef(0);
  const [error, setError] = useState<string | null>(null);

  function failure(err: unknown, fallback: string) {
    const message = err instanceof Error ? err.message : "";
    setError(
      message === AGENT_IMPORT_NOT_FOUND
        ? notFound()
        : (agentImportErrorText(err) ?? errorText(err, fallback)),
    );
  }

  function notFound() {
    return t`No OpenClaw, Hermes or agent document found.`;
  }

  async function preview(
    read: number,
    next: AgentImportFile[],
    { secrets = false, keepChoices = false, siblings = skillFiles } = {},
  ) {
    setError(null);
    if (next.length === 0) {
      setError(notFound());
      setBusy(false);
      return;
    }
    setBusy(true);
    try {
      const found = await rpc.bots.importPreview({
        files: next,
        includeSecrets: secrets,
        skillFiles: siblings,
      });
      if (read !== latestRead.current) return;
      setFiles(next);
      setIncludeSecrets(secrets);
      // Anything that runs or acts (skills, MCP servers, routines) starts unticked, as do
      // untouched defaults the source wrote: the user ticks each one they want.
      const flagged = [
        ...found.skills,
        ...found.mcpServers,
        ...found.routines,
        ...found.instructions.filter((item) => item.stock),
        ...found.memory.filter((item) => item.stock),
        // Key-looking text reaches a bot only when the user ticks it.
        ...[...found.instructions, ...found.memory].filter((item) => item.containsKey),
      ].map((item) => item.id);
      if (keepChoices && plan) {
        // Turning the API key opt-in on or off keeps every choice; only new items get defaults.
        const known = new Set(
          [
            ...plan.instructions,
            ...plan.memory,
            ...plan.skills,
            ...plan.mcpServers,
            ...plan.routines,
            ...plan.apiKeys,
            ...(plan.model ? [plan.model] : []),
          ].map((item) => item.id),
        );
        setUnchecked((current) => {
          const merged = new Set(current);
          for (const id of flagged) if (!known.has(id)) merged.add(id);
          return merged;
        });
      } else {
        setUnchecked(new Set(flagged));
        setDestinations({});
        setName(found.suggestedName);
        setDescription(found.suggestedDescription);
      }
      setPlan(found);
    } catch (err) {
      if (read === latestRead.current) {
        if (
          next[0]?.path === GROK_BOT_EXPORT_PATH &&
          err instanceof Error &&
          err.message === AGENT_IMPORT_NOT_FOUND
        )
          setError(grokBotErrorText("not_export"));
        else failure(err, t`Could not read these files`);
      }
    } finally {
      if (read === latestRead.current) setBusy(false);
    }
  }

  function readError(err: unknown) {
    if (err instanceof AgentImportArchiveError) {
      return err.reason === "too_large"
        ? t`These files are too large to import.`
        : t`This backup could not be read.`;
    }
    return t`Could not read these files`;
  }

  /** Only the files an import uses leave the device; `.env`/`auth.json` are not read. */
  async function loadSource(next: AgentImportReader, read = ++latestRead.current) {
    setError(null);
    setGrokBots([]);
    setBusy(true);
    try {
      const chosen = await chooseAgentImportFiles(next.paths, next.read, {
        includeSecrets: false,
        size: next.size,
      });
      if (read !== latestRead.current) return;
      const siblings = agentImportSkillFiles(
        next.paths,
        new Map(chosen.entries.map((entry) => [entry.path, entry.home])),
      );
      setSource(next);
      setSourceFiles(chosen.entries);
      setHasSecretFiles(chosen.hasSecretFiles);
      setSkillFiles(siblings);
      importKey.current = newClientId();
      await preview(read, agentImportUpload(chosen.entries, { includeSecrets: false }), {
        siblings,
      });
    } catch (err) {
      if (read !== latestRead.current) return;
      setError(readError(err));
      setBusy(false);
    }
  }

  /** The opt-in reads `.env`/`auth.json` now, and sends only their allowlisted entries. */
  async function toggleSecrets(checked: boolean) {
    if (!source) return;
    const read = ++latestRead.current;
    setBusy(true);
    try {
      const chosen = await chooseAgentImportFiles(source.paths, source.read, {
        includeSecrets: checked,
        size: source.size,
      });
      if (read !== latestRead.current) return;
      setSourceFiles(chosen.entries);
      await preview(read, agentImportUpload(chosen.entries, { includeSecrets: checked }), {
        secrets: checked,
        keepChoices: true,
      });
    } catch (err) {
      if (read !== latestRead.current) return;
      setError(readError(err));
      setBusy(false);
    }
  }

  async function pickFolder(list: FileList | null) {
    if (!list?.length) {
      ++latestRead.current;
      setBusy(false);
      return;
    }
    const byPath = new Map(
      [...(list ?? [])].map((file) => [file.webkitRelativePath || file.name, file]),
    );
    await loadSource({
      paths: [...byPath.keys()],
      read: (path) => byPath.get(path)!.text(),
      size: (path) => byPath.get(path)?.size,
    });
  }

  /** Unpacked on this device, one file at a time. */
  async function pickArchive(file: File | undefined) {
    const read = ++latestRead.current;
    // Another source replaces any Bot choices an earlier reply left.
    setGrokBots([]);
    if (!file) {
      setBusy(false);
      return;
    }
    setError(null);
    try {
      if (file.size > AGENT_IMPORT_ARCHIVE_LIMITS.archiveBytes) {
        throw new AgentImportArchiveError("too_large");
      }
      const bytes = await file.arrayBuffer();
      if (read !== latestRead.current) return;
      const archive = openAgentImportArchive(new Uint8Array(bytes));
      await loadSource(archive, read);
    } catch (err) {
      if (read !== latestRead.current) return;
      setError(readError(err));
      setBusy(false);
    }
  }

  useEffect(
    () => () => {
      ++latestRead.current;
    },
    [],
  );

  const secretsAvailable =
    hasSecretFiles || sourceFiles.some(({ home, content }) => hasAgentImportSecrets(home, content));

  /** A pasted reply or one chosen file: no folder, so no secrets or skill siblings. */
  async function previewOne(read: number, file: AgentImportFile) {
    setGrokBots([]);
    setSource(null);
    setSourceFiles([]);
    setHasSecretFiles(false);
    setSkillFiles({});
    importKey.current = newClientId();
    await preview(read, [file], { siblings: {} });
  }

  async function previewDocument(content: string, read = ++latestRead.current) {
    await previewOne(read, { path: "agent.md", content });
  }

  /** One Bot previews at once; a reply with several asks which. */
  async function previewGrokReply(text: string, read = ++latestRead.current) {
    setError(null);
    setGrokBots([]);
    let bots: GrokBot[];
    try {
      bots = parseGrokBotExport(text);
    } catch (err) {
      if (!(err instanceof GrokBotExportError)) throw err;
      setError(grokBotErrorText(err.code));
      setBusy(false);
      return;
    }
    const [only] = bots;
    if (only && bots.length === 1) await previewGrokBot(only, read);
    else {
      setGrokBots(bots);
      setBusy(false);
    }
  }

  async function previewGrokBot(bot: GrokBot, read = ++latestRead.current) {
    const content = grokBotExportJson(bot);
    if (content.length > GROK_BOT_EXPORT_MAX_LENGTH) {
      setError(grokBotErrorText("too_large"));
      setBusy(false);
      return;
    }
    await previewOne(read, { path: GROK_BOT_EXPORT_PATH, content });
  }

  async function pickGrokFiles(list: FileList | null) {
    const read = ++latestRead.current;
    setBusy(true);
    setGrokBots([]);
    const chosen = [...(list ?? [])];
    if (chosen.length === 0) {
      setBusy(false);
      return;
    }
    if (chosen.reduce((sum, file) => sum + file.size, 0) > GROK_BOT_REPLY_MAX_LENGTH * 4) {
      setError(grokBotErrorText("too_large"));
      setBusy(false);
      return;
    }
    try {
      const texts = await Promise.all(chosen.map((file) => file.text()));
      if (read !== latestRead.current) return;
      const parts = texts.flatMap((text) => parseGrokBotExport(text).map(grokBotExportJson));
      await previewGrokReply(parts.join("\n\n"), read);
    } catch (err) {
      if (read !== latestRead.current) return;
      setError(err instanceof GrokBotExportError ? grokBotErrorText(err.code) : readError(err));
      setBusy(false);
    }
  }

  async function pickDocument(list: FileList | null) {
    const read = ++latestRead.current;
    setGrokBots([]);
    const file = list?.[0];
    if (!file) {
      setBusy(false);
      return;
    }
    try {
      const text = await readAgentDocument(file);
      if (read !== latestRead.current) return;
      if (text === null) {
        setError(t`These files are too large to import.`);
        setBusy(false);
        return;
      }
      await previewDocument(text, read);
    } catch (err) {
      if (read !== latestRead.current) return;
      setError(readError(err));
      setBusy(false);
    }
  }

  function stopReading() {
    ++latestRead.current;
    setGrokBots([]);
    setBusy(false);
  }

  function toggle(id: string, checked: boolean) {
    setUnchecked((current) => {
      const next = new Set(current);
      if (checked) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const selectedInstructions = plan?.instructions.filter((item) => !unchecked.has(item.id)) ?? [];
  const chosen = <T extends { id: string }>(items: T[] | undefined) =>
    (items ?? []).filter((item) => !unchecked.has(item.id));
  const keyedProviders = new Set(chosen(plan?.apiKeys).map((key) => key.provider));
  // A model needs a connection now, or its provider's key in this import.
  const modelUsable =
    plan?.model?.status === "ready" ||
    (plan?.model?.status === "needs_key" && keyedProviders.has(plan.model.provider));
  const tooLong =
    combineImportedInstructions(selectedInstructions).length > BOT_INSTRUCTIONS_MAX_LENGTH;

  const ready = Boolean(name.trim()) && !tooLong;

  return {
    files,
    includeSecrets,
    skillFiles,
    importKey,
    plan,
    setPlan,
    unchecked,
    toggle,
    destinations,
    setDestinations,
    name,
    setName,
    description,
    setDescription,
    busy,
    setBusy,
    error,
    setError,
    failure,
    secretsAvailable,
    toggleSecrets,
    pickFolder,
    pickArchive,
    previewDocument,
    pickDocument,
    grokBots,
    previewGrokReply,
    previewGrokBot,
    pickGrokFiles,
    stopReading,
    selectedInstructions,
    chosen,
    modelUsable,
    tooLong,
    ready,
  };
}
