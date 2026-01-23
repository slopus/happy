export type LightMigrateDeployPlan = {
    dataDir: string;
    prismaSchemaPath: string;
    schemaGenerateArgs: string[];
    prismaDeployArgs: string[];
};

export function requireLightDataDir(env: NodeJS.ProcessEnv): string {
    const raw = env.HAPPY_SERVER_LIGHT_DATA_DIR;
    if (typeof raw !== 'string' || raw.trim() === '') {
        throw new Error('Missing HAPPY_SERVER_LIGHT_DATA_DIR (set it or ensure applyLightDefaultEnv sets it)');
    }
    return raw.trim();
}

export function buildLightMigrateDeployPlan(env: NodeJS.ProcessEnv): LightMigrateDeployPlan {
    const dataDir = requireLightDataDir(env);
    const prismaSchemaPath = 'prisma/sqlite/schema.prisma';
    return {
        dataDir,
        prismaSchemaPath,
        schemaGenerateArgs: ['-s', 'schema:sqlite', '--quiet'],
        prismaDeployArgs: ['-s', 'prisma', 'migrate', 'deploy', '--schema', prismaSchemaPath],
    };
}
