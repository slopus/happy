# Happy CLI 체크포인트 릴리스 Plan

> 작성일: 2026-10-03 / 상태: Phase 1 완료, main 통합·발행 승인 대기 / 근거: [spec.md](./spec.md)

## 아키텍처 영향

Core: Happy daemon은 세션·machine-local history를 소유한다. 이번 후보는 기존 Core 구현의 release identity만 변경하며 새 API·DB·의존성은 추가하지 않는다. 이후 Desktop pin은 공식 registry/tag/commit 확인 후 기존 immutable runtime 계약 안에서 갱신한다. 버전 문자열만 바꾼 미발행 pin은 기각한다.

## 접근 방식

Happy main의 별도 worktree에 후보를 준비하고 기존 CI와 동일한 artifact를 pack/guard한다. 버전 bump와 준비 문서만 PR에 넣고 이미 머지된 feature를 다시 복제하지 않는다. `.278` registry release에는 #650이 없어 새 버전이 필요하다. usage wire 변경은 `.278` 이후 없으므로 이번 후보에 새 usage-schema 서버 선배포 조건은 없다.

## 단계

- [x] Phase 1: `.279` 준비 PR — frozen install, 관련 테스트/build, package guard/install-smoke, source/metadata/hash 대조
- [ ] Phase 2: main 통합·직전 승인 후 tag workflow — registry 전파/독립 설치 확인
- [ ] Phase 3: Desktop exact pin 및 root vendor pointer PR — staging·부팅·daemon smoke
- [ ] Phase 4: 실제 Claude/Codex tool discovery·diff, 사용자 확인 restore, worktree grace/즉시 정리·운용 관측

## 리스크와 복구

- 다른 세션이 버전/tag를 먼저 사용하면 push·승인 직전 다시 확인하고 새 후보로 준비한다.
- `.275` Desktop에서 `.279`로의 적용은 local-history 동작 전환을 포함한다. opt-in과 기존 복원 확인을 유지하고 actual provider 수락 전 기본 ON으로 바꾸지 않는다.
- artifact와 tagged source 불일치는 발행을 보류한다. runtime 적용 문제의 rollback은 이전 pin으로 복귀하되 history를 삭제하지 않는다.
- 단일 packing의 긴 lock 점유는 미측정 제약이며 60초는 batch 시작 예산이다.

## 실행 근거와 승인 상태

2026-10-03 사용자 “추천 대로 진행”은 새 runtime 준비·PR 및 순차 적용 준비의 실행 근거다. docs/happy-cli-release.md와 AGENTS.md가 정한 외부 release mutation 직전 승인은 별도이며, 준비 완료 뒤 버전·대상·행위를 제시한다. Desktop/root vendor 적용은 실제 발행 identity 확인 이후로 보류한다.
