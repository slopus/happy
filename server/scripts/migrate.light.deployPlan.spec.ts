import { describe, expect, it } from 'vitest';
import { buildLightMigrateDeployPlan, requireLightDataDir } from './migrate.light.deployPlan';

describe('requireLightDataDir', () => {
    it('throws when HAPPY_SERVER_LIGHT_DATA_DIR is missing', () => {
        expect(() => requireLightDataDir({})).toThrow(/HAPPY_SERVER_LIGHT_DATA_DIR/);
    });

    it('throws when HAPPY_SERVER_LIGHT_DATA_DIR is empty', () => {
        expect(() => requireLightDataDir({ HAPPY_SERVER_LIGHT_DATA_DIR: '   ' })).toThrow(/HAPPY_SERVER_LIGHT_DATA_DIR/);
    });

    it('returns a trimmed HAPPY_SERVER_LIGHT_DATA_DIR', () => {
        expect(requireLightDataDir({ HAPPY_SERVER_LIGHT_DATA_DIR: '  /tmp/happy  ' })).toBe('/tmp/happy');
    });
});

describe('buildLightMigrateDeployPlan', () => {
    it('throws when HAPPY_SERVER_LIGHT_DATA_DIR is missing', () => {
        expect(() => buildLightMigrateDeployPlan({})).toThrow(/HAPPY_SERVER_LIGHT_DATA_DIR/);
    });

    it('returns the expected schema and migrate args for sqlite', () => {
        const plan = buildLightMigrateDeployPlan({ HAPPY_SERVER_LIGHT_DATA_DIR: '/tmp/happy' });
        expect(plan.dataDir).toBe('/tmp/happy');
        expect(plan.prismaSchemaPath).toBe('prisma/sqlite/schema.prisma');
        expect(plan.schemaGenerateArgs).toEqual(['-s', 'schema:sqlite', '--quiet']);
        expect(plan.prismaDeployArgs).toEqual([
            '-s',
            'prisma',
            'migrate',
            'deploy',
            '--schema',
            'prisma/sqlite/schema.prisma',
        ]);
    });
});
