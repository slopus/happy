import { authAndSetupMachineIfNeeded } from '@/ui/auth'
import { runCodex } from '@/codex/runCodex'
import { extractCodexResumeFlag } from '@/codex/cliArgs'
import { extractNoSandboxFlag } from '@/utils/sandboxFlags'
import { ensureDaemonRunning } from '@/daemon/ensureDaemonRunning'
import type { PermissionMode } from '@/api/types'
import type { ReasoningEffort } from '@/codex/codexAppServerTypes'
import { syncCodexHistory } from '@/codex/syncHistory'
import { updateSettings } from '@/persistence'

export async function handleCodexCommand(args: string[]): Promise<void> {
  if (args[0] === 'history') {
    if (args.slice(1).some(arg => !['--watch', '--stop', '--help', '-h'].includes(arg))) {
      throw new Error('Usage: happy codex history [--watch | --stop]')
    }
    if (args.includes('--help') || args.includes('-h')) {
      console.log('happy codex history: sync local Codex history into Happy without starting threads.\n--watch: also sync every five minutes; --stop: disable automatic sync.')
      return
    }
    if (args.includes('--stop')) {
      await updateSettings(settings => ({ ...settings, codexHistorySync: false }))
      return
    }
    const { credentials, machineId } = await authAndSetupMachineIfNeeded()
    console.log(JSON.stringify(await syncCodexHistory(credentials, machineId)))
    if (args.includes('--watch')) {
      await updateSettings(settings => ({ ...settings, codexHistorySync: true }))
      await ensureDaemonRunning()
    }
    return
  }
  let startedBy: 'daemon' | 'terminal' | undefined = undefined
  let permissionMode: PermissionMode | undefined = undefined
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

  const { credentials } = await authAndSetupMachineIfNeeded()
  await ensureDaemonRunning()

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
