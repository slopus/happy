# Web OSS daily retention

`web-retention.yml` runs daily at **03:17 Asia/Shanghai** (`17 19 * * *` in UTC). Scheduled runs apply the plan; manual runs default to dry-run. GitHub may delay scheduled runs, so this is a daily target rather than an exact-time guarantee.

The job retains at most **five distinct served Web revisions**, including the current revision. It selects the other four from the newest rollback markers, which record previously served revisions. Duplicate rollback markers do not count as extra versions; uploaded or superseded builds are not selected just because their CI run was green. When fewer revisions exist, the job retains those available.

For each retained revision, the complete release snapshot must have a matching marker and HTML. Every file under `_expo/`, `assets/`, and `desktop-skins/` in those snapshots is protected, including lazy chunks absent from the HTML. Public files must match the snapshot size and ETag. One matching rollback entry per retained previous revision is kept.

## Deletion and concurrency

Only objects under `web/releases/`, `web/rollback/`, `_expo/`, `assets/`, and `desktop-skins/` can enter a deletion plan. The current entry, OTA `updates/`, user uploads, favicon, WASM and association files are outside the deletion scope. Files used exclusively by retired versions stop being available, including to old open pages.

Cleanup is a separate job from deployment and shares `paws-web-production` concurrency. Both workflows use `cancel-in-progress: false` and `queue: max`, avoiding concurrent mutations and replacement of a pending deployment. Deployments can queue behind an active cleanup; the job does not add cleanup work to a release's normal steps.

The script rechecks the current marker/HTML and active deployment status before each delete batch. It aborts on changed current revision, incomplete retained release, missing dependency, list failure, partial delete receipt, or failed post-delete verification. Failed batches are not silently treated as success; the next run builds a fresh plan and can continue from the remaining objects.

Each batch contains at most 1,000 exact keys. The run artifact includes `plan.json`, batch requests/responses, `verification.json`, and `summary.json`; artifact retention is 30 days. These are audit evidence, not file-content backups. Retired revisions can be rebuilt from Git, but they are no longer available for immediate rollback.

## Operations

- Read-only local plan: set `PAWS_WEB_RETENTION_REPORT_DIR` to a directory outside the clean root workspace, then run `node scripts/cleanup-web-assets.cjs --dry-run` from an isolated worktree.
- Manual verification on merged `main`: dispatch **Daily Web OSS retention** with `dry_run: true` and inspect its artifact.
- Manual cleanup on merged `main`: dispatch with `dry_run: false`. Destructive execution is restricted to that workflow on `main` with the production lock.
- To disable future cleanup, disable the retention workflow in Actions. Do not configure age-only expiration for shared public resources: an old object may still be needed by the current version.

The five-version limit is enforced when cleanup runs. Additional releases can accumulate between daily runs. This workflow does not change Web/OTA publishing behavior or solve release-time comparison performance.

References: [scheduled workflow behavior](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule), [concurrency queue behavior](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency).
