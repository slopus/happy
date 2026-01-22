export type LightDevPlan = {
    prismaSchemaPath: string;
    prismaDeployArgs: string[];
    startLightArgs: string[];
};

export function buildLightDevPlan(): LightDevPlan {
    const prismaSchemaPath = 'prisma/sqlite/schema.prisma';
    return {
        prismaSchemaPath,
        prismaDeployArgs: ['-s', 'prisma', 'migrate', 'deploy', '--schema', prismaSchemaPath],
        startLightArgs: ['-s', 'start:light'],
    };
}

