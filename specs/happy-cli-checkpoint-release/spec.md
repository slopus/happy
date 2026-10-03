# Happy CLI 체크포인트 릴리스 Spec

> 작성일: 2026-10-03 / 상태: 승인된 릴리스 준비 범위

## 목표

머지된 체크포인트 탐색·보존·agent 조회를 독립 설치 가능한 Happy CLI 후보로 준비하고, 발행 후 Desktop과 실제 provider에 순서대로 적용한다.

## 요구사항

- R1. 이미 발행된 `.278`을 재사용하지 않고 미발행 `.279` 후보를 준비한다. 후보는 Happy #650과 main의 #648을 포함하며 의존성 변경은 없다.
- R2. 기존 CI의 prepare → npm pack → 동일 tarball guard/install-smoke를 로컬에서 확인한다. workspace protocol·필수 bundled dependency 누락·CLI version 불일치를 거절한다.
- R3. 현재 main을 기준으로 관련 checkpoint/MCP/provider wiring 및 패키징·프로필 회귀를 확인한다. SDK/client fixture 검증을 실제 모델 수락과 구분한다.
- R4. release 변경이 main에 들어간 뒤 정확한 version/tag/commit과 외부 행위를 제시하고 승인받아 GitHub Actions 태그 workflow로 발행한다. 로컬 npm publish는 하지 않는다.
- R5. 발행된 registry artifact·전파·독립 설치를 확인한 뒤 Desktop exact pin과 root vendor pointer를 별도 PR로 갱신한다. 실제 provider와 Desktop 복원·worktree 정리 수락은 그 뒤 진행한다.

## 비목표

기본 ON, 새로운 복원 권한·managed restore adapter, 데이터 스키마 변경, 삭제 정책 변경은 포함하지 않는다.

## 제약

기존 개발 worktree·데몬·전역 설치를 보존하며 검증은 별도 worktree와 임시 prefix에서 실행한다. 영구 기록은 릴리스 실패로 삭제하지 않는다. `.279` 발행/태그 push에는 별도 직전 승인이 필요하다.

## 완료 기준

- [x] 후보 build·관련 테스트·동일 tarball 설치 guard 통과
- [x] release 준비 PR와 포함 범위·한계·검증 증거 기록
- [ ] 승인 후 main tag 발행·registry smoke 완료
- [ ] Desktop pin/vendor 적용 및 실제 provider 수락 완료
