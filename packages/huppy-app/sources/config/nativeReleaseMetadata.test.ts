import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

async function loadExpoConfig() {
    const module = await import('../../app.config.js');
    return module.default;
}

function readMatch(source: string, pattern: RegExp, description: string) {
    const match = source.match(pattern);
    if (!match?.[1]) {
        throw new Error(`Missing ${description}`);
    }
    return match[1];
}

describe('Native release metadata', () => {
    it('keeps the checked-in iOS release version aligned with app.config.js and avoids default build metadata', async () => {
        const appConfig = await loadExpoConfig();
        const releaseVersion = appConfig.expo.version;
        const pbxproj = readFileSync(resolve(process.cwd(), 'ios/Huppy.xcodeproj/project.pbxproj'), 'utf8');
        const infoPlist = readFileSync(resolve(process.cwd(), 'ios/Huppy/Info.plist'), 'utf8');

        const marketingVersions = [...pbxproj.matchAll(/MARKETING_VERSION = ([^;]+);/g)].map((match) => match[1]);
        const projectVersions = [...pbxproj.matchAll(/CURRENT_PROJECT_VERSION = ([^;]+);/g)].map((match) => match[1]);
        const developmentTeams = [...pbxproj.matchAll(/DEVELOPMENT_TEAM = ([^;]+);/g)].map((match) => match[1]);
        const usesDistributionIdentity = pbxproj.includes('"CODE_SIGN_IDENTITY[sdk=iphoneos*]" = "Apple Distribution";');
        const usesAppStoreProfile = pbxproj.includes('PROVISIONING_PROFILE_SPECIFIER = "ai.huppy.app AppStore";');
        const plistVersion = readMatch(infoPlist, /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/, 'CFBundleShortVersionString');
        const plistBuild = readMatch(infoPlist, /<key>CFBundleVersion<\/key>\s*<string>([^<]+)<\/string>/, 'CFBundleVersion');

        expect(marketingVersions.length).toBeGreaterThan(0);
        expect(projectVersions.length).toBeGreaterThan(0);
        expect(new Set(marketingVersions)).toEqual(new Set([releaseVersion]));
        expect(plistVersion).toBe(releaseVersion);
        expect(new Set(projectVersions).size).toBe(1);
        expect(new Set(projectVersions)).not.toEqual(new Set(['1']));
        expect(new Set(developmentTeams)).toEqual(new Set(['Q5A3FVX59D']));
        expect(usesDistributionIdentity).toBe(true);
        expect(usesAppStoreProfile).toBe(true);
        expect(plistBuild).toBe(projectVersions[0]);
        expect(plistBuild).not.toBe('1');
    });
});
