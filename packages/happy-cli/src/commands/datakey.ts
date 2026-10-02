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
import { readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { configuration } from '@/configuration'
import { readSettings, writePrivateFile } from '@/persistence'
import {
  planDataKeyActivation,
  planDataKeyDeactivation,
  describeDataKeyStatus,
  type ActivationGateFailure,
} from '@/datakey/activation'

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

async function fetchServerEnvelope(machineId: string, token: string): Promise<string | null> {
  const response = await axios.get<{ machine?: { dataEncryptionKey?: string | null } }>(
    `${configuration.serverUrl}/v1/machines/${encodeURIComponent(machineId)}`,
    { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 },
  )
  return response.data.machine?.dataEncryptionKey ?? null
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
  happy datakey status       현재 활성 variant 와 백업 상태 표시
  happy datakey activate     legacy(+병기 재료) → dataKey-활성 전환
  happy datakey deactivate   백업으로 legacy-활성 복원

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
