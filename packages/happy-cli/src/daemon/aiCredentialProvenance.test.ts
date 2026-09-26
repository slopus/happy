import { describe, expect, it } from 'vitest'
import {
    AI_CREDENTIAL_PROVENANCE_PATH,
    parseClaudeProvenanceInput,
    readActiveClaudeProvenance,
    serializeAppliedClaudeProvenance,
    serializeInvalidatedClaudeProvenance,
} from './aiCredentialProvenance'

const HOME = '/home/operator'
const PROVENANCE = `${HOME}/${AI_CREDENTIAL_PROVENANCE_PATH}`
const GENERATIONS = `${HOME}/.happy/ai-credential-apply-generations.json`

const input = { companyId: 'co-1', bundleId: 'bundle-1', bundleVersion: 3 }
// [email, organizationUuid, organizationName] — the name is what Claude Code's
// accountInfo() reports, the uuid is what cswap and the login metadata carry.
const identities = [
    JSON.stringify(['a@corp.com', 'org-a', 'Corp Inc']),
    JSON.stringify(['b@corp.com', '', '']),
]

function reader(files: Record<string, string>) {
    return async (path: string) => {
        if (path in files) return files[path]!
        throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    }
}

function generations(claude: number) {
    return JSON.stringify({ version: 1, generations: { claude } })
}

describe('parseClaudeProvenanceInput', () => {
    it('accepts the three fields the org deployment sends', () => {
        expect(parseClaudeProvenanceInput(input)).toEqual(input)
    })

    it.each([
        ['nothing', undefined],
        ['a non-object', 'co-1'],
        ['an empty company', { ...input, companyId: '' }],
        ['a missing bundle', { companyId: 'co-1', bundleVersion: 3 }],
        ['a fractional version', { ...input, bundleVersion: 1.5 }],
        ['a zero version', { ...input, bundleVersion: 0 }],
        ['an oversized id', { ...input, bundleId: 'x'.repeat(200) }],
    ])('rejects %s', (_label, value) => {
        expect(parseClaudeProvenanceInput(value)).toBeNull()
    })
})

describe('readActiveClaudeProvenance — the generation fence', () => {
    it('returns the record when it was written for the current claude generation', async () => {
        const record = await readActiveClaudeProvenance({
            homeDir: HOME,
            readFile: reader({
                [PROVENANCE]: serializeAppliedClaudeProvenance({ generation: 12, ...input, identities }),
                [GENERATIONS]: generations(12),
            }),
        })
        expect(record).toEqual({ generation: 12, ...input, identities: new Set(identities) })
    })

    it('rejects a record from an earlier generation — an apply started after it was written', async () => {
        // reserveApplyGeneration bumps the claude generation before any credential
        // changes, so a record left from the previous apply stops counting the
        // moment the next one starts, crash or not.
        await expect(readActiveClaudeProvenance({
            homeDir: HOME,
            readFile: reader({
                [PROVENANCE]: serializeAppliedClaudeProvenance({ generation: 12, ...input, identities }),
                [GENERATIONS]: generations(13),
            }),
        })).resolves.toBeNull()
    })

    it('rejects an invalidated record', async () => {
        await expect(readActiveClaudeProvenance({
            homeDir: HOME,
            readFile: reader({
                [PROVENANCE]: serializeInvalidatedClaudeProvenance(12),
                [GENERATIONS]: generations(12),
            }),
        })).resolves.toBeNull()
    })

    it.each(['applying', 'unknown-state'])(
        'rejects a complete record whose state is %s — the state gate stands on its own',
        async (state) => {
            // The invalidated record above also lacks the company/bundle/identity
            // fields, so it is rejected even without the state check. This one has
            // every field and only the state is wrong.
            const complete = JSON.parse(serializeAppliedClaudeProvenance({ generation: 12, ...input, identities }))
            complete.claude.state = state
            await expect(readActiveClaudeProvenance({
                homeDir: HOME,
                readFile: reader({ [PROVENANCE]: JSON.stringify(complete), [GENERATIONS]: generations(12) }),
            })).resolves.toBeNull()
        },
    )

    it.each([
        ['no provenance file', { [GENERATIONS]: generations(12) }],
        ['no generations file', {
            [PROVENANCE]: serializeAppliedClaudeProvenance({ generation: 12, ...input, identities }),
        }],
        ['a corrupt provenance file', { [PROVENANCE]: '{not json', [GENERATIONS]: generations(12) }],
        ['an unknown provenance version', {
            [PROVENANCE]: JSON.stringify({ version: 2, claude: { state: 'applied' } }),
            [GENERATIONS]: generations(12),
        }],
        ['malformed identities', {
            [PROVENANCE]: JSON.stringify({
                version: 1,
                claude: { state: 'applied', generation: 12, ...input, identities: [['only-one']] },
            }),
            [GENERATIONS]: generations(12),
        }],
        ['identities without an organization name — an older record shape', {
            [PROVENANCE]: JSON.stringify({
                version: 1,
                claude: { state: 'applied', generation: 12, ...input, identities: [['a@corp.com', 'org-a']] },
            }),
            [GENERATIONS]: generations(12),
        }],
        ['no identities', {
            [PROVENANCE]: serializeAppliedClaudeProvenance({ generation: 12, ...input, identities: [] }),
            [GENERATIONS]: generations(12),
        }],
    ])('returns null for %s — never guesses', async (_label, files) => {
        await expect(readActiveClaudeProvenance({ homeDir: HOME, readFile: reader(files) }))
            .resolves.toBeNull()
    })

    it('never throws, even when reading itself fails unexpectedly', async () => {
        await expect(readActiveClaudeProvenance({
            homeDir: HOME,
            readFile: async () => { throw new Error('EACCES') },
        })).resolves.toBeNull()
    })
})
