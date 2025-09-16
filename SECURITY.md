# Security Policy

## Supported Versions

We currently support security updates for the following versions of Happy Coder:

| Version | Supported          |
| ------- | ------------------ |
| 1.5.x   | :white_check_mark: |
| 1.4.x   | :white_check_mark: |
| < 1.4   | :x:                |

## Reporting a Vulnerability

We take security seriously. If you discover a security vulnerability, please report it responsibly:

### For Critical Security Issues:
- **Do NOT** create a public GitHub issue
- Email: security@happy.engineering (if available) or contact @jeffersonwarrior directly
- Include detailed reproduction steps and impact assessment

### For Non-Critical Issues:
- Create a GitHub issue with the `security` label
- Provide clear description and reproduction steps

## Security Features

Happy Coder implements several security measures:

- **End-to-End Encryption**: All Claude Code conversations are encrypted on device
- **Zero-Knowledge Architecture**: We cannot decrypt your data
- **Open Source**: Code is publicly auditable
- **Token Security**: GitHub tokens and API keys are kept in gitignored .env files
- **Automated Security Scanning**: GitHub Actions run security scans on all commits

## Response Timeline

- **Critical vulnerabilities**: Response within 24 hours, patch within 7 days
- **High severity**: Response within 72 hours, patch within 14 days
- **Medium/Low severity**: Response within 1 week, patch in next release

## Security Best Practices

### For Users:
- Keep your GitHub tokens secure and rotate them regularly
- Use strong, unique passwords for your accounts
- Enable 2FA on your GitHub account
- Keep the app updated to the latest version

### For Developers:
- Never commit secrets, tokens, or credentials to the repository
- Use environment variables for sensitive configuration
- Review dependency updates for known vulnerabilities
- Follow secure coding practices for encryption/decryption

## Dependencies Security

We use Dependabot to automatically monitor and update dependencies with known security vulnerabilities. Regular security audits are performed using:

- GitHub's CodeQL analysis
- NPM audit for Node.js dependencies
- Cargo audit for Rust dependencies
- Automated secrets scanning

## Vulnerability Disclosure

After a security issue is resolved, we will:
1. Publish a security advisory on GitHub
2. Credit the reporter (unless they prefer anonymity)
3. Document the fix in our changelog
4. Notify users to update if the vulnerability was critical

## Contact

For security-related questions or concerns:
- GitHub Issues: https://github.com/jeffersonwarrior/happy-coder-1.5.2/issues
- Maintainer: @jeffersonwarrior

---

*This security policy is regularly reviewed and updated. Last updated: September 2025*