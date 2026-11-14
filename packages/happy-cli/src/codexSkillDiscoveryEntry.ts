import { listCodexSkillNames } from './codex/codexSkills';

// Deliberately no CLI bootstrap, authentication, session registration or model
// imports: this disposable process only reads the local Skill catalog.
try {
    const opts: unknown = JSON.parse(process.argv[2] ?? '{}');
    if (!opts || typeof opts !== 'object' || Array.isArray(opts)) throw new Error('Invalid scan options');
    const { cwd, homeDir } = opts as Record<string, unknown>;
    if ((cwd !== undefined && typeof cwd !== 'string') || (homeDir !== undefined && typeof homeDir !== 'string')) throw new Error('Invalid scan paths');
    process.stdout.write(JSON.stringify(listCodexSkillNames({ cwd, homeDir })));
} catch {
    // Paths and document contents are private; the parent only needs success/failure.
    process.exitCode = 1;
}
