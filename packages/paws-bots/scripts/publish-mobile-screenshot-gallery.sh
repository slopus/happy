#!/usr/bin/env bash
set -euo pipefail

: "${AWS_ACCESS_KEY_ID:?AWS_ACCESS_KEY_ID is required}"
: "${AWS_SECRET_ACCESS_KEY:?AWS_SECRET_ACCESS_KEY is required}"
: "${S3_BUCKET:?S3_BUCKET is required}"
: "${S3_ENDPOINT:?S3_ENDPOINT is required}"
: "${PLAYWRIGHT_PUBLIC_BASE_URL:?PLAYWRIGHT_PUBLIC_BASE_URL is required}"
: "${MOBILE_RUN_ATTEMPT:?MOBILE_RUN_ATTEMPT is required}"
: "${MOBILE_RUN_ID:?MOBILE_RUN_ID is required}"
: "${MOBILE_RUN_URL:?MOBILE_RUN_URL is required}"
: "${MOBILE_SHA:?MOBILE_SHA is required}"

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

run_key="${MOBILE_RUN_ID}-${MOBILE_RUN_ATTEMPT}"
bucket_uri="s3://${S3_BUCKET}/playwright/mobile-android"
public_base_url="${PLAYWRIGHT_PUBLIC_BASE_URL%/}/mobile-android"
gallery_url="$public_base_url/runs/$run_key/index.html"
gallery_dir="$GITHUB_WORKSPACE/.tmp/mobile-screenshot-gallery"

MOBILE_SCREENSHOTS_URL="$gallery_url" \
  pnpm exec tsx packages/testkit/src/cli/generate-mobile-screenshot-gallery.ts \
    test-report/mobile-screenshots/screenshots \
    "$gallery_dir"

aws s3 cp \
  "$gallery_dir/images/" \
  "$bucket_uri/runs/$run_key/images/" \
  --recursive \
  --endpoint-url "$S3_ENDPOINT" \
  --content-type "image/png" \
  --no-guess-mime-type \
  --cache-control "public,max-age=31536000,immutable"
aws s3 cp \
  "$gallery_dir/index.html" \
  "$bucket_uri/runs/$run_key/index.html" \
  --endpoint-url "$S3_ENDPOINT" \
  --content-type "text/html" \
  --cache-control "public,max-age=31536000,immutable"
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  printf '### Android screenshots\n- [Screenshot gallery](%s)\n' \
    "$gallery_url" >> "$GITHUB_STEP_SUMMARY"
fi

video_path="test-report/mobile-screenshots/notification-demo.mp4"
if [[ -f "$video_path" ]]; then
  aws s3 cp \
    "$video_path" \
    "$bucket_uri/runs/$run_key/notification-demo.mp4" \
    --endpoint-url "$S3_ENDPOINT" \
    --content-type "video/mp4" \
    --cache-control "public,max-age=31536000,immutable"
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    printf -- '- [Live working status video](%s)\n' \
      "$public_base_url/runs/$run_key/notification-demo.mp4" >> "$GITHUB_STEP_SUMMARY"
  fi
fi
