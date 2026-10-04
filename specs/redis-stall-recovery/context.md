# Context

## 2026-10-03 단발 지연 조사·계측 보완

- 배포된 Happy 2b9f283d에서 기존 read 계측 수집을 확인했지만 후속 lookup/presence timeout이 남았다. 성공 XREAD의 2~5초 bucket tail이 한 replica에서 6건 관측됐으며 개별 RPC와 인과관계는 미확정이다.
- 실제 prod 두 파드의 runtime 설정은 URL 모드 AWS ElastiCache였다. IDC Sentinel TILT/재시작/exporter는 다른 backend의 자료이므로 현재 원인 근거에서 제외한다.
- 별도 프로세스 30초 read-only 대조에서 양쪽 PING p99 약13~14ms, XREAD p99 약55~56ms, max 약206/112ms, 실패·500ms초과 0이었다. 같은 창의 앱 slow-read/timeout 증가도 0이라 문제발생 순간의 대조가 아니며 원인을 배제하지 못한다.
- Claude / claude-opus-5-5 / high 읽기 전용 조사 리뷰 완료. requester publish→peer read→peer publish→requester read가 조회 시한에 포함되고, 기존 p99만으로 단발 pause를 배제할 수 없다는 의견을 채택했다. URL READONLY 복구와 restoreSession 미취소는 현재 원인 증거가 없어 별도 후속으로 보류한다.
- event_loop_lag_max_seconds를 기존 p99와 동일 window에서 함께 샘플링한 뒤 한 번 reset한다. 성공 XREAD 1초 초과는 bus·소요 ms만 warn으로 기록하며 bus별 1분 throttle을 적용한다. 사용자/room/stream ID/credentials는 넣지 않는다.
- 3초 max가 누락되는 metrics 테스트와 slow-read 3개 테스트를 기존 코드에서 Red 확인했다. 최소 구현 후 metrics 3개·adapter 13개 Green, 관련 6파일 84테스트 통과. JSON/Prometheus text 모두 동일 window/reset 한번 검증. 최신 main(8839d058) 반영 시 서버 소스 차이는 없었다. stale Prisma 생성 타입을 현행 schema로 재생성한 뒤 서버 typecheck와 runtime build도 통과했다.
- Claude Opus 5.5/high 최종 변경 리뷰 approve. Happy 후속 read/wait가 out_of_scope, 새 spawn이 RPC method not available로 실패해 local Claude CLI의 같은 모델·effort로 코드와 prom-client 구현을 직접 전달했다(도구 비활성, modelUsage 확인). 등록 순서와 동기 collect는 현재 Registry의 text/JSON 경로에서 안전하고 테스트로 고정돼 있다. p99 인자99 assertion도 보강했다. 단일 max metric 조회는 새 수집을 하지 않고, 복수 scraper는 reset window를 나눌 수 있으므로 운영 비교에 같은 scrape series를 사용한다.
- commit/PR 이후 배포·운영 상관분석이 남는다. 재배포/운영 flag 변경/파드 재시작은 수행하지 않았다.
- 서버 구현 d761f665를 push하고 https://github.com/buzzni/happy/pull/672 (base main)을 생성했다. 소비 플랫폼은 이 PR merge 후 main의 merge commit을 가리키도록 맞춰야 하며 배포 검증과 #1326 해결 판정은 별도다.

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

## 2026-10-04 지연 원인 분류 계측

- prod에서 최대10.26초 event-loop 지연을 확인했다. raw scrape/read sum/CPU/restore 대조로도 GC·동기 실행·외부 CPU 대기를 분류하지 못했다. 상위 분석 근거는 specs/machine-rpc-peer-timeouts/2026-10-04-analysis.md에 있다.
- 기존 p99 collector에서 ELU snapshot delta와 GC observer 최대 보고 duration을 노출한다. label/timer/payload 로그를 추가하지 않는다. GC 비동기 보고는 사건과 다음 scrape로 갈라질 수 있어 인접 창을 함께 본다. ELU는 CPU 사용률이 아니며 NaN delta는0으로 내보낸다.
- GC 최대/reset/유효 duration 및 ELU delta3개 Red→Green. Opus5.5/high 변경 리뷰 approve. ELU NaN 회귀도 Red 확인 후 finite guard로 수정했다. 순서 의존과 문자열 assertion도 보강했다. 관련6파일88테스트/typecheck/runtime build 통과. 운영 image의 별도 Node20.20.2 프로세스에서 API 스모크도 통과했다.
- 원인 수정과 운영 해결은 미확정이다. 앱 프로세스 변경/재시작/flag 변경/운영 배포는 하지 않았다.
