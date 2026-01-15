import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('ProfilePickerScreen routing', () => {
    it('does not serialize full profile JSON into profile-edit URL params', () => {
        const file = join(process.cwd(), 'sources/app/(app)/new/pick/profile.tsx');
        const content = readFileSync(file, 'utf8');

        expect(content).not.toContain('profileData=');
        expect(content).not.toContain('encodeURIComponent(profileData)');
        expect(content).not.toContain('JSON.stringify(profile)');
    });

    it('consumes returned profileId param from profile-edit to auto-select and close', () => {
        const file = join(process.cwd(), 'sources/app/(app)/new/pick/profile.tsx');
        const content = readFileSync(file, 'utf8');

        // When profile-edit navigates back, it returns selection via navigation params.
        // The picker must read that param and forward it back to /new.
        expect(content).toMatch(/profileId\?:/);
        expect(content).toContain('setProfileParamAndClose');
        expect(content).toContain('params.profileId');
    });
});

