# Contributing to Happy CLI

## Development Setup: Stable & Dev Versions

## Quick Start

### Initial Setup (Once)

```bash
npm run setup:dev
```

This creates:
- `~/.happy/` - Stable version data (production-ready)
- `~/.happy-dev/` - Development version data (for testing changes)

### Daily Usage

**Stable (production-ready):**
```bash
npm run stable:daemon:start
```

**Development (testing changes):**
```bash
npm run dev:daemon:start
```

## Visual Indicators

You'll always see which version you're using:
- `✅ STABLE MODE - Data: ~/.happy`
- `🔧 DEV MODE - Data: ~/.happy-dev`

## Common Tasks

### Authentication

```bash
# Authenticate stable version
npm run stable auth login

# Authenticate dev version (can use same or different account)
npm run dev auth login

# Logout
npm run stable auth logout
npm run dev auth logout
```

### Daemon Management

```bash
# Check status of both
npm run stable:daemon:status
npm run dev:daemon:status

# Stop both
npm run stable:daemon:stop
npm run dev:daemon:stop

# Start both simultaneously
npm run stable:daemon:start && npm run dev:daemon:start
```

### Running Any Command

```bash
# Stable version
npm run stable <command> [args...]
npm run stable notify "Test message"
npm run stable doctor

# Dev version
npm run dev:variant <command> [args...]
npm run dev:variant notify "Test message"
npm run dev:variant doctor
```

## Data Isolation

Both versions maintain complete separation:

| Aspect | Stable | Development |
|--------|--------|-------------|
| Data Directory | `~/.happy/` | `~/.happy-dev/` |
| Settings | `~/.happy/settings.json` | `~/.happy-dev/settings.json` |
| Auth Keys | `~/.happy/access.key` | `~/.happy-dev/access.key` |
| Daemon State | `~/.happy/daemon.state.json` | `~/.happy-dev/daemon.state.json` |
| Logs | `~/.happy/logs/` | `~/.happy-dev/logs/` |

**No conflicts!** Both can run simultaneously with separate:
- Authentication sessions
- Server connections
- Daemon processes
- Session histories
- Configuration settings

## Advanced: direnv Auto-Switching

For automatic environment switching when entering directories:

1. Install [direnv](https://direnv.net/):
   ```bash
   # macOS
   brew install direnv

   # Add to your shell (bash/zsh)
   eval "$(direnv hook bash)"  # or zsh
   ```

2. Setup direnv for this project:
   ```bash
   cp .envrc.example .envrc
   direnv allow
   ```

3. Now `cd` into the directory automatically sets `HAPPY_VARIANT=dev`!

## Troubleshooting

### Commands not working?
```bash
npm install
```

### Permission denied on scripts?
```bash
chmod +x scripts/*.cjs
```

### Data directories not created?
```bash
npm run setup:dev
```

### Both daemons won't start?
Check port conflicts - each daemon needs its own port. The dev daemon will automatically use a different port from stable.

### How do I check which version is running?
Look for the visual indicator:
- `✅ STABLE MODE` = stable version
- `🔧 DEV MODE` = development version

Or check the daemon status:
```bash
npm run stable:daemon:status   # Shows ~/.happy/ data location
npm run dev:daemon:status       # Shows ~/.happy-dev/ data location
```

## Tips

1. **Use stable for production work** - Your tested, reliable version
2. **Use dev for testing changes** - Test new features without breaking your workflow
3. **Run both simultaneously** - Compare behavior side-by-side
4. **Different accounts** - Use different Happy accounts for dev/stable if needed
5. **Check logs** - Logs are separated: `~/.happy/logs/` vs `~/.happy-dev/logs/`

## Example Workflow

```bash
# Initial setup (once)
npm run setup:dev

# Authenticate both
npm run stable auth login
npm run dev:variant auth login

# Start both daemons
npm run stable:daemon:start
npm run dev:daemon:start

# Do your development work...
# Edit code, build, test with dev version

# When ready, update stable version
npm run stable:daemon:stop
git pull  # or your deployment process
npm run stable:daemon:start

# Dev continues running unaffected!
```

## How It Works

The system uses the built-in `HAPPY_HOME_DIR` environment variable to separate data:

- **Stable scripts** set: `HAPPY_HOME_DIR=~/.happy`
- **Dev scripts** set: `HAPPY_HOME_DIR=~/.happy-dev`

Everything else (auth, sessions, logs, daemon) automatically follows the `HAPPY_HOME_DIR` setting.

Cross-platform via Node.js - works identically on Windows, macOS, and Linux!

## Testing Profile Sync Between GUI and CLI

Profile synchronization ensures AI backend configurations created in the Happy mobile/web GUI work seamlessly with the CLI daemon.

### Profile Schema Validation

The profile schema is defined in both repositories:
- **GUI:** `sources/sync/settings.ts` (AIBackendProfileSchema)
- **CLI:** `src/persistence.ts` (AIBackendProfileSchema)

**Critical:** These schemas MUST stay in sync to prevent sync failures.

### Testing Profile Sync

1. **Create profile in GUI:**
   ```
   - Open Happy mobile/web app
   - Settings → AI Backend Profiles
   - Create new profile with custom environment variables
   - Note the profile ID
   ```

2. **Verify CLI receives profile:**
   ```bash
   # Start daemon with dev variant
   npm run dev:daemon:start

   # Check daemon logs
   tail -f ~/.happy-dev/logs/*.log | grep -i profile
   ```

3. **Test profile-based session spawning:**
   ```bash
   # From GUI: Start new session with custom profile
   # Check CLI daemon logs for:
   # - "Loaded X environment variables from profile"
   # - "Using GUI-provided profile environment variables"
   ```

4. **Verify environment variable expansion:**
   ```bash
   # If profile uses ${VAR} references:
   # - Set reference var in daemon environment: export Z_AI_AUTH_TOKEN="sk-..."
   # - Start session from GUI
   # - Verify daemon logs show expansion: "${Z_AI_AUTH_TOKEN}" → "sk-..."
   ```

### Testing Schema Compatibility

When modifying profile schemas:

1. **Update both repositories** - Never update one without the other
2. **Test migration** - Existing profiles should migrate gracefully
3. **Version bump** - Update `CURRENT_PROFILE_VERSION` if schema changes
4. **Test validation** - Invalid profiles should be caught with clear errors

### Common Issues

**"Invalid profile" warnings in logs:**
- Check profile has valid UUID (not timestamp)
- Verify environment variable names match regex: `^[A-Z_][A-Z0-9_]*$`
- Ensure compatibility.claude or compatibility.codex is true

**Environment variables not expanding:**
- Reference variable must be set in daemon's process.env
- Check daemon logs for expansion warnings
- Verify no typos in ${VAR} references
