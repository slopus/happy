import { authAndSetupMachineIfNeeded } from '@/ui/auth'
import { runAcp, resolveAcpAgentConfig } from '@/agent/acp'
import { ensureDaemonRunning } from '@/daemon/ensureDaemonRunning'

export async function handleDevinCommand(args: string[]): Promise<void> {
  let startedBy: 'daemon' | 'terminal' | undefined = undefined
  let verbose = false
  const passthroughArgs: string[] = []

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--started-by') {
      startedBy = args[++i] as 'daemon' | 'terminal'
    } else if (args[i] === '--happy-starting-mode') {
      i++ // skip value, consumed by daemon flow
    } else if (args[i] === '--verbose') {
      verbose = true
    } else {
      passthroughArgs.push(args[i])
    }
  }

  const resolved = resolveAcpAgentConfig(['devin', ...passthroughArgs])
  const { credentials } = await authAndSetupMachineIfNeeded()
  await ensureDaemonRunning()

  await runAcp({
    credentials,
    startedBy,
    verbose,
    agentName: resolved.agentName,
    command: resolved.command,
    args: resolved.args,
  })
}
