/**
 * BYOS 인증 원천 선택이 daemon 에 **실제로 배선됐는지** 본다 (AGENTS §1.13).
 *
 * `sessionEnv.test.ts` 는 순수 함수를 직접 불러 검증한다. 그 함수들을 spawn 경로가
 * 통과시키는지는 검사하지 않는다 — 누가 호출을 지워도 단위 테스트는 전부 통과하고,
 * 선택은 조용히 무시되어 사용자가 고르지 않은 자격으로 세션이 돈다. run.ts 의
 * spawnSession 은 거대한 클로저 안이라 단위로 부를 수 없으므로 소스 배선을 본다.
 */
import { describe, expect, it } from 'vitest'
import { MachineMetadataSchema } from '@/api/types'
import { AI_AUTH_SELECTION_CAPABILITY } from './sessionEnv'
import { initialMachineMetadata } from './run'

async function runSource(): Promise<string> {
  const { readFile } = await import('node:fs/promises')
  const { fileURLToPath } = await import('node:url')
  return readFile(fileURLToPath(new URL('./run.ts', import.meta.url)), 'utf8')
}

describe('capability 발행', () => {
  it('daemon 메타데이터가 선택 지원을 버전과 함께 광고한다', () => {
    expect(initialMachineMetadata.aiAuthSelection).toEqual({ version: 1 })
  })

  it('메타데이터 스키마가 그 capability 를 통과시킨다', () => {
    const parsed = MachineMetadataSchema.safeParse({
      ...initialMachineMetadata,
      aiAuthSelection: AI_AUTH_SELECTION_CAPABILITY,
    })
    expect(parsed.success).toBe(true)
  })

  it('버전은 닫혀 있다 — 모르는 세대를 아는 척하지 않는다', () => {
    const parsed = MachineMetadataSchema.safeParse({
      ...initialMachineMetadata,
      aiAuthSelection: { version: 2 },
    })
    expect(parsed.success).toBe(false)
  })

  it('capability 는 선택 사항이다 — 없는 메타데이터도 유효하다', () => {
    const { aiAuthSelection: _omitted, ...withoutCapability } = initialMachineMetadata
    expect(MachineMetadataSchema.safeParse(withoutCapability).success).toBe(true)
  })
})

describe('배선 가드: spawn 이 선택을 존중하고 검증하는가', () => {
  it('machine-personal 이 관리 자격 해석 자체를 막는다', async () => {
    const text = await runSource()
    // 해석 결과를 버리는 것이 아니라 아예 해석하지 않아야 빈 객체가 overlay 된다.
    expect(text).toMatch(
      /honorsManagedAiCredentials\(options\.aiAuthSelection\)\s*\n?\s*\?\s*await resolveManagedAiCredentialEnvironment\(/,
    )
  })

  it('새 spawn 은 요청 선택을, resume 은 기록된 setup-token 결합을 관리 자격 해석에 넘긴다', async () => {
    const text = await runSource()
    // Resume re-binds exactly the session's own recorded setup-token, never the machine default.
    expect(text).toMatch(/const resumeBinding = readSetupTokenResumeSelection\(tracked\.agentEnvironment\);/)
    expect(text).toMatch(/await resolveManagedAiCredentialEnvironment\(\s*resumeAgent,\s*resumeBinding\?\.selection,\s*resumeBinding\?\.caller,?\s*\)/)
    // A new spawn names its caller from the consumed MCP grant, never from the selection itself.
    expect(text).toMatch(/resolveManagedAiCredentialEnvironment\(options\.agent, options\.aiAuthSelection, mcpCallerGrantCaller\(mcpCallerGrant\)\)/)
    expect(text).toMatch(/aiCredentialRuntime\.sessionEnvironment\(agent, selection, caller\)/)
  })

  it('두 spawn 경로가 자식에게 건네는 바로 그 env 를 검증한다', async () => {
    const text = await runSource()
    const checks = [...text.matchAll(/verifyAiAuthSelection\(options\.aiAuthSelection, (\w+)\)/g)]
      .map((match) => match[1])
    expect(checks).toEqual(['tmuxEnv', 'spawnEnvironment'])
    // 검증 대상이 최종 env 인지: 두 이름 모두 헬퍼가 만든 값이고 자식에게 그대로 간다.
    expect(text).toMatch(/const tmuxEnv = applyAppliedAiAuthSourceEnv\(/)
    expect(text).toMatch(/const spawnEnvironment = applyAppliedAiAuthSourceEnv\(/)
    expect(text).toMatch(/\}, tmuxEnv\)/)
    expect(text).toMatch(/env: spawnEnvironment,/)
  })

  it('어긋난 선택이 spawn 을 실제로 멈춘다 — 사유와 함께', async () => {
    const text = await runSource()
    const rejections = [...text.matchAll(
      /if \((\w+)\.rejection\) \{\s*\n\s*return finishSpawn\(Promise\.resolve\(\{\s*\n\s*type: 'error',\s*\n\s*errorMessage: \1\.rejection,/g,
    )]
    expect(rejections).toHaveLength(2)
  })

  it('적용된 원천이 spawn 결과에 실린다', async () => {
    const text = await runSource()
    const passes = [...text.matchAll(/finishSpawn\([\s\S]{0,400}?, (\w+)\.appliedSource\)/g)]
    expect(passes).toHaveLength(2)
    // 넘기기만 하고 결과에 안 합치면 값은 조용히 사라진다 — 뮤테이션으로 확인한 구멍.
    expect(text).toMatch(/\.\.\.result,\s*appliedAiAuthSource\s*\}/)
  })
})
