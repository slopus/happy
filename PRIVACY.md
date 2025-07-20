# Privacy Policy for Happy Coder

**Last Updated: January 2025**

## Overview

Happy Coder is committed to protecting your privacy. This policy explains how we handle your data with our zero-knowledge encryption architecture.

## What We Collect

### Encrypted Data
- **Messages and Code**: All your Claude Code conversations and code snippets are end-to-end encrypted on your device before transmission. We store this encrypted data but have no ability to decrypt or read it.
- **Encryption Keys**: When you pair devices, encryption keys are transmitted between your devices in encrypted form. We cannot access or decrypt these keys.

### Metadata (Not Encrypted)
- **Message IDs**: Unique identifiers for message ordering and synchronization
- **Timestamps**: When messages were created and synced
- **Device IDs**: Anonymous identifiers for device pairing
- **Session IDs**: Identifiers for your Claude Code terminal sessions
- **Push Notification Tokens**: Device tokens for sending push notifications via Expo's push notification service

## What We Don't Collect
- Your actual code or conversation content (we can't decrypt it)
- Personal information beyond what you voluntarily include in encrypted messages
- Device information beyond anonymous IDs
- Location data
- Analytics or tracking data

## How We Use Data

### Encrypted Data
- Stored on our servers solely for synchronization between your devices
- Transmitted to your paired devices when requested
- Retained until you delete it through the app

### Metadata
- Message IDs and timestamps are used to maintain proper message ordering
- Device IDs enable secure pairing between your devices
- Session IDs track your Claude Code terminal sessions for synchronization
- Push notification tokens are stored to enable notifications through Expo's service

### Push Notifications
Push notifications are sent directly from your devices to each other, not from our backend. This means:
- We never see the content of your notifications
- Notification content is generated on your device
- Only device-to-device communication occurs for notification content
- We use Expo's push notification service solely as a delivery mechanism

## Data Security

- **End-to-End Encryption**: Using TweetNaCl (same as Signal) for all sensitive data
- **Zero-Knowledge**: We cannot decrypt your data even if compelled
- **Secure Key Exchange**: Encryption keys are transmitted between your devices only in encrypted form that we cannot access
- **Open Source**: Our encryption implementation is publicly auditable
- **No Backdoors**: The architecture makes it impossible for us to access your content

## Data Retention

- Encrypted messages are retained indefinitely until you delete them
- Metadata is retained for system functionality
- Deleted data is permanently removed from our servers within 30 days

## Your Rights

You have the right to:
- Delete all your data through the app
- Export your encrypted data
- Audit our open-source code
- Use the app without providing any personal information

## Data Sharing

We do not share your data with anyone. Period.

## Changes to This Policy

We will notify users of any material changes to this privacy policy through the app. Continued use of the service after changes constitutes acceptance.

## Contact

For privacy concerns or questions:
- GitHub Issues: https://github.com/slopus/happy-coder/issues

## Compliance

Happy Coder is designed with privacy by default and complies with:
- GDPR (General Data Protection Regulation)
- CCPA (California Consumer Privacy Act)
- Privacy by Design principles

---

**Remember**: Your encryption keys are only shared between your own devices in encrypted form. We cannot read your code or conversations even if we wanted to.