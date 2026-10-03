# Plan

1. [Done] restoreSession 시한 — `createIsolatedRedisAdapter.ts` → 검증: 멈춘 restore 가 3초에 reject, 빠른 결과는 그대로
2. [Done] Redis 명령 시한 + 멈춤 감지 후 재연결 — `createRedisClient.ts` → 검증: 응답을 멈추는 가짜 RESP 서버로 명령 실패·연결 교체·정상 연결 유지
3. [ ] prod 배포 후 확인 — `restoreSession exceeded` / `redis connection stopped answering` 로그와 재연결 폭풍 부재

## Desktop #1326 후속 (2026-10-03)

1. [Done] prod 배포 포인터에서 reader 분리·#528·#531 포함 확인.
2. [Done] XREAD 실패가 upstream poll loop에서 삼켜지는 실제 adapter 회귀 테스트.
3. [Done] account/managed 읽기 실패·소요시간 계측 및 TIMEOUT 분류. 원래 polling·종료·결과·예외 보존.
4. [Done] 관련 테스트·typecheck·build 및 운영 검증 절차 기록. 로컬 검증과 운영 해결을 구분.
5. [Done] 후속 코드 리뷰·보강: 계측 시작 시계 실패가 실제 read를 막지 않게 한다. 실패 회귀 두 건→최소 수정→관련 78테스트/typecheck/build 통과.
