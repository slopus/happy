---
기능: happy-cli-checkpoint-release
상태: Phase 1 완료(main 통합·발행 승인 대기)
마지막 갱신: 2026-10-03
---

# Happy CLI 체크포인트 릴리스 Context

## 현재 상태

Happy #650과 Desktop #1323의 main 머지를 확인했다. registry 최신 `.278`은 #649 기준이고 #650을 포함하지 않으며 Desktop pin은 `.275`다. 별도 `release/happy-cli-279` worktree에서 후보를 준비한다. 기존 Happy 개발 worktree와 그 미추적 파일은 보존한다.

후보 version bump와 준비 문서만 변경했다. frozen install, wire build, CLI typecheck/build, 관련 unit 19 files / 479 tests, 동일 tarball guard/install-smoke가 통과했다. 의존성·lockfile·Desktop pin·전역 runtime 변경은 없다. 준비 commit `4d3e6db8d`를 push하고 [Happy #655](https://github.com/buzzni/happy/pull/655)를 생성했다. 최초 push 직전 origin/main behind=0, `.279` registry/tag 부재를 재확인했다.

## 결정·권한

- Core 기존 implementation의 release identity 변경이다. `.278` 이후 #648 브라우저 프로필 재등록 시 active 표시 수정과 #650이 함께 들어가며 usage wire/dependency 변경은 없다.
- 승인된 것은 후보 준비·관련 검증·PR와 순차 적용 준비다. 외부 tag/publish는 main 통합 뒤 정확한 버전·대상·행위의 별도 직전 승인 후에만 실행한다.
- package install smoke는 임시 prefix를 사용한다. 실제 모델 요청과 설치된 daemon 교체는 이번 준비 검증으로 주장하지 않는다.

## 다음 시작점

PR #655의 CI·main 통합 후 main commit과 정확한 tag action을 제시해 발행 승인을 받는다. merge·tag push·게시를 실행하지 않았다. 발행 뒤 registry identity를 확인하고 Desktop pin 및 root vendor pointer로 이어 간다. 기능 spec은 Desktop의 checkpoint-agent-history / checkpoint-history-retention / checkpoint-history-usability가 소유한다.

## 검증 증거와 한계

- source base: `d9608664c1dbd9152f9821961785c370ac8c6382` (Happy #650), 후보 `@buzzni/happy-cli@1.1.10-aplus.279`.
- `corepack pnpm install --frozen-lockfile`: 통과. wire build 포함, tracked lockfile 변화 없음.
- CLI cwd에서 `pnpm exec vitest run --project unit --fileParallelism=false`에 checkpoint AgentReader/SessionComposition/Rpc/FileDiff/Retention/GarbageCollector/RetentionSchedule/LocalHistoryRestore/Restore, apiMachine, startHappyServer, Claude prompt/remote/launcher/run, Codex prompt/lessonProposal, abpStack, guard-publish-artifact의 19 test files를 지정: 479/479 통과. global setup의 CLI build는 `tsc --noEmit`, pkgroll, browser-extension copy를 포함한다.
- 기존 prepare script → `npm pack --ignore-scripts` → **그 tarball**에 `guard-publish-artifact.cjs --install-smoke`: 통과. 필수 bundled files, 완전한 production dependency tree, 정확한 CLI version, bundled `happy agent --help`, 최상위 saycode bin 부재, isolated daemon preflight/status 확인. 설치 lifecycle scripts는 활성화했다.
- local `.tgz`: `/tmp/checkpoint-release-279-artifact.JLlPPA/pack/buzzni-happy-cli-1.1.10-aplus.279.tgz`, 108620701 bytes, 1286 files. SHA-256: `ab328c2b09a8296f6efdd5bd3c26fab5924cf1c233b9750820b9d9188a563f47`. 임시 artifact 경로는 로컬 검토용이며 CI는 merged source에서 다시 build/guard한다.
- full unit suite, Linux/native install, registry 게시/설치, 실제 Claude/Codex tool discovery, Desktop UI/복원 및 설치된 daemon 교체는 아직 검증하지 않았다. 관련 unit fixture는 실제 모델 수락을 대체하지 않는다.
