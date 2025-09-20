# GitHub AutoFixer 🤖

Automated code fixing system using Claude Code, MCP servers, and quality tools.

## Features

- 🔄 **Automated Code Fixing**: Uses Claude Code with z.ai API for intelligent error resolution
- 🔍 **Quality Analysis**: Integrates ESLint, Biome, SonarQube for comprehensive code analysis
- 🌐 **Multi-Platform Testing**: Tests compilation for Android, Linux, Web platforms
- 🔗 **GitHub Integration**: Webhook-driven automation with automatic PR creation
- 🧠 **MCP Integration**: Uses Exa Search and other MCP servers for enhanced capabilities
- 📊 **Monitoring**: Built-in health checks, logging, and optional Grafana/Prometheus

## Quick Start

1. **Clone and Configure**
   ```bash
   git clone <this-repo>
   cd docker-autofixer
   cp .env.example .env
   # Edit .env with your actual credentials
   ```

2. **Deploy**
   ```bash
   chmod +x deploy.sh
   ./deploy.sh
   ```

3. **Configure GitHub Webhook**
   - Go to your repository settings
   - Add webhook: `http://your-server:3000/webhook`
   - Select "Push" events
   - Set secret from your `.env` file

## How It Works

### Trigger Workflow
1. **Commit Detection**: System monitors for new commits
2. **RC.txt Check**: Only processes repos with `RC.txt` set to "Ready"
3. **Repository Cloning**: Clones the repository for analysis
4. **Quality Analysis**: Runs ESLint, Biome, TypeScript, SonarQube
5. **Automated Fixing**: Uses Claude Code + MCP tools to fix issues
6. **Multi-Platform Testing**: Verifies compilation across platforms
7. **PR Creation**: Creates pull request with fixes when successful
8. **RC.txt Update**: Marks `RC.txt` as "Yes" on completion

### MCP Integration
- **Exa Search**: Finds best practices and solutions for code issues
- **GitHub MCP**: Direct GitHub repository interactions
- **Filesystem MCP**: File system operations within container
- **Sequential Thinking**: Structured problem-solving approach

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/status` | GET | System status |
| `/webhook` | POST | GitHub webhook receiver |
| `/trigger` | POST | Manual trigger |

## Configuration

### Environment Variables

```bash
# Required
GITHUB_TOKEN=<your_github_token>
WEBHOOK_SECRET=<your_webhook_secret>

# Pre-configured APIs
CLAUDE_API_KEY=85c99bec0fa64a0d8a4a01463868667a.RsDzW0iuxtgvYqd2
EXA_API_KEY=b65999c0-db14-4241-9a53-f58b4656ae4b
```

### Repository Requirements

1. **RC.txt File**: Must contain "Ready" to trigger processing
2. **package.json**: Standard npm/yarn project structure
3. **Quality Tools**: ESLint, Biome, TypeScript configurations

## Services

| Service | Port | Purpose |
|---------|------|---------|
| AutoFixer | 3000 | Main application |
| SonarQube | 9000 | Code quality analysis |
| Nginx | 80 | Reverse proxy |
| Grafana | 3001 | Monitoring dashboard |
| Prometheus | 9090 | Metrics collection |

## Manual Testing

```bash
# Test health
curl http://localhost:3000/health

# Manual trigger
curl -X POST http://localhost:3000/trigger \
  -H "Content-Type: application/json" \
  -d '{"repoUrl": "https://github.com/user/repo.git", "branch": "main"}'
```

## Quality Tools Integrated

- **ESLint**: JavaScript/TypeScript linting with auto-fix
- **Biome**: Fast linting and formatting (30x faster than ESLint)
- **TypeScript**: Type checking and compilation
- **SonarQube**: Code quality, security, and technical debt analysis
- **Prettier**: Code formatting

## Platform Testing

- ✅ **TypeScript**: Compilation verification
- ✅ **Web**: Expo web build testing
- ✅ **Android**: Expo Android prebuild testing
- 🔄 **Linux**: Node.js compatibility testing
- 🔄 **Windows/Mac**: Limited support (requires native builders)

## Monitoring

Access monitoring dashboards:
- **Grafana**: http://localhost:3001 (admin/admin)
- **Prometheus**: http://localhost:9090
- **SonarQube**: http://localhost:9000

## Troubleshooting

### Common Issues

1. **Health Check Fails**
   ```bash
   docker-compose logs autofixer
   ```

2. **SonarQube Not Starting**
   ```bash
   # Increase memory
   echo 'vm.max_map_count=262144' | sudo tee -a /etc/sysctl.conf
   sudo sysctl -p
   ```

3. **Webhook Not Receiving**
   - Check firewall settings
   - Verify webhook URL in GitHub
   - Check nginx logs

### Log Locations

```bash
# Application logs
docker-compose logs -f autofixer

# All services
docker-compose logs -f

# Specific service
docker-compose logs -f sonarqube
```

## Development

### Building Locally

```bash
docker-compose build autofixer
```

### Running Tests

```bash
chmod +x scripts/test-system.sh
./scripts/test-system.sh
```

### Updating

```bash
git pull
./deploy.sh
```

## Security

- Rate limiting on webhook endpoints
- Environment variable encryption
- Container isolation
- Network segmentation
- Security headers via Nginx

## License

MIT License - see LICENSE file for details

## Support

For issues and feature requests, please create an issue in the repository.

---

🤖 **Powered by Claude Code + Happy Engineering**