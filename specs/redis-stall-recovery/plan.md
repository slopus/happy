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

## 단발 지연 관측 후속

1. [Done] 실제 prod backend 확인 및 Claude Opus 5.5/high 조사 리뷰: ElastiCache URL 모드, Sentinel 자료 제외, 원인 미확정.
2. [Done] 동일 window p99/max와 성공 slow-read의 bus별 throttle 회귀 Red→Green. shutdown·polling 보존.
3. [Done] Opus 5.5/high 변경 리뷰 approve, 관련 84테스트·typecheck/runtime build와 diff check 통과. p99 인자 assertion도 보강했다.
4. [Done] commit/push 및 Happy PR #672 생성. 소비 플랫폼 PR은 Happy merge를 기다리는 Draft로 준비한다.
5. [ ] 배포 후 replica별 timeout/slow-read/event-loop max 상관분석과 같은 조건의 24h 비교. 관측 배포만으로 #1326 해결 판정하지 않는다.

## 2026-10-04 지연 원인 분류

1. [Done] 운영 10.26초 지연과 기존 신호의 분류 공백 확인.
2. [Done] GC 최대 보고 duration/ELU scrape delta 회귀 Red→Green. p99/max 수집 계약 유지.
3. [Done] Opus 리뷰 approve, 관련88테스트/typecheck/runtime build 및 Node20 API 스모크 통과. 커밋·PR로 제공한다. 서버 변경은 근본 원인 수정이 아닌 판별 계측이다.
