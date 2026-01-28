set -e
eas build --profile production --platform ios --auto-submit-with-profile=production --no-wait --non-interactive
eas build --profile production --platform android --auto-submit-with-profile=production --no-wait --non-interactive