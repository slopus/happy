set -e
eas build --profile development --platform ios --no-wait --non-interactive
eas build --profile development-store --platform ios --auto-submit-with-profile=production --no-wait --non-interactive
eas build --profile preview --platform ios --no-wait --non-interactive
eas build --profile preview-store --platform ios --auto-submit-with-profile=production --no-wait --non-interactive
eas build --profile production --platform ios --auto-submit-with-profile=production --no-wait --non-interactive
eas build --profile production --platform android --auto-submit-with-profile=production --no-wait --non-interactive