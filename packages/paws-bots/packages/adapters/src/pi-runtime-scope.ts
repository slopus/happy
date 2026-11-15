import { AsyncLocalStorage } from "node:async_hooks";
import type { Models } from "@earendil-works/pi-ai";
import type { AgentRuntime } from "@rakazo/adapter-kit";

const runtimeModels = new AsyncLocalStorage<Models>();

export function scopedRuntimeModels(): Models | undefined {
  return runtimeModels.getStore();
}

/** Keep model selection and side calls inside the runtime's own provider configuration. */
export function withRuntimeModels(runtime: AgentRuntime, models: Models): AgentRuntime {
  return {
    describe: () => runtime.describe(),
    abort: (runId) => runtime.abort(runId),
    async *run(request, context) {
      const iterator = runtimeModels.run(models, () =>
        runtime.run(request, context)[Symbol.asyncIterator](),
      );
      try {
        for (;;) {
          const next = await runtimeModels.run(models, () => iterator.next());
          if (next.done) return;
          yield next.value;
        }
      } finally {
        await runtimeModels.run(models, () => iterator.return?.());
      }
    },
  };
}
