# Context

## 2026-10-03 Desktop #1326 후속

- prod image의 Happy afad342에는 reader 분리·#528·#531이 포함돼 있지만 peer 무응답은 지속된다. 현재 관측으로 Redis 지연/reader/peer 처리의 근본 원인을 확정하지 않았다.
- upstream adapter가 삼키던 XREAD 실패를 bus별 `redis_stream_read_failures_total{bus,code}`와 `redis_stream_read_duration_seconds{bus,result}`로 노출했다. 읽기 시간에는 BLOCK·네트워크·event-loop 대기가 포함된다. 오류 로그는 개인정보 없이 동일 bus/code당 1분에 1회 제한한다. Command timed out은 TIMEOUT으로 분류한다.
- account/managed 실제 adapter 실패 재현 Red→Green, 정상 read 재개·결과/오류 보존·observer 실패·종료 중 오류 배제 검증. shutdown guard 제거 mutation에서 테스트 실패를 확인했다. 관련 76테스트, 서버 typecheck/runtime build 통과했고 마지막 assertion 보강 후 집중 26테스트를 재검증했다.
- 로컬 구현만 완료했다. 다음은 새 metric 노출을 확인하는 서버 배포와 replica별 RPC timeout/read latency/write failure/lag/event-loop/Sentinel 시각 상관분석이다. 같은 조건의 24h timeout 증가율·실패율·지연 비교 전에는 이슈 해결로 표시하지 않는다.
- 상위 플랫폼의 `specs/machine-rpc-peer-timeouts/`에 배포 근거와 구체적인 다음 계획을 기록했다.
- 후속 코드 리뷰: 계측 시작의 performance.now 실패가 XREAD 호출을 누락시키는 문제를 성공·실패 두 회귀 테스트로 재현해 수정했다. 시계가 실패하면 계측만 생략하고 원래 read 인자·결과·예외를 보존한다. 시계 mock도 테스트 종료 시 복구한다.
- 최신 origin/main(d9608664) 기반에서 자체 diff 리뷰 완료. 관련 5개 파일 78테스트, typecheck/runtime build 및 diff check 통과. Happy 서버 PR을 준비하며 운영 적용·근본 원인 수정은 후속이다.

- 2026-09-23: 1·2단계 구현 완료 (브랜치 `fix/redis-restore-session-timeout`).
  - 세 가지 뮤테이션(재연결 제거, commandTimeout 제거, restore 시한 제거)을 각각
    테스트가 잡는 것을 확인했다.
  - restore 시한은 `null` 이 아니라 reject 로 끝낸다. adapter 의 선언 타입이
    `Promise<Session>` 이고, adapter 자신도 "세션 없음" 을 reject 로 알린다.
  - happy-server typecheck exit 0, vitest 119 files / 1525 tests 통과.
- 남은 일: 배포 후 관측(plan 3). Redis 멈춤의 근본 원인(sentinel tilt 반복 등)은 별건이다.
- 2026-09-23 셀프 리뷰 반영:
  - ioredis 가 시한 초과로 실패시킨 명령을 재연결 후 다시 보내는 것을 재현했다
    (`event_handler.js` 가 prevCommandQueue 를 거르지 않고 resend). resend 를 껐다.
  - 멈춤 재연결을 `redis_client_errors_total{code="STALL"}` 로 센다.
  - 테스트의 명령 시한을 100ms 에서 250ms 로 올렸다. 부하가 걸린 CI 에서 정상
    연결을 멈춤으로 오판하는 flake 를 막기 위해서다. 5회 반복 실행해 안정을 확인했다.
  - 확인만 하고 고치지 않은 것: adapter 폴링 루프는 에러를 삼키고 계속 돌고
    offset 을 유지한다. terminal 백엔드는 실패를 `tolerate` 로 감싸 두었다.
  - vitest 119 files / 1526 tests 통과, typecheck exit 0. resend 뮤테이션을 테스트가 잡는 것을 확인했다.
- 2026-09-23 23:14 추가 관측: 재연결이 풀린 뒤에도 버스가 죽어 있었다(peers 0, lag 61분,
  `rpc_calls_total{method="bash",result="not_available"}` 가 한쪽 파드에서만 증가).
  23:20~23:22 에 prod 파드를 하나씩 삭제했고, peers 1 / lag 0~2ms 로 복구된 것을 확인했다.
  PR 의 commandTimeout 이 있으면 멈춘 XREAD 가 5초에 실패하고 폴링 루프가 다시 돈다.
