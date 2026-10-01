---
기능: resume-missing-worktree-restore
상태: 진행중 — 구현·단위 검증 완료, 실제 데몬 resume 실측 대기
마지막 갱신: 2026-10-01
---

# context — resume-missing-worktree-restore

## 변경 파일

| 파일 | 성격 | 내용 |
|---|---|---|
| `packages/happy-cli/src/daemon/missingWorktreeRestore.ts` | 동작 | 사라진 관리 워크트리 재생성(R1~R5), Claude 기록 마지막 브랜치 읽기 |
| `packages/happy-cli/src/daemon/missingWorktreeRestore.test.ts` | 테스트 | 실제 git 저장소로 9건 |
| `packages/happy-cli/src/daemon/run.ts` | 동작 | resume launch 직후 재생성 호출 |

## 결정

- [2026-10-01] 재생성 위치는 원래 경로 / 이유: Claude 대화 기록 폴더가 작업 경로로 정해진다
  (`~/.claude/projects/<경로>`). 다른 경로로 옮기면 기록 파일 이동이 필요하고 그 방식은 검증되지 않았다.
- [2026-10-01] Desktop 자동 정리 보호 기준(보관 안 된 대화 전부 보호)을 되돌리지 않고 재생성으로 해결 /
  이유: 그 기준은 디스크 고갈로 기각된 안이다. 사용자가 재생성 방향을 선택했다.
- [2026-10-01] 브랜치 정보는 세션 메타데이터에 없어 Claude 기록의 `gitBranch` 를 읽는다. 기록 끝 1MB 만 읽는다.
- [2026-10-01] 중복 등록 정리는 `git worktree prune` / 이유: 수동 삭제된 경로는 등록이 남아 `add` 를 막는다.
  `add -f` 는 다른 워크트리에 체크아웃된 브랜치까지 가져오므로 쓰지 않았다.

## 검증

- `vitest run --project unit src/daemon/missingWorktreeRestore.test.ts` 9/9 통과.
- `tsc --noEmit` 통과.
- 미검증: 실제 데몬에서 워크트리 삭제 → idle 종료 → 메시지 전송 → resume 이어짐. 릴리스 전 데몬에 설치해 확인 필요.

## 다음 시작점

1. 로컬 데몬에 이 빌드를 설치하고 실측(위 미검증 항목).
2. Codex 대화 기록 브랜치 읽기(범위 밖 항목) 필요 여부 판단.
