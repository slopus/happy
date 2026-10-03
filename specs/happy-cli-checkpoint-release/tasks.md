# Happy CLI 체크포인트 릴리스 Tasks

실행 순서: 미발행 identity → 독립 후보/검증 → PR → main 및 직전 release 승인 → registry → 소비자 적용.

- [x] T1. registry `.278`와 `.279` tag/PR 미사용 및 #650 main 포함 확인
- [x] T2. 별도 worktree의 package version `.279` 후보와 frozen 의존성 준비
- [x] T3. 직접 관련 테스트·CLI build·wire build, pack/metadata/install-smoke 검증
- [x] T4. main 뒤처짐·후보 재확인, 검증 문서·commit·push·준비 PR (#655)
- [ ] T5. main 통합·정확한 release 행위의 직전 승인 → tag workflow/registry install smoke
- [ ] T6. Desktop pin/root vendor pointer 준비 및 검증 PR
- [ ] T7. 실제 provider·복원·worktree 정리 수락 및 기본 ON 재검토

T5 외부 tag push는 승인을 기다리며 T6의 pin을 미발행 값으로 작성하지 않는다. 새 기능이나 삭제 정책 변경은 이 작업에 섞지 않는다.
