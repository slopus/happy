#!/usr/bin/env bash
set -euo pipefail

: "${AWS_ACCESS_KEY_ID:?AWS_ACCESS_KEY_ID is required}"
: "${AWS_SECRET_ACCESS_KEY:?AWS_SECRET_ACCESS_KEY is required}"
: "${S3_BUCKET:?S3_BUCKET is required}"
: "${S3_ENDPOINT:?S3_ENDPOINT is required}"
: "${PLAYWRIGHT_PUBLIC_BASE_URL:?PLAYWRIGHT_PUBLIC_BASE_URL is required}"
: "${PLAYWRIGHT_RESULT:?PLAYWRIGHT_RESULT is required}"
: "${PLAYWRIGHT_RUN_ATTEMPT:?PLAYWRIGHT_RUN_ATTEMPT is required}"
: "${PLAYWRIGHT_RUN_ID:?PLAYWRIGHT_RUN_ID is required}"
: "${PLAYWRIGHT_RUN_NUMBER:?PLAYWRIGHT_RUN_NUMBER is required}"
: "${PLAYWRIGHT_RUN_URL:?PLAYWRIGHT_RUN_URL is required}"
: "${PLAYWRIGHT_SHA:?PLAYWRIGHT_SHA is required}"
: "${PLAYWRIGHT_EVENT:?PLAYWRIGHT_EVENT is required}"
: "${PLAYWRIGHT_BRANCH:?PLAYWRIGHT_BRANCH is required}"

report_dir="${PLAYWRIGHT_REPORT_DIR:-playwright-report}"
test_results_dir="${PLAYWRIGHT_TEST_RESULTS_DIR:-apps/web/test-results}"
publish_report="${PLAYWRIGHT_PUBLISH_REPORT:-true}"

if [[ "$publish_report" != "true" && "$publish_report" != "false" ]]; then
  echo "PLAYWRIGHT_PUBLISH_REPORT must be true or false." >&2
  exit 1
fi

if [[ "$publish_report" == "true" && ! -f "$report_dir/index.html" ]]; then
  echo "::warning::Playwright did not produce an HTML report; publishing the gallery and dashboard entry without it."
  publish_report="false"
fi

if [[ ! "$S3_BUCKET" =~ ^[a-zA-Z0-9.-]+$ ]]; then
  echo "S3_BUCKET contains invalid characters." >&2
  exit 1
fi

case "$S3_ENDPOINT" in
  https://*) ;;
  *) echo "S3_ENDPOINT must use HTTPS." >&2; exit 1 ;;
esac

case "$PLAYWRIGHT_PUBLIC_BASE_URL" in
  https://*) ;;
  *) echo "PLAYWRIGHT_PUBLIC_BASE_URL must use HTTPS." >&2; exit 1 ;;
esac

dashboard_dir="$GITHUB_WORKSPACE/.tmp/playwright-dashboard"
history_path="$dashboard_dir/history.json"
dashboard_path="$dashboard_dir/index.html"
gallery_dir="$dashboard_dir/screenshots"
history_error_path="$dashboard_dir/history-download-error.log"
baseline_manifest_path="$dashboard_dir/main-baseline-manifest.json"
baseline_error_path="$dashboard_dir/baseline-download-error.log"
existing_stable_baseline_path="$dashboard_dir/existing-main-baseline-manifest.json"
run_key="${PLAYWRIGHT_RUN_ID}-${PLAYWRIGHT_RUN_ATTEMPT}"
bucket_uri="s3://${S3_BUCKET}/playwright"
stable_baseline_uri="$bucket_uri/baselines/main/manifest.json"
public_base_url="${PLAYWRIGHT_PUBLIC_BASE_URL%/}"
report_url="$public_base_url/runs/$run_key/report/index.html"
screenshots_url="$public_base_url/runs/$run_key/screenshots/index.html"
pull_request_url=""

if [[ -n "${PLAYWRIGHT_PR_NUMBER:-}" ]]; then
  if [[ ! "$PLAYWRIGHT_PR_NUMBER" =~ ^[1-9][0-9]*$ ]]; then
    echo "PLAYWRIGHT_PR_NUMBER must be a positive integer." >&2
    exit 1
  fi
  : "${PLAYWRIGHT_REPOSITORY_URL:?PLAYWRIGHT_REPOSITORY_URL is required for pull request runs}"
  case "$PLAYWRIGHT_REPOSITORY_URL" in
    https://*) ;;
    *) echo "PLAYWRIGHT_REPOSITORY_URL must use HTTPS." >&2; exit 1 ;;
  esac
  pull_request_url="${PLAYWRIGHT_REPOSITORY_URL%/}/pull/$PLAYWRIGHT_PR_NUMBER"
