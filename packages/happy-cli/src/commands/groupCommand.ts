import axios from 'axios'
import chalk from 'chalk'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

import { ApiClient } from '@/api/api'
import type { Credentials } from '@/persistence'
import { authAndSetupMachineIfNeeded } from '@/ui/auth'
import { configuration } from '@/configuration'
import { readSettings } from '@/persistence'
import { initialMachineMetadata } from '@/daemon/run'

type AgentType = 'codex' | 'claude'
type AgentRole = 'executor' | 'reviewer'

type GroupOptions = {
  name: string
  executor: AgentType
  reviewer: AgentType
  cwd: string
}

type KvItem = {
  key: string
  value: string
  version: number
}

export async function handleGroupCommand(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    printHelp()
    return
  }

  const options = parseGroupOptions(args)
  const { credentials } = await authAndSetupMachineIfNeeded()
  await runGroup(credentials, options)
}

async function runGroup(credentials: Credentials, options: GroupOptions): Promise<void> {
  const settings = await readSettings()
  if (!settings?.machineId) {
    throw new Error('No machine ID found in settings. Run happy auth first.')
  }

  const groupId = slugify(options.name)
  const api = await ApiClient.create(credentials)
  await api.getOrCreateMachine({
    machineId: settings.machineId,
    metadata: initialMachineMetadata,
  })

  await upsertKv(credentials, `group:${groupId}`, JSON.stringify({
    id: groupId,
    name: options.name,
    cwd: options.cwd,
    createdAt: Date.now(),
    sessions: [
      { tag: `group:${groupId}:executor`, role: 'executor', agent: options.executor },
      { tag: `group:${groupId}:reviewer`, role: 'reviewer', agent: options.reviewer },
    ],
  }))

  console.log(chalk.green(`Group "${options.name}" is ready.`))
  console.log(`Executor: ${options.executor}`)
  console.log(`Reviewer: ${options.reviewer}`)
  console.log(chalk.gray(`Starting both agents in ${options.cwd}...`))

  const children = [
    launchAgent(options.executor, {
      groupId,
      groupName: options.name,
      role: 'executor',
      sessionTag: `group:${groupId}:executor`,
      cwd: options.cwd,
    }),
    launchAgent(options.reviewer, {
      groupId,
      groupName: options.name,
      role: 'reviewer',
      sessionTag: `group:${groupId}:reviewer`,
      cwd: options.cwd,
    }),
  ]

  await Promise.all(children.map((child) => new Promise<void>((resolveChild, rejectChild) => {
    child.on('exit', (code) => {
      if (code === 0 || code === null) {
        resolveChild()
      } else {
        rejectChild(new Error(`Group agent exited with code ${code}`))
      }
    })
    child.on('error', rejectChild)
  })))
}

function launchAgent(agent: AgentType, opts: {
  groupId: string
  groupName: string
  role: AgentRole
  sessionTag: string
  cwd: string
}) {
  return spawn(process.execPath, [...process.execArgv, process.argv[1], agent], {
    cwd: opts.cwd,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: {
      ...process.env,
      HAPPY_GROUP_ID: opts.groupId,
      HAPPY_GROUP_NAME: opts.groupName,
      HAPPY_GROUP_AGENT_ROLE: opts.role,
      HAPPY_GROUP_SESSION_TAG: opts.sessionTag,
    },
  })
}

async function upsertKv(credentials: Credentials, key: string, value: string): Promise<void> {
  const existing = await getKv(credentials, key)
  const version = existing?.version ?? -1
  const response = await axios.post(
    `${configuration.serverUrl}/v1/kv`,
    { mutations: [{ key, value, version }] },
    {
      headers: {
        Authorization: `Bearer ${credentials.token}`,
        'Content-Type': 'application/json',
        'X-Happy-Client': `cli-coding-session/${configuration.currentCliVersion}`,
      },
    },
  )
  if (!response.data?.success) {
    throw new Error(`Failed to store group config for ${key}`)
  }
}

async function getKv(credentials: Credentials, key: string): Promise<KvItem | null> {
  try {
    const response = await axios.get<KvItem>(
      `${configuration.serverUrl}/v1/kv/${encodeURIComponent(key)}`,
      {
        headers: {
          Authorization: `Bearer ${credentials.token}`,
          'X-Happy-Client': `cli-coding-session/${configuration.currentCliVersion}`,
        },
      },
    )
    return response.data
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 404) {
      return null
    }
    throw error
  }
}

function parseGroupOptions(args: string[]): GroupOptions {
  return {
    name: readOption(args, '--name') ?? 'default-group',
    executor: parseAgent(readOption(args, '--executor') ?? 'codex', '--executor'),
    reviewer: parseAgent(readOption(args, '--reviewer') ?? 'claude', '--reviewer'),
    cwd: resolve(process.cwd()),
  }
}

function readOption(args: string[], key: string): string | undefined {
  const index = args.indexOf(key)
  if (index < 0) return undefined
  return args[index + 1]
}

function parseAgent(value: string, option: string): AgentType {
  if (value === 'codex' || value === 'claude') {
    return value
  }
  throw new Error(`${option} must be "codex" or "claude"`)
}

function slugify(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '') || 'default-group'
}

function printHelp(): void {
  console.log(`
${chalk.bold('happy group')} - Start a local Codex/Claude group

${chalk.bold('Usage:')}
  happy group --name <name> [--executor codex|claude] [--reviewer codex|claude]

${chalk.bold('Defaults:')}
  --executor codex
  --reviewer claude
`)
}
