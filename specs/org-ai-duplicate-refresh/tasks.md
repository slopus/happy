# 작업

- [x] 런타임 실패 테스트: 기존 중복 건너뛰기로 8건 실패 확인.
- [x] 조건부 중복 갱신과 active/live 인증 보존.
- [x] 검사 중 인증 변경 보호와 신규·중복 혼합 추가.
- [x] 단계 예산 테스트 2건 실패 후 구현·통과.
- [x] 관련 3파일 366건, 표준 build의 TypeScript·번들, diff check.
- [ ] Happy 릴리스와 머신 업데이트 (별도 사용자 승인 필요).
- [ ] Desktop 온보딩 연결 (사용자가 다음 작업을 알려줄 때 재개).

## 후속

- [x] Claude/Codex 미등록 개인 인증 자동 등록
- [x] Codex 무효 중복만 갱신
- [x] 선택 활성화 검증·capability·실제 Codex live 동기화 확인
- [x] 관련 435건·타입·build·diff 검증
- [ ] 별도 승인 후 Happy CLI 릴리스와 실제 머신 smoke

## 리뷰 후속

- [x] 최신 main 기능을 보존하며 복구 경로 통합
- [x] 적용 전 경합·복구 개수·disabled 메타데이터 회귀 Red→Green
- [x] 적용 후 실패 전파·신규 추가·개인 선택/등록/활성화 회귀
- [x] 관련 496건·타입·build 및 추가 matrix 12건 검증
- [ ] source PR URL·원격 확인 기록
