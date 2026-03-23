# Release Process

    Component   How to release                  Where it goes
    ---------   --------------                  -------------
    CLI         yarn release happy-cli           npm (happy / happy-coder)
    Mobile      yarn release (from happy-app)    App Store, Google Play, TestFlight
    Web         TeamCity (Lab_HappyWeb)          docker.korshakov.com/happy-app -> K8s
    Server      TeamCity (Lab_HappyServer)       docker.korshakov.com/handy-server -> K8s


## CLI

    Package          packages/happy-cli
    npm name         happy (install via "npm i -g happy-coder" - migration to "happy" pending)
    Versioning       release-it, tags v{version}, branches: main or beta
    npm dist-tag     beta

    yarn release                   Interactive workspace picker
    yarn release happy-cli         Release CLI directly

Flow: build (pkgroll) -> test (vitest) -> bump version -> commit -> tag -> npm publish -> GitHub release

CI: GitHub Actions `cli-smoke-test.yml` runs on push/PR to main (Linux + Windows, Node 20/24).
Release notes are AI-generated via `.release-it.notes.js`.


## Mobile

    Package          packages/happy-app (Expo SDK 54 / React Native 0.81.4)
    3 variants       development (com.slopus.happy.dev)
                     preview     (com.slopus.happy.preview)
                     production  (com.ex3ndr.happy)

### Commands

    yarn release                       Interactive menu with all options below
    yarn release:build:developer       Dev + preview builds (6 total, iOS + Android)
    yarn release:build:appstore        Production builds with auto-submit
    yarn ota                           OTA update to preview channel
    yarn ota:production                OTA update to production channel (via EAS workflow)

### EAS Build Profiles

    Profile              Distribution   Channel
    -------              ------------   -------
    development          internal       development
    development-store    store          development
    preview              internal       preview
    preview-store        store          preview
    production           store          production

Version source is remote (EAS manages build numbers, auto-incremented).
Runtime version "20" - bump when native code changes to invalidate OTA.

### Automated Workflows

    preview.yaml         Push to main -> OTA to preview channel
    ota.yaml             Manual trigger -> OTA to production channel

### App Store Connect

    Apple ID       steve@bulkovo.com
    ASC App ID     126165711
    Team ID        466DQWDR8C


## Web

    Package          packages/happy-app (same Expo app, web export)
    Dockerfile       Dockerfile.webapp
    Image            docker.korshakov.com/happy-app:{version}
    K8s              packages/happy-app/deploy/happy-app.yaml (3 replicas, nginx on port 80)

Build: `expo export --platform web` -> nginx:alpine static serve.
Build args: `POSTHOG_API_KEY`, `REVENUE_CAT_STRIPE`.

CI/CD: TeamCity `Lab_HappyWeb` (config in UI, not in repo) -> Docker build -> push -> K8s deploy.
GitHub Actions `typecheck.yml` runs typecheck on push/PR to main.


## Server

    Package          packages/happy-server
    Dockerfile       Dockerfile.server (production), Dockerfile (standalone w/ PGlite)
    Image            docker.korshakov.com/handy-server:{version}
    K8s              packages/happy-server/deploy/handy.yaml (1 replica, port 3005)

Build: node:20 + python3 + ffmpeg, builds happy-wire + happy-server.
Secrets from Vault: handy-db, handy-master, handy-github, handy-files, handy-e2b, handy-revenuecat, handy-elevenlabs.
Redis: happy-redis StatefulSet (redis:7-alpine, 1Gi persistent volume).
Metrics: Prometheus on port 9090 at /metrics.

CI/CD: TeamCity `Lab_HappyServer` (config in UI, not in repo) -> Docker build -> push -> K8s deploy.


## Docs

    Site             happy.engineering (GitHub Pages)
    Repo             github.com/slopus/slopus.github.io

Separate repo, not part of this monorepo.
