# Support

## Where to Ask for Help

- **Bug reports / feature requests:** GitHub Issues
- **Security reports:** see `SECURITY.md` (use GitHub Security Advisories)

## Before Filing an Issue

Please include:

- Your OS and environment (macOS/Linux/Windows, Docker, Node version if relevant)
- Which components you are using:
  - Hosted (`https://api.happy.hitosea.com/`)
  - Self-hosted (`docker-compose`)
- Versions:
  - CLI: `happy --version`
  - Server image/commit (if self-hosted)
- Logs or error messages

## Common Diagnostics

- CLI: `happy doctor`
- Self-hosted:
  - `docker-compose ps`
  - `docker-compose logs -f happy-server`
  - `docker-compose logs -f happy-voice`

