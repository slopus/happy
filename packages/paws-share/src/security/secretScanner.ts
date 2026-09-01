import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import type { PublicSessionSnapshot } from '@slopus/happy-wire';
import type { ResolvedAttachment } from '../adapters/types';
import { readResolvedAttachmentBytes } from '../adapters/shared';

export type SecretFinding = {
    rule: 'private-key' | 'vendor-token' | 'bearer-token' | 'credential-assignment'
        | 'email-address' | 'absolute-home-path' | 'ip-address';
    severity: 'block' | 'warn';
    location: string;
    fingerprint: string;
};

type ScannerRule = {
    rule: SecretFinding['rule'];
    severity: SecretFinding['severity'];
    expression: RegExp;
};

const RULES: ScannerRule[] = [
    {
        rule: 'private-key',
        severity: 'block',
        expression: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g,
    },
    {
        rule: 'vendor-token',
        severity: 'block',
        expression: /\b(?:sk-[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/g,
    },
    {
        rule: 'bearer-token',
        severity: 'block',
        expression: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/gi,
    },
    {
        rule: 'credential-assignment',
        severity: 'block',
        expression: /\b[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Z0-9_]*\s*=\s*["']?[^\s"'`]{16,}/g,
    },
    {
        rule: 'email-address',
        severity: 'warn',
        expression: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    },
    {
        rule: 'absolute-home-path',
        severity: 'warn',
        expression: /\/(?:Users|home)\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._ -]+)+/g,
    },
    {
        rule: 'ip-address',
        severity: 'warn',
        expression: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    },
];

function fingerprint(value: string): string {
    return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

export function scanText(value: string, location: string): SecretFinding[] {
    const findings: SecretFinding[] = [];
    const seen = new Set<string>();
    for (const scanner of RULES) {
        scanner.expression.lastIndex = 0;
        for (const match of value.matchAll(scanner.expression)) {
            const matched = match[0];
            const key = `${scanner.rule}:${fingerprint(matched)}`;
            if (seen.has(key)) continue;
            seen.add(key);
            findings.push({
                rule: scanner.rule,
                severity: scanner.severity,
                location,
                fingerprint: fingerprint(matched),
            });
        }
    }
    return findings;
}

function isSmallTextAttachment(attachment: ResolvedAttachment): boolean {
    if (attachment.size > 1024 * 1024) return false;
    if (attachment.mimeType.startsWith('text/')) return true;
    return ['.env', '.json', '.md', '.svg', '.toml', '.txt', '.yaml', '.yml'].includes(extname(attachment.name).toLowerCase());
}

export async function scanShareExport(
    snapshot: PublicSessionSnapshot,
    attachments: ResolvedAttachment[],
): Promise<SecretFinding[]> {
    const findings = scanText(snapshot.title, 'title');
    snapshot.messages.forEach((message, messageIndex) => {
        message.blocks.forEach((block, blockIndex) => {
            const location = `message:${messageIndex + 1}:block:${blockIndex + 1}`;
            if (block.type === 'text' || block.type === 'thinking') {
                findings.push(...scanText(block.markdown, location));
            } else if (block.type === 'tool') {
                if (block.title) findings.push(...scanText(block.title, `${location}:title`));
                if (block.body) findings.push(...scanText(block.body, `${location}:body`));
            } else {
                findings.push(...scanText(block.name, `${location}:name`));
            }
        });
    });
    for (const attachment of attachments) {
        findings.push(...scanText(attachment.name, `attachment:${attachment.name}:name`));
        if (!isSmallTextAttachment(attachment)) continue;
        const text = (await readResolvedAttachmentBytes(attachment)).toString('utf8');
        findings.push(...scanText(text, `attachment:${attachment.name}`));
    }
    return findings;
}
