import type { AdapterContext, ComputerRef, SandboxProvider } from "@rakazo/adapter-kit";
import { isSandboxProviderOutage } from "@rakazo/adapter-kit";
import type { ComputerMode } from "@rakazo/contracts";
import { ATTACHMENT_MAX_BYTES } from "@rakazo/contracts";
import { redactSecrets } from "@rakazo/core";
import { PLOT_TOOL_GUIDE, searchChartCatalog } from "@rakazo/core/plot-catalog";
import { getLogger } from "@rakazo/logging";
import { JSDOM } from "jsdom";
import { displayBotWorkspacePath, resolveBotWorkspacePath } from "./computer-support.js";
import type { ExecutorDeps } from "./executor-deps.js";
import { TOOL_RESULT_TEXT_LIMIT } from "./pi-runtime-limits.js";
import type { PlotSpec } from "./plot-tool.js";
import {
  assertPlotDataWithinLimits,
  parsePlotData,
  plotSvgToPng,
  renderPlotSpecToSvg,
} from "./plot-tool.js";
import { publishMessage } from "./run-messages.js";
import { attachWorkspaceFileToThread } from "./thread-artifacts.js";
/** The bot workspace a run reaches on its computer. */
export type RunWorkspace = {
  botId: string;
  computerMode: ComputerMode;
  computer: () => Promise<ComputerRef>;
  markDirty: () => void;
  context: AdapterContext;
  runSecrets: string[];
};

const MAX_MODEL_FILE_BYTES = 250_000;

/** An optional argument the model must send as a positive integer; anything else is ignored. */
export function positiveIntegerArg(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : undefined;
}

type ReadFileRangeResult = {
  path: string;
  content: string;
  totalLines: number;
  startLine: number;
  endLine: number;
  nextOffset?: number;
  note?: string;
};

/**
 * Picks the line range a read_file call returns. The serialized result always stays within
 * TOOL_RESULT_TEXT_LIMIT, so the model reads a large file chunk by chunk through nextOffset
 * and never meets the generic tool-result truncation.
 */
function readFileRangeResult(
  filePath: string,
  text: string,
  args: Record<string, unknown>,
): ReadFileRangeResult | { error: string; path: string; totalLines: number } {
  const lines = text.split("\n");
  const totalLines = lines.length;
  const offset = positiveIntegerArg(args.offset) ?? 1;
  const limit = positiveIntegerArg(args.limit);
  if (offset > totalLines) {
    return {
      error: `offset ${offset} is past the end of the file, which has ${totalLines} lines`,
      path: filePath,
      totalLines,
    };
  }
  const first = offset - 1;
  const wanted = Math.min(limit ?? totalLines - first, totalLines - first);
  const rangeResult = (count: number): ReadFileRangeResult => {
    const endLine = offset + count - 1;
    return {
      path: filePath,
      content: lines.slice(first, first + count).join("\n"),
      totalLines,
      startLine: offset,
      endLine,
      ...(endLine < totalLines
        ? {
            nextOffset: endLine + 1,
            note: `the file continues; call read_file again with offset: ${endLine + 1}`,
          }
        : {}),
    };
  };
  // The full range with no continuation note can be shorter than one line less, so check it
  // apart; below `wanted` the note is always present and the length grows with every line.
  if (JSON.stringify(rangeResult(wanted)).length <= TOOL_RESULT_TEXT_LIMIT) {
    return rangeResult(wanted);
  }
  let lo = 0;
  let hi = wanted - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (JSON.stringify(rangeResult(mid)).length <= TOOL_RESULT_TEXT_LIMIT) lo = mid;
    else hi = mid - 1;
  }
  if (lo > 0) return rangeResult(lo);
  // Not even one whole line fits: cut the first requested line and say so.
  const cutBase = {
    path: filePath,
    totalLines,
    startLine: offset,
    endLine: offset,
    ...(offset < totalLines ? { nextOffset: offset + 1 } : {}),
    note:
      `line ${offset} is longer than the result limit and is cut` +
      (offset < totalLines ? `; continue with offset: ${offset + 1}` : ""),
  };
  const budget = TOOL_RESULT_TEXT_LIMIT - JSON.stringify({ ...cutBase, content: "" }).length;
  return { ...cutBase, content: jsonEscapedPrefix(lines[first] ?? "", budget) };
}

/** The longest prefix of `text` whose JSON string form fits in `budget` characters. */
function jsonEscapedPrefix(text: string, budget: number): string {
  let used = 0;
  let index = 0;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    // A valid surrogate pair passes through unescaped; a lone one becomes \uXXXX.
    let cost: number;
    let width = 1;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        cost = 2;
        width = 2;
      } else {
        cost = 6;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      cost = 6;
    } else if (
      code === 0x22 ||
      code === 0x5c ||
      code === 0x08 ||
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0c ||
      code === 0x0d
    ) {
      cost = 2;
    } else if (code < 0x20) {
      cost = 6;
    } else {
      cost = 1;
    }
    if (used + cost > budget) break;
    used += cost;
    index += width;
  }
  return text.slice(0, index);
}

export async function listFilesFromTool(
  sandbox: SandboxProvider,
  workspace: RunWorkspace,
  args: Record<string, unknown>,
) {
  const { botId, computerMode, computer, context, runSecrets } = workspace;
  const requestedPath = String(args.path ?? "");
  const entries = await sandbox.listFiles(
    await computer(),
    resolveBotWorkspacePath(computerMode, botId, requestedPath),
    context,
  );
  return {
    path: requestedPath,
    entries: entries.map((entry) => ({
      ...entry,
      // A file name can carry a value an earlier command or page wrote.
      path: redactSecrets(
        displayBotWorkspacePath(computerMode, botId, requestedPath, entry.path),
        runSecrets,
      ),
    })),
  };
}

