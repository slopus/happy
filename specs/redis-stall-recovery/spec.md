# Redis 연결 멈춤에도 소켓 재연결이 막히지 않게 한다

## 배경 — 2026-09-23 prod 장애 (KST 22:15 ~ 22:32)

- happy-server 두 replica 에서 Redis 연결이 half-open 으로 멈췄다. TCP 는 살아 있고
  응답만 오지 않았다. 22:32 에 `redis client error (ECONNRESET)` 가 찍히며 풀렸다.
- 그 17분 동안 **재연결하는 모든 클라이언트** 가 연결하지 못했다. ingress 로그를
  보면 WebSocket 은 파드까지 101 로 올라오지만 전부 정확히 20초(클라이언트
  connect timeout) 뒤 닫혔다. 인증 미들웨어 로그(`Token verified`)도 거의 없었다.
- 원인: `connectionStateRecovery` 가 켜져 있으면 socket.io 는 `pid` 를 가진
  재연결 클라이언트에 대해 **인증 미들웨어보다 먼저**
  `adapter.restoreSession()`(Redis `MULTI GET/DEL` + `XRANGE`)을 await 한다
  (`socket.io/dist/namespace.js` `_createSocket`). ioredis 에는 명령 시한이
  없었으므로 이 await 가 끝나지 않았다.
- 증상: daemon 머신 소켓이 RPC room 에서 빠져 desktop 에
  `Worktree 기준 branch를 확인하지 못했습니다. RPC method not available` 이
  표시됐다. daemon 을 재시작하면 새 프로세스는 `pid` 가 없어 이 단계를
  건너뛰므로 바로 붙었다.
- 22:32 에 소켓 재연결은 풀렸지만 **replica 간 버스는 계속 죽어 있었다.**
  23:14 에 두 파드 모두 `socketio_cluster_peers=0`, `redis_stream_lag_ms≈61분`이었다.
  adapter 의 `XREAD` 폴링이 응답 없는 명령을 기다린 채 멈춰 있었고, 각 파드는
  자기 파드에 붙은 소켓만 봤다. 그래서 daemon 과 다른 파드에 붙은 호출은
  `RPC method not available` 을 받았다. desktop 은 호출마다 새 소켓을 열어서
  이 증상이 잦았다. 23:20 에 파드를 하나씩 재시작하자 복구됐다.
- TCP 수준 감지로는 부족하다. 보낸 데이터가 ACK 되지 않은 경우에는 커널
  재전송 한도(~15분)까지 버틴다. 요청이 ACK 됐는데 응답만 오지 않는 경우에는
  keepalive 가 적용되지만, OS 기본값이 2시간이다. 어느 쪽이든 명령 수준 시한이
  필요하다.
- Redis 가 왜 멈췄는지는 확인하지 못했다. sentinel-0/2 가 사고 전부터 tilt 모드를
  반복하고 있었지만 직접 원인이라고 단정할 수 없다.

## 요구사항

1. `restoreSession` 이 `RESTORE_SESSION_TIMEOUT_MS`(3초) 안에 끝나지 않으면
   reject 한다. socket.io 는 이를 "복구할 세션 없음" 으로 처리해 일반 연결을
   진행한다. 빠진 이벤트는 클라이언트의 기존 REST 재조회 경로가 메운다.
2. 모든 `createRedisClient()` 클라이언트는 명령 시한(`commandTimeout` 5초)을 갖는다.
   어떤 호출자도 멈춘 연결에서 무기한 기다리지 않는다.
3. `ready` 상태의 클라이언트는 5초마다 PING 한다. PING 이 **연속 3번** 명령 시한을
   넘기면 연결을 교체(`disconnect(true)`)한다. `disconnectTimeout` 뒤 소켓을 destroy
   하므로 half-open 에서도 멈추지 않고, Sentinel 모드에선 master 를 다시 묻는다.
   명령 시한만으로는 연결이 그대로 남기 때문에 이 교체가 필요하다.
   한 번 늦은 응답(RDB fork, 오래 걸리는 단일 명령, GC)은 멈춤이 아니다. 그걸로
   연결을 버리면 `ready` 가 아닌 구간이 생겨 그동안 명령이 offline 큐에서 각자의
   시한까지 기다리기만 한다. 멈춤은 지속되는 침묵이므로 연속 실패만 센다.
4. 두 경로 모두 1분에 한 번으로 제한된 로그를 남긴다 (AGENTS.md §1.13).
5. 끊긴 연결에서 응답을 받지 못한 명령은 새 연결에서 다시 보내지 않는다
   (`autoResendUnfulfilledCommands: false`). ioredis 는 기본적으로 이미
   `commandTimeout` 으로 실패를 알린 명령까지 다시 보낸다. 그러면 호출자가 포기한
   버스 메시지(RPC 요청 등)가 뒤늦게 전달된다. resend 를 꺼도 모든 클라이언트에
   명령 시한이 있으므로, 끊긴 연결의 명령이 영원히 pending 으로 남지 않는다.
6. 멈춤 감지로 인한 재연결은 `redis_client_errors_total{code="STALL"}` 로 센다.

## Desktop #1326 후속: 스트림 reader 관측

기존 수정이 포함된 배포에서도 peer 응답 누락이 관측됐다. XREAD 실패는 upstream
poll loop가 debug로만 삼키므로 읽기 실패·소요시간을 account/managed bus별로 센다.
소요시간은 Redis BLOCK 대기·네트워크·event-loop 지연을 포함하며 순수 Redis 실행
시간으로 부르지 않는다. 오류 로그는 bus/오류 코드만 담아 1분에 1번 제한한다.
`Command timed out`은 TIMEOUT으로 분류한다. shutdown disconnect와 관측 실패는
버스 장애를 만들지 않아야 하고, 원래 XREAD 인자·결과·예외·poll 재시도를 보존한다.
조회 시한·최신 머신 선택·권한·원격 replica 수집 계약은 변경하지 않는다.

## 트레이드오프

- Sentinel failover 중에 나간 명령은 예전에는 기다렸다가 성공했지만, 이제는 5초에
  실패한다. 무기한 대기보다 제한된 실패를 택했다. 버스 publish 는 adapter 가
  실패를 삼키고 `cluster bus write failed` 로 센다.
- `main.ts` 의 기동 시 `redis.ping()` 도 Redis 연결이 5초 넘게 걸리면 실패해
  파드가 재시작된다.
- 명령 시한이 생기면서 ioredis 의 접속 직후 ready check(`INFO`)도 시한에 걸릴 수
  있다. 시한보다 느린 Redis 를 만나면 ioredis 가 스스로
  `recoverFromFatalError` → 재접속을 반복한다. 이건 멈춤 감지와 무관한
  `commandTimeout` 자체의 결과이며, 무기한 대기 대신 택한 값이다.
- 명령을 던지는 쪽이 결과를 기다리지 않는 경로는 이제 거절을 받을 수 있다.
  `main.ts` 는 처리되지 않은 거절에서 `process.exit(1)` 하므로, 그런 경로마다
  처리자를 달아야 한다 (streams adapter 의 `persistSession` 쓰기,
  터미널 세션 정리).