fi

if [[ "$publish_report" == "false" ]]; then
  report_url=""
fi

mkdir -p "$dashboard_dir"
if aws s3 cp \
  "$bucket_uri/history.json" \
  "$history_path" \
  --endpoint-url "$S3_ENDPOINT" \
  2>"$history_error_path"; then
  echo "Downloaded existing Playwright history."
elif grep -Eq "404|NoSuchKey|Not Found" "$history_error_path"; then
  echo "No existing Playwright history found; creating it."
else
  cat "$history_error_path"
  exit 1
fi

if [[ -n "${PLAYWRIGHT_PR_NUMBER:-}" ]]; then
  # Prefer the dedicated latest-main baseline so comparison still works after
  # that successful run ages out of the 100-entry dashboard history.
  if aws s3 cp \
    "$stable_baseline_uri" \
    "$baseline_manifest_path" \
    --endpoint-url "$S3_ENDPOINT" \
    2>"$baseline_error_path"; then
    echo "Downloaded the latest successful main screenshot baseline."
  elif grep -Eq "404|NoSuchKey|Not Found" "$baseline_error_path"; then
    if [[ -f "$history_path" ]]; then
      baseline_run_key="$(jq -r '
        [.[] | select(
          .event != "pull_request" and
          .branch == "main" and
          .result == "success" and
          (.id | type == "string") and
          (.attempt | type == "number")
        )][0] |
        if . then .id + "-" + (.attempt | tostring) else empty end
      ' "$history_path")"
      if [[ -n "$baseline_run_key" ]]; then
        if aws s3 cp \
          "$bucket_uri/runs/$baseline_run_key/screenshots/manifest.json" \
          "$baseline_manifest_path" \
          --endpoint-url "$S3_ENDPOINT" \
          2>"$baseline_error_path"; then
          echo "Downloaded the latest successful main screenshot baseline from run history."
        else
          echo "::warning::The latest successful main run has no usable screenshot manifest; comparison labels will be unavailable."
        fi
      else
        echo "::warning::No successful main run is available as a screenshot baseline."
      fi
    else
      echo "::warning::No Playwright history is available for a screenshot baseline."
    fi
  else
    echo "::warning::Could not download the latest successful main screenshot baseline; comparison labels will be unavailable."
    cat "$baseline_error_path"
  fi
fi

if [[ -z "${PLAYWRIGHT_PR_NUMBER:-}" && "$PLAYWRIGHT_EVENT" != "pull_request" && "$PLAYWRIGHT_BRANCH" == "main" && "$PLAYWRIGHT_RESULT" == "success" ]]; then
  stable_baseline_missing="false"
  stable_baseline_downloaded="false"
  for attempt in 1 2 3; do
    if aws s3 cp \
      "$stable_baseline_uri" \
      "$existing_stable_baseline_path" \
      --endpoint-url "$S3_ENDPOINT" \
      2>"$baseline_error_path"; then
      stable_baseline_downloaded="true"
      break
    fi
    if grep -Eq "404|NoSuchKey|Not Found" "$baseline_error_path"; then
      stable_baseline_missing="true"
      break
    fi
    if (( attempt < 3 )); then
      sleep 2
    fi
  done
  if [[ "$stable_baseline_downloaded" == "true" ]]; then
    export PLAYWRIGHT_EXISTING_STABLE_BASELINE_PATH="$existing_stable_baseline_path"
    echo "Downloaded the published main screenshot baseline for recency checks."
  elif [[ "$stable_baseline_missing" == "true" ]]; then
    echo "No published main screenshot baseline yet."
  else
    # History was downloaded successfully and is the publication-order source
    # of truth. Treat an unreadable baseline as absent so the newest successful
    # main run can establish it; an older run is still rejected by the history
    # recency check emitted by the generator.
    echo "::warning::Could not read the published main screenshot baseline after 3 attempts; treating it as absent."
    cat "$baseline_error_path"
  fi
fi

PLAYWRIGHT_REPORT_URL="$report_url" \
PLAYWRIGHT_SCREENSHOTS_URL="$screenshots_url" \
PLAYWRIGHT_DASHBOARD_URL="$public_base_url/index.html" \
PLAYWRIGHT_PR_URL="$pull_request_url" \
  pnpm exec tsx \
    packages/testkit/src/cli/generate-playwright-report-dashboard.ts \
    "$history_path" \
    "$dashboard_path" \
    "$test_results_dir" \
    "$gallery_dir" \
    "$baseline_manifest_path"

