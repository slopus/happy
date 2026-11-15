# Pull request previews

Every pull request that changes the app gets its own live copy at `https://rakazo-pr-<number>.fly.dev`,
linked from a comment on the pull request and updated on each push. Sign in with
`preview@example.com` / `rakazo-preview-demo`.

A preview is one Fly.io machine holding Postgres and the whole app, with every outside service
emulated: scripted model replies, fake computers, and emulated billing and cloud agents. Fly's
proxy suspends the machine a few minutes after the last visit and resumes it on the next one.
Resuming normally avoids restarting the app. A new image or a lost snapshot needs a cold start;
migrations and demo-account setup run once per image on each database. Data survives sleeps and
is deleted with the preview when the pull request closes, or by a daily sweep. A deleted demo
account is recreated on the next cold boot.

Idle machines incur storage charges, including the root filesystem and the data volume; compute
is billed only while running. See [Fly pricing](https://fly.io/docs/about/pricing/).

## How it stays safe for forks

- `preview-build.yml` runs the pull request's code to build the image, with a read-only token and
  no secrets, and uploads the image as an artifact.
- `preview-deploy.yml` runs from the default branch with the deploy token. It only loads that
  image and pushes it to Fly; it never runs the pull request's code or scripts.
- A preview generates its own secrets on first boot and holds no credential for anything else. Its
  machine size comes from this directory's `fly.toml` on the default branch, not the pull request.
- After a deploy that touches the web UI, an agent screenshots the change in the preview and a
  separate trusted job adds the images to the pull request description. The agent has only
  browser tools, and the browser runs as its own user, so neither can read the model login.
- Previews live in a Fly organization used for nothing else: machines in one organization share a
  private network, and any pull request can run code in its preview.
- The demo login is public, so never connect a real model key or account to a preview.

## Setup

1. Create a Fly.io organization only for previews, and a token for it:
   `fly tokens create org --org <org>`.
2. In the repository's Actions settings, add the secret `FLY_PREVIEW_TOKEN` and the variable
   `FLY_PREVIEW_ORG` (the organization's slug). Optional variables: `FLY_PREVIEW_REGION`
   (default `iad`) and `FLY_PREVIEW_APP_PREFIX` (default `rakazo-pr`; app names are global).
3. Set a spending alert on the organization.

Until the token is set, the deploy and cleanup workflows skip themselves, but every pull request
still builds an image, so set this up before merging the workflows.