export async function readFileFromTool(
  sandbox: SandboxProvider,
  workspace: RunWorkspace,
  args: Record<string, unknown>,
) {
  const { botId, computerMode, computer, context, runSecrets } = workspace;
  const filePath = String(args.path ?? "");
  const storedPath = resolveBotWorkspacePath(computerMode, botId, filePath);
  let bytes: Uint8Array;
  try {
    bytes = await sandbox.readFile(await computer(), storedPath, context, {
      maxBytes: MAX_MODEL_FILE_BYTES,
    });
  } catch (error) {
    if (error instanceof Error && /exceeds \d+ bytes/.test(error.message)) {
      return {
        error: "file is too large for model context",
        path: filePath,
      };
    }
    throw error;
  }
  if (bytes.byteLength > MAX_MODEL_FILE_BYTES) {
    return {
      error: "file is too large for model context",
      path: filePath,
      size: bytes.byteLength,
    };
  }
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return {
      error: "file is not UTF-8 text; use open_path to inspect it",
      path: filePath,
    };
  }
  // Redact the whole decoded text before any line is selected, so a secret is never
  // split across a chunk boundary by the range cut.
  return readFileRangeResult(filePath, redactSecrets(decoded, runSecrets), args);
}

/** render_plot: returns the chart guide or catalog, or renders a chart into the workspace and chat. */
export async function renderPlotFromTool(
  deps: ExecutorDeps,
  run: {
    id: string;
    spaceId: string;
    userId: string;
    threadId: string;
    botId: string;
    trigger: string;
  },
  args: Record<string, unknown>,
  executionId: string,
  workspace: RunWorkspace,
  finish: (result: unknown) => Promise<unknown>,
) {
  const { botId, computerMode, computer, context, runSecrets } = workspace;
  if (args.charts !== undefined) {
    const query = typeof args.charts === "string" ? args.charts : undefined;
    return {
      charts: searchChartCatalog(query),
      note: "Each spec is a complete runnable example: substitute your rows and column names, then call render_plot with it.",
    };
  }
  if (args.help === true || !args.spec || typeof args.spec !== "object") {
    return { guide: PLOT_TOOL_GUIDE };
  }
  // Data and spec mistakes are the model's to fix from the returned error;
  // everything else (reading the data file, rasterizing, attaching) is ours.
  let checkingSpec = false;
  try {
    let rows = Array.isArray(args.data) ? (args.data as unknown[]) : undefined;
    const dataPath =
      typeof args.data_path === "string" && args.data_path ? args.data_path : undefined;
    if (!rows && dataPath) {
      const bytes = await deps.sandbox.readFile(
        await computer(),
        resolveBotWorkspacePath(computerMode, botId, dataPath),
        context,
        { maxBytes: deps.maxUploadSizeBytes ?? ATTACHMENT_MAX_BYTES },
      );
      checkingSpec = true;
      rows = parsePlotData(dataPath, new TextDecoder().decode(bytes));
    }
    checkingSpec = true;
    assertPlotDataWithinLimits(args.spec as PlotSpec, rows);
    const svg = renderPlotSpecToSvg(args.spec as PlotSpec, rows, new JSDOM("").window.document);
    checkingSpec = false;
    const png = await plotSvgToPng(svg);
    const outPath =
      typeof args.path === "string" && args.path ? args.path : `charts/plot-${Date.now()}.png`;
    workspace.markDirty();
    await deps.sandbox.writeFile(
      await computer(),
      {
        path: resolveBotWorkspacePath(computerMode, botId, outPath),
        content: png,
      },
      context,
    );
    let attached = false;
    const chartName = outPath.split("/").pop() ?? "chart";
    const chartRows = rows ?? (args.spec as { data?: unknown[] }).data ?? [];
    const chartSpec = { ...(args.spec as Record<string, unknown>) };
    delete chartSpec.data;
    const chartFits =
      Array.isArray(chartRows) &&
      JSON.stringify({ spec: chartSpec, data: chartRows }).length <= 200_000;
    if (args.attach !== false && chartFits) {
      // Live inline chart: the client re-renders the validated spec
      // and the PNG stays on disk as the exportable copy.
      await publishMessage(deps, run, "bot", [
        {
          kind: "chart",
          name: chartName,
          spec: chartSpec,
          data: chartRows,
        },
      ]);
      attached = true;
    } else if (args.attach !== false && deps.artifacts) {
      const result = await attachWorkspaceFileToThread(
        {
          prisma: deps.prisma,
          artifacts: deps.artifacts,
          maxUploadSizeBytes: deps.maxUploadSizeBytes,
        },
        {
          spaceId: run.spaceId,
          userId: run.userId,
          botId,
          runId: run.id,
          filePath: outPath,
          bytes: png,
          operationId: executionId,
        },
      );
      await publishMessage(deps, run, "bot", [result.block]);
      attached = true;
    }
    return finish({ ok: true, path: outPath, attached });
  } catch (error) {
    const message = redactSecrets(
      error instanceof Error ? error.message : String(error),
      runSecrets,
    );
    if (isSandboxProviderOutage(error)) getLogger().warn("render_plot failed", { reason: message });
    else if (!checkingSpec) getLogger().error(`render_plot failed for bot ${botId}: ${message}`);
    return finish({
      error: message,
      hint: 'Call render_plot with {"charts": true} for runnable example specs, or {"help": true} for the full guide.',
    });
  }
}
