# AutoFixer Security Configuration

## Overview

The AutoFixer Docker system implements comprehensive security measures to protect against unauthorized access while allowing legitimate GitHub webhook traffic.

## Firewall Configuration

### IP Address Restrictions

#### Webhook Endpoint (`/webhook`)

- **Allowed IPs**: GitHub webhook IP ranges + localhost/Docker network
- **GitHub IP Ranges**:
  - `192.30.252.0/22`
  - `185.199.108.0/22`
  - `140.82.112.0/20`
  - `143.55.64.0/20`
  - `2a0a:a440::/29` (IPv6)
  - `2606:50c0::/32` (IPv6)
- **Local Access**: `127.0.0.1`, `::1`, `172.25.0.0/16` (Docker network)
- **Security**: All other IPs are explicitly denied

#### Administrative Endpoints

- **Endpoints**: `/api/`, `/sonar/`, `/health`, `/` (default)
- **Allowed IPs**: Localhost and Docker network only
  - `127.0.0.1`
  - `::1`
  - `172.25.0.0/16`
- **Security**: All external IPs are blocked

## SSL/TLS Configuration

### HTTPS Enforcement

- All HTTP traffic redirected to HTTPS (301 redirect)
- Self-signed SSL certificate for development/testing
- TLS 1.2 and 1.3 support
- Strong cipher suites enabled
- HTTP/2 enabled for better performance

### Security Headers

- `Strict-Transport-Security`: HSTS enabled
- `X-Frame-Options`: Prevent clickjacking
- `X-Content-Type-Options`: Prevent MIME sniffing
- `X-XSS-Protection`: XSS protection enabled

## Rate Limiting

- Webhook endpoint limited to 10 requests per minute per IP
- Burst allowance of 5 requests
- Helps prevent abuse and DoS attacks

## GitHub Integration Security

### Webhook Signature Verification

- All webhook payloads verified using HMAC-SHA256
- Secret key: `github_autofixer_webhook_secret_2025_happy`
- Invalid signatures rejected with HTTP 401

### GitHub Token Security

- Personal Access Token stored in environment variables
- Token has minimal required permissions
- Used only for creating pull requests and repository access

## Network Security

### Docker Network Isolation

- Services run in isolated Docker network (`172.25.0.0/16`)
- No direct external access to internal services
- All external traffic goes through nginx reverse proxy

### Service Communication

- Inter-service communication over internal Docker network
- No exposed ports except 80/443 on nginx
- Database and Redis not externally accessible

## Testing

Run the firewall test script to verify configuration:

```bash
./test-firewall.sh
```

## Monitoring

- nginx access logs show all requests and their source IPs
- Failed access attempts logged with 403 status
- Webhook signature failures logged with 401 status

## Maintenance

### Updating GitHub IP Ranges

GitHub IP ranges may change. To update:

1. Fetch current ranges: `curl https://api.github.com/meta`
2. Update `nginx.conf` with new webhook CIDR blocks
3. Restart nginx: `docker compose restart nginx`
4. Test with `./test-firewall.sh`

### SSL Certificate Renewal

For production deployment:

1. Replace self-signed certificates with valid CA-issued certificates
2. Update certificate paths in `nginx.conf`
3. Set up automatic renewal (e.g., with Let's Encrypt)

## Security Checklist

- [x] IP restrictions implemented for all endpoints
- [x] HTTPS enforced with security headers
- [x] Rate limiting configured
- [x] Webhook signature verification enabled
- [x] Internal services isolated
- [x] Access logging enabled
- [x] Configuration tested and verified
