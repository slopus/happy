---
기능: org-ai-duplicate-refresh
상태: 로컬 구현 및 검증 완료 / 릴리스 대기
마지막 갱신: 2026-10-02
---

# 현재 상태

최신 Happy main 62ff8ec8에서 codex/org-ai-duplicate-refresh로 작업했다. 사용자 후속 지시로 Happy 중복 갱신만 먼저 완료하고 Desktop 온보딩 작업은 보류했다.

Claude merge에서 이메일·조직 UUID가 일치하는 enabled 로컬 계정만 실제 요청으로 검사한다. AUTHENTICATION_FAILED일 때만 공용 후보를 실제 요청으로 검사하고 통과한 인증을 기존 repair 적용 경로로 갱신한다. 다른 오류·disabled·공용 인증 실패는 로컬 인증을 보존한다. 갱신한 active는 force switch로 live 인증에 반영하고 개인 계정·순서·회전 설정은 보존한다. 기존 active가 없으면 기존 merge의 최초 활성화 정책이 이어진다.

검사 후 export를 다시 비교해 그동안 로그인/refresh로 바뀐 인증을 덮어쓰지 않는다. 새 계정은 기존 추가 흐름을 유지하며, 중복 갱신을 하지 못해도 신규 계정은 추가할 수 있다. 갱신된 계정만 공용 provenance에 포함한다.

## 검증

명령: pnpm -C packages/happy-cli exec vitest run --project unit src/daemon/aiCredentialRuntime.test.ts src/daemon/aiCredentialVerification.test.ts src/daemon/managedRpcHandlers.test.ts

3파일 366건 통과. Vitest 표준 global setup의 TypeScript·pkgroll build 통과, git diff --check 통과. 관련 테스트만 실행했고 전체 suite는 실행하지 않았다. 실제 공급자 요청·운영 머신 인증 적용은 하지 않았다. 기존 bin/empty-chunk 경고는 변경 전 실패 재현에서도 동일했다. Happy에 별도 lint task/config는 없다.

## 제약과 다음 단계

- 검사 로컬→공용→적용 후 단계별 요청 예산은 60초다. 검증기의 기본 240초는 유지하며 개별 요청/모델 fallback도 남은 예산을 넘기지 않는다. 예산 밖/네트워크/한도는 인증 무효로 취급하지 않는다.
- 이 검사는 현재 access token을 사용하며 격리 검증에서 refresh token을 회전시키지 않는다. 설정됨은 모든 계정이 실제 요청 성공했다는 의미가 아니다.
- Codex 중복 정책, 수동 repair, 서버 권한·API·스키마, 웹/데스크탑 UI는 변경하지 않았다.
- 버전은 기존 .275를 유지한다. push·tag·npm 릴리스·vendor pointer·Desktop runtime pin·대상 머신 업데이트는 수행하지 않았다.
- 이후 릴리스할 정확한 버전과 외부 동작을 제시해 승인받아야 한다. 공식 CLI 릴리스 후 대상 머신 업데이트 및 별도 Desktop 온보딩 작업을 진행한다.

## 파일

- packages/happy-cli/src/daemon/aiCredentialRuntime.ts 및 기존 테스트
- packages/happy-cli/src/daemon/aiCredentialVerification.ts 및 기존 테스트

## 2026-10-02 후속 구현

개인 인증을 먼저 로컬 풀에 보관해 미등록 때문에 차단되던 merge를 해소했다. Claude의 live 미등록 identity를 add하고 Codex는 auth.json OAuth를 로컬 풀에 보관한다. 사용자 요청으로 Codex 무효 중복 갱신 및 optional activeAccountIndex를 구현했다. 해당 공용·설치 인증이 유효할 때만 강제 전환한다. Codex 도구는 auth sync 실패여도 exit 0을 반환하므로 pool index뿐 아니라 실제 auth.json을 검사하고 실패 시 이전 live 파일·pool 복구를 시도한다. 기본 mode는 유효 active를 유지하며 enabled/disabled·pin·family index를 보존한다. 관련 4파일 435건·TypeScript·pkgroll build·diff check 통과. 운영/provider 실요청은 미실행. 웹 UI/API는 별도 codex/org-ai-account-apply 브랜치에 구현했다. 릴리스·push·태그·원본 vendor pointer 변경은 실행하지 않았다.
