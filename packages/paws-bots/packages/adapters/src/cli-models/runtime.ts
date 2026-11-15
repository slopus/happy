import type { AgentRuntime } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { createRuntimeModels } from "../pi-runtime-models.js";
import { withRuntimeModels } from "../pi-runtime-scope.js";
import type { RunRuntimeEnv } from "../run-runtime.js";
import { CLAUDE_CODE_PROVIDER_ID, registerClaudeCodeProvider } from "./claude-code/provider.js";
import { personalCliAccessCheck } from "./personal-access.js";

export function cliModelRuntime(
  env: Pick<RunRuntimeEnv, "defaultProvider" | "defaultModel" | "deploymentModelConfigured">,
  runtime: AgentRuntime,
  deps: { prisma: PrismaClient; billingEnabled?: boolean },
): AgentRuntime {
  if (env.defaultProvider !== CLAUDE_CODE_PROVIDER_ID || !env.deploymentModelConfigured) {
    return runtime;
  }
  const models = registerClaudeCodeProvider(createRuntimeModels(), {
    modelId: env.defaultModel,
    accessCheck: personalCliAccessCheck(deps),
  });
  return withRuntimeModels(runtime, models);
}
