import { describe, expect, it } from "vitest";
import { buildLightDevPlan } from "./dev.lightPlan";

describe('buildLightDevPlan', () => {
    it('uses prisma migrate deploy with the sqlite schema path', () => {
        const plan = buildLightDevPlan();
        expect(plan.prismaSchemaPath).toBe('prisma/sqlite/schema.prisma');
        expect(plan.prismaDeployArgs).toEqual(['-s', 'prisma', 'migrate', 'deploy', '--schema', 'prisma/sqlite/schema.prisma']);
    });
});

