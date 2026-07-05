import { runAcp } from '@/agent/acp'
import { ensureDaemonRunning } from '@/daemon/ensureDaemonRunning'
import { authAndSetupMachineIfNeeded } from '@/ui/auth'

export type KiroCommandOptions = {
  startedBy?: 'daemon' | 'terminal'
  compatAgent?: 'claude'
  verbose: boolean
  backendArgs: string[]
}

function readValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1]
  if (!value || value.startsWith('-')) {
    throw new Error(`Missing value for ${flag}`)
  }
  return value
}

export function parseKiroCommandArgs(args: string[]): KiroCommandOptions {
  let startedBy: 'daemon' | 'terminal' | undefined
  let compatAgent: 'claude' | undefined
  let verbose = false
  const backendArgs: string[] = []

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]

    if (arg === '--started-by') {
      startedBy = readValue(args, i, arg) as 'daemon' | 'terminal'
      i++
      continue
    }

    if (arg === '--happy-starting-mode') {
      readValue(args, i, arg)
      i++
      continue
    }

    if (arg === '--compat-agent') {
      const value = readValue(args, i, arg)
      if (value !== 'claude') {
        throw new Error(`Unsupported compat agent for Kiro: ${value}`)
      }
      // daemon 别名模式使用：实际运行 Kiro，但会话 metadata 对旧 App 保持 Claude 兼容。
      compatAgent = value
      i++
      continue
    }

    if (arg === '--verbose') {
      verbose = true
      continue
    }

    if (arg === '--permission-mode') {
      const mode = readValue(args, i, arg)
      if (mode === 'yolo' || mode === 'bypassPermissions') {
        backendArgs.push('--trust-all-tools')
      }
      i++
      continue
    }

    if (arg === '--yolo') {
      backendArgs.push('--trust-all-tools')
      continue
    }

    if (arg === '--model' || arg === '--effort' || arg === '--agent' || arg === '--agent-engine') {
      const value = readValue(args, i, arg)
      if (value !== 'default') {
        backendArgs.push(arg, value)
      }
      i++
      continue
    }

    if (arg === '--trust-all-tools') {
      backendArgs.push(arg)
      continue
    }

    if (arg === '--trust-tools') {
      backendArgs.push(arg, readValue(args, i, arg))
      i++
      continue
    }

    backendArgs.push(arg)
  }

  return { startedBy, compatAgent, verbose, backendArgs }
}

export function printKiroHelp(): void {
  console.log(`
happy kiro - Start Kiro CLI through Happy using ACP

Usage:
  happy kiro [options]

Options:
  --model <model>              Pass model to kiro-cli acp
  --effort <effort>            Pass effort to kiro-cli acp
  --permission-mode yolo       Trust all tools for this session
  --yolo                       Alias for --permission-mode yolo
  --trust-all-tools            Pass through to kiro-cli acp
  --trust-tools <names>        Pass through to kiro-cli acp
  --agent <agent>              Pass through to kiro-cli acp
  --agent-engine <engine>      Pass through to kiro-cli acp
  --verbose                    Print raw ACP backend/envelope events
`)
}

export async function handleKiroCommand(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    printKiroHelp()
    return
  }

  const parsed = parseKiroCommandArgs(args)
  const { credentials } = await authAndSetupMachineIfNeeded()
  await ensureDaemonRunning()

  await runAcp({
    credentials,
    startedBy: parsed.startedBy,
    verbose: parsed.verbose,
    // 兼容旧 App 的关键点：Claude UI 创建的会话仍用 Claude flavor，避免客户端不认识 Kiro。
    sessionFlavor: parsed.compatAgent === 'claude' ? 'claude' : undefined,
    compatAgent: parsed.compatAgent,
    agentName: 'kiro',
    command: 'kiro-cli',
    args: ['acp', ...parsed.backendArgs],
    keepSessionAliveAfterCancel: true,
  })
}
