# Security Policy

## Supported Versions

We currently support security updates for the following versions of Happy Coder:

| Version | Supported          | Status |
| ------- | ------------------ | ------ |
| 1.5.x   | :white_check_mark: | Current Release |
| 1.4.x   | :white_check_mark: | LTS Support |
| < 1.4   | :x:                | End of Life |

## Reporting a Vulnerability

We take security seriously. If you discover a security vulnerability, please report it responsibly:

### For Critical Security Issues:
- **Do NOT** create a public GitHub issue
- **Email**: security@happy.engineering (primary contact)
- **GitHub**: Contact [@jeffersonwarrior](https://github.com/jeffersonwarrior) directly via private message
- **Include**: Detailed reproduction steps, impact assessment, and affected versions

### For Non-Critical Issues:
- Create a GitHub issue with the `security` label
- Use the security issue template if available
- Provide clear description and reproduction steps

## Security Features

Happy Coder implements multiple layers of security:

### End-to-End Encryption
- **Algorithm**: TweetNaCl (same encryption as Signal)
- **Implementation**: All Claude Code conversations encrypted on-device
- **Zero-Knowledge**: Server cannot decrypt your data
- **Key Management**: Encryption keys never leave your devices

### Infrastructure Security
- **Automated Security Scanning**:
  - TruffleHog OSS for secret detection
  - GitLeaks for credential scanning
  - CodeQL for advanced code analysis
  - Custom pattern detection for API keys, tokens, and credentials
- **Dependency Security**:
  - Dependabot automated updates
  - npm audit scanning
  - Vulnerability monitoring
- **Code Quality**:
  - TypeScript strict mode
  - ESLint security rules
  - Automated testing

### Authentication & Authorization
- **QR Code Pairing**: Secure device-to-device authentication
- **Token Security**: GitHub tokens and API keys stored securely
- **Session Management**: Encrypted session state with automatic expiration

### Data Protection
- **Local Storage**: Sensitive data encrypted at rest
- **Network Transit**: All communications over HTTPS/WSS
- **No Data Collection**: Zero telemetry, no tracking
- **Open Source**: Fully auditable codebase

## Response Timeline

| Severity Level | Response Time | Patch Timeline |
|---------------|---------------|----------------|
| **Critical** (RCE, Data Breach) | 24 hours | 7 days |
| **High** (Auth Bypass, XSS) | 72 hours | 14 days |
| **Medium** (Info Disclosure) | 1 week | Next release |
| **Low** (Minor Issues) | 2 weeks | Future release |

## Security Best Practices

### For Users:
- **Keep Updated**: Always use the latest version
- **Secure Tokens**: Store GitHub tokens securely, rotate regularly
- **Strong Authentication**: Enable 2FA on connected accounts
- **Network Security**: Use trusted networks for sensitive operations
- **Review Permissions**: Regularly audit connected services

### For Developers:
- **Secret Management**: Never commit secrets, API keys, or credentials
- **Environment Variables**: Use `.env` files for sensitive configuration
- **Dependency Security**: Keep dependencies updated, review security advisories
- **Code Review**: All security-related changes require review
- **Testing**: Write security tests for authentication and encryption features

## Security Architecture

### Threat Model
Happy Coder is designed to protect against:
- **Man-in-the-middle attacks**: End-to-end encryption
- **Server-side data breaches**: Zero-knowledge architecture
- **Credential theft**: Secure token storage and rotation
- **Code injection**: Input validation and sanitization
- **Supply chain attacks**: Dependency scanning and verification

### Trust Boundaries
- **Client-Side**: Trusted (your devices)
- **Happy Server**: Semi-trusted (encrypted data only)
- **Network**: Untrusted (encrypted in transit)
- **Dependencies**: Verified (automated security scanning)

## Incident Response

In case of a security incident:

1. **Immediate Response**:
   - Assess impact and affected users
   - Implement containment measures
   - Notify security team within 4 hours

2. **Investigation**:
   - Conduct thorough analysis
   - Document attack vectors and impact
   - Prepare detailed timeline

3. **Resolution**:
   - Develop and test security patch
   - Coordinate disclosure with reporters
   - Release security update

4. **Post-Incident**:
   - Publish security advisory
   - Update security documentation
   - Implement preventive measures

## Compliance & Standards

Happy Coder follows security best practices including:
- **OWASP Mobile Security**: Mobile application security guidelines
- **NIST Cybersecurity Framework**: Risk management practices
- **Privacy by Design**: Built-in privacy protection
- **Secure Development**: SSDLC practices

## Dependencies Security

We continuously monitor and secure our dependency chain:

- **Automated Scanning**: GitHub Dependabot and npm audit
- **Regular Updates**: Security patches applied promptly
- **Vulnerability Database**: CVE monitoring for all dependencies
- **License Compliance**: Open source license verification

## Encryption Details

### Key Exchange
- **Algorithm**: Curve25519 (ECDH)
- **Implementation**: libsodium/TweetNaCl
- **Key Size**: 256-bit keys
- **Perfect Forward Secrecy**: New keys for each session

### Message Encryption
- **Algorithm**: XSalsa20 stream cipher
- **Authentication**: Poly1305 MAC
- **Nonce**: 192-bit random nonce per message
- **Integrity**: Authenticated encryption (AEAD)

## Contact Information

**Security Team**: security@happy.engineering
**Maintainer**: [@jeffersonwarrior](https://github.com/jeffersonwarrior)
**Repository**: [happy-coder-1.5.2](https://github.com/jeffersonwarrior/happy-coder-1.5.2)
**Issues**: [GitHub Issues](https://github.com/jeffersonwarrior/happy-coder-1.5.2/issues)

## Acknowledgments

We thank the security research community for responsible disclosure and helping make Happy Coder more secure. Security researchers who responsibly disclose vulnerabilities will be credited in our security advisories (unless they prefer anonymity).

---

**Last Updated**: September 2025
**Version**: 1.5.2
**Next Review**: December 2025

*This security policy is regularly reviewed and updated. For the most current version, please check the main branch of this repository.*