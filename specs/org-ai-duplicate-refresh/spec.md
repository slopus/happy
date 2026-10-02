# 공용 Claude 추가 시 무효 중복 인증 갱신

상태: 사용자 승인 (2026-10-02)

- 기존 merge 신규 계정 추가를 유지한다.
- 같은 이메일·조직 UUID인 로컬 계정의 실제 요청이 AUTHENTICATION_FAILED일 때만 공용 인증을 검증하고, 유효한 공용 인증으로 갱신한다.
- 유효한 로컬 인증, disabled 계정, 네트워크/한도/시간 초과 등 불확실한 인증과 다른 조직·계정은 보존한다.
- 기존 active 번호·계정 순서·비활성 설정·회전 상태를 보존한다. 갱신한 active 계정은 live 인증에도 반영한다.
- 수동 repair와 회사 권한은 보존한다. 토큰과 원문은 DTO/로그에 노출하지 않는다.

## 2026-10-02 후속 사용자 요청

- Claude/Codex 미등록 개인 로그인을 로컬 풀에 먼저 자동 등록하고 사용 가능한 현재 계정은 유지한다.
- Codex에도 인증 실패가 확인된 중복에 한정한 유효 공용 인증 갱신을 적용한다.
- merge의 optional activeAccountIndex는 기본 생략한다. 명시 시 선택 공용·설치 인증 검증 뒤 활성화한다. activeSelectionVersion:1 capability와 index ack를 제공한다.
- Codex는 실제 auth.json 동기화까지 확인하고 실패 시 live 파일·풀 복구를 시도한다.
- 등록 불가능한 형식·읽기/쓰기 실패·비유효 공용 인증은 성공으로 처리하지 않는다.
- 관리자 UI/서버는 별도 저장소 specs/org-ai-account-apply가 소유한다.
