/**
 * `happy datakey` — 머신 credential 의 dataKey-활성 전환 관리
 * (aplus §6-1, specs/e2ee-cli-datakey-activation).
 *
 * 판단은 전부 src/datakey/activation.ts 의 순수 plan 함수가 내리고,
 * 이 파일은 파일/네트워크 I/O 와 출력만 담당한다 — 게이트 실패 시
 * credential 은 바이트 단위로 무변경(AC3).
 */
import chalk from 'chalk'
import axios from 'axios'
import { existsSync } from 'node:fs'
import { readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { configuration } from '@/configuration'
import {
  acquireDaemonLock,
  parseCredentials,
  readSettings,
  releaseDaemonLock,
  replaceCredentialsDataKey,
  updateSettings,
  writePrivateFile,
} from '@/persistence'
import {
  planDataKeyActivation,
  planDataKeyDeactivation,
  describeDataKeyStatus,
  type ActivationGateFailure,
} from '@/datakey/activation'
import { describeMachineControl } from '@/datakey/machineControlStatus'
import { hardenBlockingSessions, runHarden } from '@/datakey/hardenTransition'
import { findAllHappyProcesses } from '@/daemon/doctor'
import { rotateMachineAutomationKey } from '@/daemon/automations/machineAutomationKey'
import { pendingMachineKeyRotationFile } from '@/datakey/machineControlIo'

const backupFile = () => join(configuration.happyHomeDir, 'access.key.legacy-backup')

async function readRawJson(path: string): Promise<unknown | null> {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

/** 임시 파일 + rename — 전원 차단에도 반쪽 파일이 남지 않게. 소유자 전용(0600). */
async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.tmp`
  await writePrivateFile(tmp, JSON.stringify(value, null, 2))
  await rename(tmp, path)
}

type ServerMachineEnvelopes = {
  dataEncryptionKey?: string | null
  serverDataEncryptionKey?: string | null
  serverRpcKeyEnvelope?: string | null
}

async function fetchServerMachine(machineId: string, token: string): Promise<ServerMachineEnvelopes | null> {
  const response = await axios.get<{ machine?: ServerMachineEnvelopes }>(
    `${configuration.serverUrl}/v1/machines/${encodeURIComponent(machineId)}`,
    { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 },
  )
  return response.data.machine ?? null
}

async function fetchServerEnvelope(machineId: string, token: string): Promise<string | null> {
  return (await fetchServerMachine(machineId, token))?.dataEncryptionKey ?? null
}

const GATE_MESSAGES: Record<ActivationGateFailure, string> = {
  'no-credentials': 'credentials(access.key)가 없거나 파싱할 수 없습니다. `happy auth login` 먼저 실행하세요.',
  'already-datakey': '이미 dataKey-활성 상태입니다. 되돌리려면 `happy datakey deactivate`.',
  'not-provisioned': 'dataKey 재료가 병기되지 않은 legacy credential 입니다. dataKey 계정으로 재인증(`happy auth login`) 후 다시 시도하세요.',
  'no-machine-id': 'settings 에 machineId 가 없습니다. daemon 을 한 번 시작해 머신 등록을 마친 뒤 다시 시도하세요.',
  'server-envelope-missing': '서버 machine 레코드에 dataEncryptionKey 봉투가 없습니다. daemon 을 재시작해 머신 재등록 후 다시 시도하세요.',
  'server-unreachable': '서버에서 machine 레코드를 확인하지 못했습니다(네트워크/서버 오류). 전환하지 않았습니다.',
}

export async function handleDataKeyCommand(args: string[]): Promise<void> {
  const subcommand = args[0]
  switch (subcommand) {
    case 'status':
      await handleStatus()
      return
    case 'activate':
      await handleActivate()
      return
    case 'deactivate':
      await handleDeactivate()
      return
    case 'harden':
      await handleHarden()
      return
    case 'compat':
      await handleCompat()
      return
    default:
      showHelp()
      if (subcommand && subcommand !== 'help' && subcommand !== '--help' && subcommand !== '-h') {
        process.exit(1)
      }
  }
}

function showHelp(): void {
  console.log(`
${chalk.bold('happy datakey')} - dataKey-활성 전환 관리 (aplus §6-1)

${chalk.bold('Usage:')}
  happy datakey status       현재 활성 variant, 백업, 머신 제어 모드 표시
  happy datakey activate     legacy(+병기 재료) → dataKey-활성 전환
  happy datakey deactivate   백업으로 legacy-활성 복원
  happy datakey harden       strict 머신 제어: 서버가 머신 키를 갖지 못하게 함(daemon 을 멈춘 뒤 실행)
  happy datakey compat       compat 머신 제어로 복귀(서버가 머신 키 사본을 다시 받음)

${chalk.gray('activate 는 (1) 병기 재료 존재 (2) machineId 존재 (3) 서버 machine')}
${chalk.gray('레코드의 dataEncryptionKey 봉투 존재를 전부 확인한 뒤에만 전환하며,')}
${chalk.gray('하나라도 실패하면 credential 을 바꾸지 않습니다. 원본은')}
${chalk.gray('access.key.legacy-backup 으로 보존됩니다. 전환/복원 후에는')}
${chalk.gray('daemon 재시작이 필요합니다: happy daemon stop && happy daemon start')}
`)
}

async function handleStatus(): Promise<void> {
  const status = describeDataKeyStatus({
    rawCredentials: await readRawJson(configuration.privateKeyFile),
    rawBackup: await readRawJson(backupFile()),
  })
  const variantLabel = {
    none: chalk.red('credentials 없음'),
    legacy: chalk.yellow('legacy-활성 (병기 재료 없음)'),
    'legacy-provisioned': chalk.yellow('legacy-활성 + dataKey 재료 병기 (activate 가능)'),
    dataKey: chalk.green('dataKey-활성'),
  }[status.variant]
  console.log(`variant: ${variantLabel}`)
  console.log(`backup:  ${status.hasBackup ? chalk.green('있음') : chalk.gray('없음')} (${backupFile()})`)
  await printMachineControlStatus()
}

/** aplus-dev-studio specs/e2ee-machine-control-boundary R17. */
async function printMachineControlStatus(): Promise<void> {
  const settings = await readSettings()
  const rawCredentials = await readRawJson(configuration.privateKeyFile)
  const control = describeMachineControl({
    mode: settings.machineControl === 'strict' ? 'strict' : 'compat',
    rawCredentials,
    rawPending: await readRawJsonOrUnreadable(pendingMachineKeyRotationFile()),
  })
  const modeLabel = control.mode === 'compat'
    ? chalk.yellow('compat (서버가 머신 키 사본을 받을 수 있음)')
    : control.inForce
      ? chalk.green('strict (적용됨)')
      : chalk.red('strict (아직 적용 안 됨 — daemon 을 재시작하면 머신 키를 교체합니다)')
  const keyLabel = {
    none: chalk.red('없음'),
    'account-secret': chalk.yellow('계정 비밀(legacy) — 서버가 알고 있음'),
    'may-be-escrowed': chalk.yellow('서버가 사본을 가졌을 수 있는 키'),
    'never-escrowed': chalk.green('서버에 보낸 적 없는 키'),
  }[control.key]
  console.log(`machine control: ${modeLabel}`)
  console.log(`machine key:     ${keyLabel}`)
  if (control.pending) {
    const when = control.pending.lastAttemptAt ? ` (${new Date(control.pending.lastAttemptAt).toLocaleString()})` : ''
    const why = control.pending.lastError ? ` — 마지막 실패: ${control.pending.lastError}${when}` : ''
    console.log(`key rotation:    ${chalk.yellow(`진행 중${why}`)}`)
  }

  const token = (rawCredentials as { token?: string } | null)?.token
  if (!settings.machineId || !token) return
  let machine: ServerMachineEnvelopes | null
  try {
    machine = await fetchServerMachine(settings.machineId, token)
  } catch (error) {
    const missing = axios.isAxiosError(error) && error.response?.status === 404
    console.log(`server:          ${chalk.gray(missing ? '등록된 머신 레코드 없음' : '확인하지 못함(네트워크/서버 오류)')}`)
    return
  }
  if (!machine) {
    console.log(`server:          ${chalk.gray('등록된 머신 레코드 없음')}`)
    return
  }
  console.log(`server:          머신 키 서버 봉투 ${machine.serverDataEncryptionKey ? chalk.yellow('있음') : chalk.green('없음')}, `
    + `서버 레인 키 봉투 ${machine.serverRpcKeyEnvelope ? '있음' : '없음'}`)
}

async function readRawJsonOrUnreadable(path: string): Promise<unknown | null> {
  if (!existsSync(path)) return null
  return (await readRawJson(path)) ?? {}
}

async function handleHarden(): Promise<void> {
  const outcome = await runHarden({
    readState: async () => ({
      mode: (await readSettings()).machineControl === 'strict' ? 'strict' : 'compat',
      rawCredentials: await readRawJson(configuration.privateKeyFile),
      pendingExists: existsSync(pendingMachineKeyRotationFile()),
    }),
    lockDaemonStart: async () => {
      // Two attempts: the first may only clear a lock its dead holder left.
      const handle = await acquireDaemonLock(2, 0)
      return handle ? () => releaseDaemonLock(handle) : null
    },
    liveSessions: async () => hardenBlockingSessions(await findAllHappyProcesses()),
    dropNeverEscrowed: async () => {
      const credentials = parseCredentials(await readRawJson(configuration.privateKeyFile))
      if (credentials?.encryption.type !== 'dataKey') return
      await replaceCredentialsDataKey({
        token: credentials.token,
        publicKey: credentials.encryption.publicKey,
        machineKey: credentials.encryption.machineKey,
      })
    },
    discardPendingRotation: () => rm(pendingMachineKeyRotationFile(), { force: true }),
    rotateAutomationKey: async () => rotateMachineAutomationKey(configuration.automationKeyFile),
    setStrict: async () => {
      await updateSettings((settings) => ({ ...settings, machineControl: 'strict' }))
    },
  })
  if (!outcome.ok && outcome.reason === 'sessions-running') {
    console.error(chalk.red('전환하지 않음: 실행 중인 happy 세션이 있습니다.'))
    console.error(chalk.gray('세션은 daemon 을 멈춰도 남습니다. compat 때 시작한 세션은 strict 로 바꾼 뒤에도 compat 설정과, 서버가 읽을 수 있었던 세션 키로 계속 동작합니다.'))
    for (const session of outcome.sessions) console.error(`  PID ${session.pid}  ${session.command.slice(0, 120)}`)
    console.error(chalk.gray('세션을 모두 끝낸 뒤 다시 실행하세요. daemon 이 띄운 세션은 `happy doctor clean` 으로 정리할 수 있습니다.'))
    process.exit(1)
  }
  if (!outcome.ok) {
    const message = {
      'no-credentials': 'credentials(access.key)가 없거나 파싱할 수 없습니다. `happy auth login` 먼저 실행하세요.',
      'not-datakey': 'legacy credential 의 머신 키는 서버가 아는 계정 비밀입니다. 먼저 `happy datakey activate` 로 dataKey-활성 전환하세요.',
      'daemon-running': 'daemon 이 실행 중이거나 시작하는 중입니다. compat daemon 이 도는 동안에는 서버가 머신 키로 이 머신의 파일을 쓸 수 있습니다. `happy daemon stop` 으로 멈춘 뒤 다시 실행하세요.',
    }[outcome.reason]
    console.error(chalk.red(`전환하지 않음: ${message}`))
    process.exit(1)
  }
  if (outcome.markedStrict) {
    // The strict mark is settings.json, which compat could write too, so it is not trusted.
    console.log(chalk.yellow('이미 strict 로 표시돼 있었지만, 그 표시도 compat 동안 서버가 쓸 수 있었으므로 다시 전환합니다.'))
    console.log(chalk.gray('다음 시작에서 머신 키를 새로 만듭니다. 이 머신의 키를 확인했던 클라이언트는 지문을 다시 확인해야 합니다.'))
  }
  console.log(chalk.green('strict 머신 제어로 설정했습니다.'))
  if (outcome.reset.neverEscrowed || outcome.reset.pending) {
    console.log(chalk.gray('compat 동안 남은 키 표시와 교체 기록은 서버가 쓸 수 있었으므로 지웠습니다.'))
  }
  if (outcome.reset.automationKey) {
    console.log(chalk.gray('자동화 키도 새로 만들었습니다. 이 머신의 기존 자동화는 다시 저장해야 실행됩니다.'))
  }
  console.log(chalk.bold('daemon 을 시작하세요:'))
  console.log('  happy daemon start')
  console.log(chalk.gray('시작할 때 daemon 이 머신 키를 새로 만들고 서버의 머신 키 사본을 지웁니다.'))
  console.log(chalk.gray('서버에 닿지 못하면 daemon 은 시작하지 않습니다(이전 키로 동작하지 않음).'))
  console.log(chalk.gray('적용 여부는 `happy datakey status` 의 machine control 줄로 확인하세요.'))
  console.log(chalk.gray('strict 에서는 서버가 머신 키로 새 요청을 만들 수 없어, 파일·명령·세션 시작을 직접 실행하지 못합니다.'))
}

async function handleCompat(): Promise<void> {
  await updateSettings((settings) => ({ ...settings, machineControl: 'compat' }))
  console.log(chalk.yellow('compat 머신 제어로 설정했습니다.'))
  console.log(chalk.bold('daemon 재시작이 필요합니다:'))
  console.log('  happy daemon stop && happy daemon start')
  console.log(chalk.gray('다음 시작에서 서버가 머신 키 사본을 다시 받아 이 머신의 모든 원격 기능을 호출할 수 있게 됩니다.'))
}

async function handleActivate(): Promise<void> {
  const rawCredentials = await readRawJson(configuration.privateKeyFile)
  const settings = await readSettings()
  const token = (rawCredentials as { token?: string } | null)?.token
  const result = await planDataKeyActivation({
    rawCredentials,
    machineId: settings?.machineId ?? null,
    fetchServerEnvelope: (machineId) => {
      if (!token) throw new Error('token missing')
      return fetchServerEnvelope(machineId, token)
    },
  })
  if (!result.ok) {
    console.error(chalk.red(`전환하지 않음: ${GATE_MESSAGES[result.reason]}`))
    process.exit(1)
  }
  // 백업 먼저, credential 은 원자적 재작성 — 중간 실패 시에도 원본이 남는다.
  await writeJsonAtomic(backupFile(), result.backup)
  await writeJsonAtomic(configuration.privateKeyFile, result.serialized)
  console.log(chalk.green('dataKey-활성으로 전환했습니다.'))
  console.log(`원본 백업: ${backupFile()}`)
  console.log(chalk.bold('daemon 재시작이 필요합니다:'))
  console.log('  happy daemon stop && happy daemon start')
  console.log(chalk.gray('이후 신규 세션은 세션별 DEK(계정 공개키 단독 수신자)로 등록됩니다.'))
  console.log(chalk.gray('기존 세션은 세션별 로컬 키로 계속 동작합니다.'))
}

async function handleDeactivate(): Promise<void> {
  const result = planDataKeyDeactivation({
    rawCredentials: await readRawJson(configuration.privateKeyFile),
    rawBackup: await readRawJson(backupFile()),
  })
  if (!result.ok) {
    const message = {
      'not-datakey': '현재 credential 이 dataKey-활성이 아닙니다 — 복원할 것이 없습니다.',
      'no-backup': `백업(${backupFile()})이 없습니다. 복원할 수 없습니다.`,
      'backup-invalid': '백업이 legacy credential 로 파싱되지 않습니다. 복원하지 않았습니다.',
    }[result.reason]
    console.error(chalk.red(`복원하지 않음: ${message}`))
    process.exit(1)
  }
  await writeJsonAtomic(configuration.privateKeyFile, result.restored)
  console.log(chalk.green('legacy-활성으로 복원했습니다.'))
  console.log(chalk.bold('daemon 재시작이 필요합니다:'))
  console.log('  happy daemon stop && happy daemon start')
  console.log(chalk.gray('전환 중 만들어진 dataKey 세션은 세션별 로컬 키로 계속 동작합니다(세션 단위 공존).'))
}
