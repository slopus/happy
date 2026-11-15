import type { AgentRunRequest, AgentRuntime } from "@rakazo/adapter-kit";
import { FIND_TOOL, findTools, partitionTools } from "@rakazo/adapters";

/**
 * A call through use_tool is recorded as the tool it ran, flagged `viaUseTool`, and `loaded`
 * when an earlier find_tool in the run returned it. A use_tool that named no runnable tool is
 * recorded as `use_tool`.
 */
export type ObservedToolCall = {
  runId: string;
  name: string;
  args: Record<string, unknown>;
  viaUseTool?: boolean;
  loaded?: boolean;
};
/** What the model was offered on a run's first call: tool count and serialized definition size. */
export type ObservedToolList = { runId: string; count: number; bytes: number };

export function toolListSize(tools: AgentRunRequest["tools"]): Omit<ObservedToolList, "runId"> {
  const { listed } = partitionTools(tools);
  const definitions = listed.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  }));
  return { count: listed.length, bytes: Buffer.byteLength(JSON.stringify(definitions)) };
}

/** Records every tool call the model makes, including ones the runtime answers itself (ask_user). */
export function observeToolCalls(
  runtime: AgentRuntime,
  calls: ObservedToolCall[],
  lists: ObservedToolList[],
): AgentRuntime {
  return {
    describe: () => runtime.describe(),
    abort: (id) => runtime.abort(id),
    async *run(request, context) {
      if (!lists.some((list) => list.runId === request.runId))
        lists.push({ runId: request.runId, ...toolListSize(request.tools) });
      const { deferred } = partitionTools(request.tools);
      const loaded = new Set<string>();
      for await (const event of runtime.run(request, context)) {
        if (event.type === "tool") {
          if (event.name === FIND_TOOL)
            for (const tool of findTools(deferred, event.args).tools) loaded.add(tool.name);
          calls.push({
            runId: request.runId,
            name: event.name,
            args: structuredClone(event.args),
            ...(event.viaUseTool ? { viaUseTool: true, loaded: loaded.has(event.name) } : {}),
          });
        }
        yield event;
      }
    },
  };
}
