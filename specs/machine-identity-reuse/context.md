# Context
- 2026-09-30 시작. 배경: Windows 설치기 테스트에서 재설치마다 새 머신 등록(3efcff4c→7216cd55→8b9f3631). 원인은 `auth logout` 의 `~/.happy` 전체 삭제 + 새 인증 시 UUID 재발급.
- 결정(사용자): 서버 write-once 완화 대신 CLI 가 machineId+machineKey 를 보관하는 방식.
- 구현: `src/machineIdentity.ts`(순수 판정), persistence identity 읽기/쓰기·legacy provisioning 키 주입, ui/auth 재사용·기록, commands/auth logout 보존·`--force` 삭제.
- 검증: 신규 테스트 16건(machineIdentity 7, ui/auth 5, commands/auth 2 + 기존 auth 2) Red→Green. 뮤테이션 2종(machineId 재사용 제거, legacy 키 주입 제거) 각각 해당 테스트 실패 확인. `pnpm run build` exit 0(tsc 포함).
- 전체 unit: 77 실패 = checkpoint 74(origin/main 동일 실패, 환경 기인) + 전체 동시 실행 시에만 실패하는 3개 파일(단독 실행 106/106 통과).
- 미검증: 실제 서버 계정으로 logout→login 후 같은 머신으로 붙는지(릴리스 후 Windows 실기에서 확인 예정).
- 셀프 리뷰 결함: 키가 발급됐던 legacy 계정이 재로그인 직후(계정 공개키 아직 없음) identity 를 덮어써 machineKey 를 잃음 → 같은 machineId 면 이전 값 계승(`buildMachineIdentity(..., previous)`), 회귀 테스트 Red→Green.
- 리뷰(low) 반영: `src/ui/auth.relogin.test.ts` — ink 선택·QR·`/v1/auth/request` 응답만 가짜로 두고 실제 logout→doAuth→machine setup 을 태워 dataKey 재로그인이 같은 machineId·machineKey 로 돌아오는지, 다른 계정은 새 머신·새 키인지 검증. 뮤테이션(auth.ts 의 machineKey 재사용 제거) 시 같은 계정 테스트 실패 확인.
