set -e
# Only from a local main that is origin/main. See sources/scripts/releasePreflight.mjs.
node sources/scripts/releasePreflight.mjs
eas build --profile production --platform ios --auto-submit-with-profile=production --no-wait --non-interactive
eas build --profile production --platform android --auto-submit-with-profile=production --no-wait --non-interactive