if [[ "$publish_report" == "true" ]]; then
  aws s3 sync \
    "$report_dir/" \
    "$bucket_uri/runs/$run_key/report/" \
    --endpoint-url "$S3_ENDPOINT" \
    --cache-control "public,max-age=31536000,immutable"
fi
aws s3 sync \
  "$gallery_dir/images/" \
  "$bucket_uri/runs/$run_key/screenshots/images/" \
  --endpoint-url "$S3_ENDPOINT" \
  --content-type "image/png" \
  --no-guess-mime-type \
  --cache-control "public,max-age=31536000,immutable"
aws s3 cp \
  "$gallery_dir/index.html" \
  "$bucket_uri/runs/$run_key/screenshots/index.html" \
  --endpoint-url "$S3_ENDPOINT" \
  --content-type "text/html" \
  --cache-control "public,max-age=31536000,immutable"
aws s3 cp \
  "$gallery_dir/manifest.json" \
  "$bucket_uri/runs/$run_key/screenshots/manifest.json" \
  --endpoint-url "$S3_ENDPOINT" \
  --content-type "application/json" \
  --cache-control "public,max-age=31536000,immutable"
if [[ -z "${PLAYWRIGHT_PR_NUMBER:-}" && "$PLAYWRIGHT_EVENT" != "pull_request" && "$PLAYWRIGHT_BRANCH" == "main" && "$PLAYWRIGHT_RESULT" == "success" ]]; then
  if grep -qx true "$gallery_dir/publish-stable-baseline"; then
    aws s3 cp \
      "$gallery_dir/manifest.json" \
      "$stable_baseline_uri" \
      --endpoint-url "$S3_ENDPOINT" \
      --content-type "application/json" \
      --cache-control "no-store"
  else
    echo "Skipping stable baseline update because a newer successful main run is already published."
  fi
fi
aws s3 cp \
  "$history_path" \
  "$bucket_uri/history.json" \
  --endpoint-url "$S3_ENDPOINT" \
  --content-type "application/json" \
  --cache-control "no-store"
aws s3 cp \
  "$dashboard_path" \
  "$bucket_uri/index.html" \
  --endpoint-url "$S3_ENDPOINT" \
  --content-type "text/html" \
  --cache-control "no-store"

stable_screenshots_url=""
latest_pr_run="false"
if [[ -n "${PLAYWRIGHT_PR_NUMBER:-}" ]]; then
  stable_screenshots_url="$public_base_url/prs/$PLAYWRIGHT_PR_NUMBER/index.html"
  latest_pr_run_key="$(jq -r --argjson number "$PLAYWRIGHT_PR_NUMBER" '
    [.[] | select(.pullRequestNumber == $number)][0] |
    if . then .id + "-" + (.attempt | tostring) else empty end
  ' "$history_path")"
  if [[ "$latest_pr_run_key" == "$run_key" ]]; then
    aws s3 cp \
      "$gallery_dir/index.html" \
      "$bucket_uri/prs/$PLAYWRIGHT_PR_NUMBER/index.html" \
      --endpoint-url "$S3_ENDPOINT" \
      --content-type "text/html" \
      --cache-control "no-store"
    latest_pr_run="true"
  else
    echo "Skipping stable PR gallery update because a newer run is already published."
  fi
fi

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  printf 'latest_pr_run=%s\n' "$latest_pr_run" >> "$GITHUB_OUTPUT"
  printf 'stable_screenshots_url=%s\n' "$stable_screenshots_url" >> "$GITHUB_OUTPUT"
fi

summary=$(cat <<EOF
### Playwright visual report
- [Screenshot gallery]($screenshots_url)
- [Dashboard]($public_base_url/index.html)
EOF
)

if [[ -n "$report_url" ]]; then
  summary="$summary
- [Full report]($report_url)"
fi
if [[ -n "$pull_request_url" ]]; then
  summary="$summary
- [Pull request]($pull_request_url)"
  if [[ -n "$stable_screenshots_url" ]]; then
    summary="$summary
- [Latest screenshots for this PR]($stable_screenshots_url)"
  fi
fi

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  printf '%s\n' "$summary" >> "$GITHUB_STEP_SUMMARY"
else
  printf '%s\n' "$summary"
fi
