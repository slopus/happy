import { authAndSetupMachineIfNeeded } from '@/ui/auth'
import { runCodex } from '@/codex/runCodex'
import { extractCodexResumeFlag } from '@/codex/cliArgs'
import { extractNoSandboxFlag } from '@/utils/sandboxFlags'
import { ensureDaemonRunning } from '@/daemon/ensureDaemonRunning'
import type { PermissionMode } from '@/api/types'
import type { ReasoningEffort } from '@/codex/codexAppServerTypes'
import { collectCodexUsageSnapshot } from '@/codex/codexUsage'
import { promptInstallSlashCommandIfNeeded } from './pawsInstallPrompt'

function formatTokens(value: number | undefined | null): string {
  return typeof value === 'number' ? value.toLocaleString() : '0'
}

function printUsageDay(label: string, day: Awaited<ReturnType<typeof collectCodexUsageSnapshot>>['today']): void {
  if (!day) {
    console.log(`${label}: no local Codex token events found`)
    return
  }
  console.log(`${label}: ${formatTokens(day.totalTokens)} total tokens`)
  console.log(`  input: ${formatTokens(day.inputTokens)} (${formatTokens(day.cachedInputTokens)} cached)`)
  console.log(`  output: ${formatTokens(day.outputTokens)} (${formatTokens(day.reasoningOutputTokens)} reasoning)`)
  console.log(`  events: ${day.tokenCountEvents.toLocaleString()} across ${day.sessions.toLocaleString()} session(s)`)
}

export async function handleCodexCommand(args: string[]): Promise<void> {
  if (args[0] === 'usage') {
    const snapshot = await collectCodexUsageSnapshot()
    console.log(`Codex usage source: ${snapshot.sessionsDir}`)
    console.log(`Time zone: ${snapshot.timeZone}`)
    printUsageDay('Today', snapshot.today)
    printUsageDay('Yesterday', snapshot.yesterday)
    const primary = snapshot.latestEvent?.rateLimits?.primary
    const secondary = snapshot.latestEvent?.rateLimits?.secondary
    if (primary || secondary) {
      console.log(`Rate limits: 5h ${primary?.usedPercent ?? '?'}% / 7d ${secondary?.usedPercent ?? '?'}%`)
    }
    for (const warning of snapshot.warnings) {
      console.log(`Warning: ${warning}`)
    }
    return
  }

  let startedBy: 'daemon' | 'terminal' | undefined = undefined
  let permissionMode: PermissionMode | undefined = 'yolo'
  let model: string | undefined = undefined
  let effort: ReasoningEffort | undefined = undefined
  const sandboxArgs = extractNoSandboxFlag(args)
  const codexArgs = extractCodexResumeFlag(sandboxArgs.args)

  for (let i = 0; i < codexArgs.args.length; i++) {
    if (codexArgs.args[i] === '--started-by') {
      startedBy = codexArgs.args[++i] as 'daemon' | 'terminal'
    } else if (codexArgs.args[i] === '--permission-mode') {
      permissionMode = codexArgs.args[++i] as PermissionMode
    } else if (codexArgs.args[i] === '--model') {
      model = codexArgs.args[++i]
    } else if (codexArgs.args[i] === '--effort') {
      effort = codexArgs.args[++i] as ReasoningEffort
    } else if (codexArgs.args[i] === '--yolo') {
      permissionMode = 'yolo'
    }
  }

  if (!codexArgs.args.includes('--help') && !codexArgs.args.includes('-h')) {
    await promptInstallSlashCommandIfNeeded({ startedBy });
  }

  const { credentials } = await authAndSetupMachineIfNeeded()
  await ensureDaemonRunning({ startedBy })

  await runCodex({
    credentials,
    startedBy,
    noSandbox: sandboxArgs.noSandbox,
    resumeThreadId: codexArgs.resumeThreadId ?? undefined,
    permissionMode,
    model,
    effort,
  })
}
