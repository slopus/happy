set -e
eas build --profile preview --platform ios --no-wait --non-interactive
eas build --profile preview-store --platform ios --auto-submit-with-profile=production --no-wait --non-interactive