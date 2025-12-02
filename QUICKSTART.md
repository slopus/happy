# Self-Hosting Quickstart

This guide walks you through running your own Happy instance.

## Architecture

```
┌─────────────────┐         ┌──────────────┐         ┌─────────────┐
│   happy-cli     │ ◄────► │ happy-server │ ◄────► │ PostgreSQL  │
│   (daemon)      │   WS    │ (port 3005)  │         │  (port 5432)│
└─────────────────┘         └──────────────┘         └─────────────┘
                                   │
                              ┌────▼────┐
                              │  Redis  │
                              │ (6379)  │
                              └─────────┘
                                   │
                              ┌────▼────┐
                              │  MinIO  │
                              │  (9000) │
                              └─────────┘
```

## Step 1: Build and Launch Services

```bash
cd .devcontainer
make build                # Build the container image (first time only)

# In terminal 1 - start the server (port 3005):
make server

# In terminal 2 - start the webapp (port 8081):
make web
```

## Step 2: Create an Account

1. Open http://localhost:8081 in your browser
2. Click "Create Account"
3. Optionally add a recognizable username in Account settings

## Step 3: Get Your Secret Key

1. Go to Account settings in the webapp
2. Find and copy your secret backup key (format: `XXXXX-XXXXX-...`)

## Step 4: Install the CLI

On each machine where you want to run Claude with Happy:

```bash
git clone --depth=1 https://github.com/rrnewton/happy-cli.git /usr/local/happy
cd /usr/local/happy
npm install && npm run build && npm install -g .
```

## Step 5: Authenticate the CLI

```bash
happy auth login --backup-key <YOUR-SECRET-KEY>
```

## Step 6: Start the Daemon

```bash
happy daemon start
```

The daemon connects your machine to the Happy server, allowing remote control from the webapp.

## Step 7: (Optional) Voice Assistant

For ElevenLabs voice assistant integration:

1. Go to Account > Voice Assistant in the webapp
2. Click "Get API Key" to create an ElevenLabs API key
3. Enter your API key and save credentials
4. Use "Find Agent" or "Create/Update Agent" to set up the voice agent

## Troubleshooting

```bash
./happy-launcher.sh status              # Check all services
./happy-launcher.sh logs server         # View server logs
./happy-launcher.sh cleanup --clean-logs && ./happy-launcher.sh start  # Fresh start
```
