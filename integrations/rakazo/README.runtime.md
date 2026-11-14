# Native Rakazo runtime

This integration runs Rakazo's published application image without replacing its
bot engine, worker, database schema, or Web interface. `upstream.lock.json` pins
the source revision, OCI app index and PostgreSQL image. The upstream Apache-2.0
license is included alongside it.

## Local setup

Use a private absolute deployment directory outside this repository:

```sh
node integrations/rakazo/stack.mjs prepare --directory /absolute/private/bots-data
node integrations/rakazo/stack.mjs start --directory /absolute/private/bots-data
node integrations/rakazo/stack.mjs status --directory /absolute/private/bots-data
```

Docker Compose is required. The initial start applies the native database and job
queue migrations. Web and API listen only on loopback (ports 15730 and 15731).
The separate trusted Paws gateway is responsible for authenticated account
mapping and embedding; these loopback ports are not a public deployment.

Preparation creates independent secrets once, preserves them on later runs and
sets `.env` to mode 0600. Keep that directory private and back it up along with
the database and home volumes. `runtime.json` contains endpoints and the path to
the credentials file, never credential values. Do not commit deployment files.

The default model is `codex/gpt-6.1-sol` through the operator's existing local
OpenAI-compatible gateway at `http://host.docker.internal:3425/v1`. Override
`--model` and `--model-url` only on first preparation, or edit the private `.env`.
Rakazo's native local provider is used. This does not install or download model
weights. No third-party model catalog is enabled.

## Computer boundary

`SANDBOX_PROVIDER=none` explicitly disables computer provisioning and computer
tools. It does not fall back to host shell execution. The Compose file does not
mount a Docker socket or run the sandbox supervisor. Text chat remains available
through Rakazo's native lazy computer provisioning. A computer provider needs its
own explicit permission, isolated deployment and verification.

## Host-proxy image loading

When the Docker daemon cannot reach the registries but the host HTTP proxy can,
use the optional importer instead of changing global Docker settings:

```sh
python3 integrations/rakazo/load-pinned-image.py --cache-directory /absolute/private/image-cache
python3 integrations/rakazo/load-pinned-image.py --component postgres --cache-directory /absolute/private/image-cache
```

The importer verifies the locked OCI index, host-platform manifest, config and
every layer. The app config must identify the locked source revision. Tokens
stay in memory; successful cached blobs are reused. Layer downloads have bounded
transfer retries and deadlines. Imported multiarch images may only retain their
platform digest: set the corresponding private `.env` image value to that
verified repository/platform-digest combination reported by Docker. Preserve the
source lock; do not replace it with an unverified mutable tag.

## Stop and verification

```sh
node integrations/rakazo/stack.mjs stop --directory /absolute/private/bots-data
node --test integrations/rakazo/stack.test.mjs
```

Stopping removes only this Compose project's containers and networks. It keeps
the database and home volumes. Browser, gateway account isolation and actual
model output must also be verified; container health alone is insufficient.
