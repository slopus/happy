/**
 * Where this machine's Claude credential came from, as far as the daemon knows.
 *
 * The org deployment sends `{companyId, bundleId, bundleVersion}` with its
 * `ai-credential:apply`; after a verified import the runtime records it here
 * together with the bundle's account identities. The observed-source check
 * reads it at spawn time to tell a company-deployed login from any other.
 *
 * The record is only believed for the **current** claude apply generation.
 * `reserveApplyGeneration` bumps that generation before any credential changes,
 * so a record from the previous apply stops counting the moment the next one
 * starts — including when the daemon dies mid-apply and never gets to write.
 *
 * Nothing here ever throws to a reader. A record that cannot be read, parsed or
 * fenced is simply absent: the answer is `unknown`, never a guess.
 */
import { join } from 'node:path'

export const AI_CREDENTIAL_PROVENANCE_PATH = join('.happy', 'ai-credential-provenance.json')
const APPLY_GENERATIONS_PATH = join('.happy', 'ai-credential-apply-generations.json')

const MAX_ID_LENGTH = 128

export type ClaudeProvenanceInput = {
    companyId: string
    bundleId: string
    bundleVersion: number
}

export type ActiveClaudeProvenance = ClaudeProvenanceInput & {
    generation: number
    /**
     * `JSON.stringify([email, organizationUuid, organizationName])` per bundle
     * account ('' where absent). The uuid is what cswap and the login metadata
     * carry; the name is what Claude Code's `accountInfo()` reports.
     */
    identities: Set<string>
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isId(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH
}

function isPositiveInteger(value: unknown): value is number {
    return Number.isSafeInteger(value) && Number(value) >= 1
}

export function parseClaudeProvenanceInput(value: unknown): ClaudeProvenanceInput | null {
    if (!isObject(value)) return null
    const { companyId, bundleId, bundleVersion } = value
    if (!isId(companyId) || !isId(bundleId) || !isPositiveInteger(bundleVersion)) return null
    return { companyId, bundleId, bundleVersion }
}

export function serializeAppliedClaudeProvenance(record: ClaudeProvenanceInput & {
    generation: number
    identities: Iterable<string>
}): string {
    return JSON.stringify({
        version: 1,
        claude: {
            state: 'applied',
            generation: record.generation,
            companyId: record.companyId,
            bundleId: record.bundleId,
            bundleVersion: record.bundleVersion,
            identities: [...record.identities].map((identity) => JSON.parse(identity) as unknown),
        },
    })
}

export function serializeInvalidatedClaudeProvenance(generation: number): string {
    return JSON.stringify({ version: 1, claude: { state: 'applying', generation } })
}

function parseIdentities(value: unknown): Set<string> | null {
    if (!Array.isArray(value) || value.length === 0) return null
    const identities = new Set<string>()
    for (const entry of value) {
        if (!Array.isArray(entry) || entry.length !== 3
            || typeof entry[0] !== 'string' || entry[0] === ''
            || typeof entry[1] !== 'string'
            || typeof entry[2] !== 'string') {
            return null
        }
        identities.add(JSON.stringify([entry[0], entry[1], entry[2]]))
    }
    return identities
}

async function readJson(
    readFile: (path: string) => Promise<string>,
    path: string,
): Promise<unknown> {
    return JSON.parse(await readFile(path)) as unknown
}

export async function readActiveClaudeProvenance(input: {
    homeDir: string
    readFile: (path: string) => Promise<string>
}): Promise<ActiveClaudeProvenance | null> {
    try {
        const file = await readJson(input.readFile, join(input.homeDir, AI_CREDENTIAL_PROVENANCE_PATH))
        if (!isObject(file) || file.version !== 1 || !isObject(file.claude)) return null
        const claude = file.claude
        if (claude.state !== 'applied' || !isPositiveInteger(claude.generation)) return null
        const provenance = parseClaudeProvenanceInput(claude)
        const identities = parseIdentities(claude.identities)
        if (!provenance || !identities) return null

        const generations = await readJson(input.readFile, join(input.homeDir, APPLY_GENERATIONS_PATH))
        if (!isObject(generations) || generations.version !== 1 || !isObject(generations.generations)) {
            return null
        }
        if (generations.generations.claude !== claude.generation) return null

        return { ...provenance, generation: claude.generation, identities }
    } catch {
        return null
    }
}
