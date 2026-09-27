---
기능: claude-sdk-runtime-selection
상태: 구현·로컬 검증 완료, 1.1.10-aplus.249 릴리스 준비
마지막 갱신: 2026-09-27
---

## 구현과 결정
Happy CLI의 SDK pin을 0.3.276에서 0.3.283으로 갱신했다. 내장 Claude의 실제 버전은 2.1.283이다. 기본 bundled 선택을 유지하며 기존 HAPPY_CLAUDE_PATH를 SDK pathToClaudeCodeExecutable에 연결했다. 실경로·파일·접근 권한을 확인하고 잘못된 명시 선택은 실행 전에 거절한다. 검사에서 외부 프로세스를 실행하지 않고 spawnClaudeCodeProcess와 SDK sandbox 연결을 유지한다.

## 검증
- query 경계: 구현 전 추가 9개 실패와 기존 16개 통과를 확인했다.
- 구현 후 query 25, claudeRemote 55, claudeSdkSandbox 15, claudeProcessSandbox 5: 총 100개 통과.
- 위 Vitest global setup의 CLI build(타입 검사 포함) 통과. 기존 pkgroll bin/empty chunk 경고는 유지되며 이 변경으로 추가된 경고는 없다.
- 실제 SDK 어댑터를 통해 임시 작업 디렉터리, 도구 없음, model=claude-opus-5-5, effort=low로 실행했다. 기본 bundled와 HAPPY_CLAUDE_PATH=/Users/justin/.hermes/node/bin/claude 각각 success 및 CLAUDE_RUNTIME_OK 응답 확인.
- SDK 0.3.283 내장 실행 파일에 --version을 실행해 2.1.283 확인.
- git diff --check 통과. 전체 테스트는 실행하지 않았다.

## 반영 범위와 재개
소스와 lockfile, spec을 vendor/happy에 수정했다. 설치된 전역 Happy/운영 daemon/Desktop runtime은 교체하지 않았다. Desktop 자식 생성·패널·재개 및 Linux mandatory sandbox와 Windows 실제 실행은 이번 변경으로 검증하지 않았다. 관련 단위 회귀가 실제 OS 검증을 대신하지 않는다.
배포하려면 변경된 Happy의 릴리스 artifact를 준비·검증하고 외부 release 직전에 사용자 승인을 받아 공식 CI publisher로 발행한 뒤 Desktop pin/설치본을 갱신한다. 기존 다른 사용자의 untracked memory 파일은 변경하지 않았다.

## 릴리스
사용자의 명시적 릴리스 요청(2026-09-27)에 따라 PR #563 merge b73fc749 기준 1.1.10-aplus.249를 준비한다. 버전 변경 main 반영 → matching tag push → 공식 Actions publish/registry smoke → 상위 vendor 포인터 반영 순서다. 실행 중인 사용자 daemon은 임의 종료하지 않는다.
