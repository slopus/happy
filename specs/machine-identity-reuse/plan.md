# Plan
1. (Done) `src/machineIdentity.ts` 순수 판정 함수 + 테스트 (표식 계산·일치·재사용 결정)
2. (Done) persistence: identity 읽기/쓰기, `provisionLegacyMachineKey` 에 machineKey 주입
3. (Done) ui/auth: dataKey 자격 생성 시 machineKey 재사용, machineId 재사용, 완료 시 identity 기록
4. (Done) commands/auth: logout 보존, `--force` 삭제
5. 빌드·단위 테스트·typecheck, 로컬 격리 HAPPY_HOME 에서 logout→login 실측
