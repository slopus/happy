# 계획

## 아키텍처 영향 / 재검토
Core: 세션 실행과 sandbox 권한 경계를 소유하는 기존 Happy SDK 어댑터 수정이다. Extension에 실행 파일 선택 권한을 새로 노출하지 않는다. Desktop UI·공개 RPC·스키마 변경은 없다.
사용자의 2026-09-27 개선 개발 요청에 따라 계획과 구현을 연속 진행한다.

## 대안 검토
1. SDK만 갱신: 즉시 모델 지원 문제를 해결하지만 로컬 선택 요구를 해결하지 못한다.
2. PATH의 Claude를 항상 사용: 머신별 PATH와 자동 업데이트에 실행 결과가 좌우돼 제외한다.
3. SDK 기본 + 기존 HAPPY_CLAUDE_PATH 명시 선택(채택): SDK 공식 pathToClaudeCodeExecutable 옵션을 사용하고 SDK protocol을 유지한다.
기존 scripts/claude_version_utils.cjs 탐색기는 PATH/package manager fallback을 포함하므로 SDK의 fail-closed 명시 선택에 재사용하지 않는다. 경로 검증은 query.ts의 지역 함수로 둔다.
버전 probe를 SDK 전에 별도 실행하지 않는다: mandatory sandbox 바깥에서 사용자 지정 바이너리를 실행하는 일을 피한다. 최신 모델 호환성을 특정 버전 문자열 하나로 영구 보장하지 않는다.

## 단계
1. spec과 실패 테스트: 기본/override/invalid path/resume/sandbox 옵션 전달.
2. SDK 0.3.283 exact pin 및 최소 구현. lockfile을 package manager로 갱신한다.
3. 관련 회귀·타입·빌드·버전 검증과 문서 동기화.

## 복구 / 릴리스
변경한 코드·SDK pin·lockfile을 함께 되돌리면 기존 내장 선택으로 복구된다. 기존 사용자 파일은 보존한다. 이 checkout 수정만으로 설치된 Happy나 Desktop이 업데이트되지는 않는다. 배포는 준비된 artifact 검증 후 별도 승인된 release 절차를 따른다.
재검토: SDK 실행 형식/옵션 변경, managed 머신에 설정을 노출할 때, native wrapper/Windows .cmd 지원 필요 시.

## 결과
세 단계의 구현·로컬 검증 완료. 상세 증거와 설치본 미반영 경계는 context.md에 기록했다. 내장/로컬 모두 실제 Opus 응답에 성공했다. SDK 선택 기본값이나 sandbox 책임의 변화는 없다.
