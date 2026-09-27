# Claude SDK 실행 버전과 명시적 로컬 실행 파일

## 요구사항
- SDK 내장 Claude가 Opus 5.5 최소 버전 2.1.280을 충족하도록 SDK를 검증된 exact version으로 갱신한다.
- 기본은 SDK 내장 실행 파일이다. PATH 자동 탐색으로 실행 환경을 바꾸지 않는다.
- 기존 HAPPY_CLAUDE_PATH에 실행 머신의 절대 경로를 지정하면 SDK도 그 파일을 사용한다. 심볼릭 링크는 실제 파일로 해석한다.
- 상대 경로, 빈 값, 존재하지 않는 파일, 디렉터리, 실행 불가능한 native 파일은 SDK 실행 전에 명확히 거절한다. 잘못된 명시적 선택을 bundled fallback으로 숨기지 않는다.
- SDK, resume/model/effort, 권한 및 spawnClaudeCodeProcess sandbox 연결을 유지한다. 경로 확인 중 별도 프로세스나 shell을 실행하지 않는다.
- 이 작업은 Happy 코드·의존성 및 로컬 검증이다. registry publish, Desktop pin 갱신과 운영 daemon 교체는 포함하지 않는다.

## 수락
관련 query/sandbox 회귀, 타입 검사, 빌드 및 실제 내장/로컬 실행 파일 버전 확인. 인증된 실제 모델 응답은 가능한 환경에서 확인하고 미검증이면 구분한다.

## 사용법과 적용 경계
- 설정하지 않으면 검증된 SDK 내장 실행 파일을 사용한다.
- 로컬 선택: Happy 실행 프로세스 환경에 `HAPPY_CLAUDE_PATH=/absolute/path/to/claude`를 설정한다. 현재 머신 예시는 `/Users/justin/.hermes/node/bin/claude`다. shell 인수나 상대 경로, `~` 확장 문자열 대신 실제 절대 경로를 넣는다.
- daemon이 세션을 실행한다면 그 daemon의 시작 환경에 설정해야 한다. 이미 실행 중인 daemon은 터미널에서 나중에 export한 값을 자동으로 받지 않는다.
- 원격 머신에서는 그 머신에 존재하고 실행 계정이 접근 가능한 파일이어야 한다. mandatory sandbox에서는 기존 wrapper가 그대로 실행을 담당하며, sandbox 안에서 접근할 수 없는 경로는 실행 오류가 된다. sandbox를 끄거나 다른 파일로 fallback하지 않는다.
- native executable과 읽을 수 있는 JS entrypoint를 지원한다. Windows shell shim(.cmd/.bat)이나 wrapper 탐색 기능은 제공하지 않는다.
- 실제 사용 버전은 해당 실행 파일의 `--version`으로 확인한다. SDK pin과 로컬 파일 버전은 독립적이며 새 SDK protocol과 로컬 파일의 호환성을 별도로 검증한다.
