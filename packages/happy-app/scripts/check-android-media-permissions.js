const fs = require('node:fs');

const config = JSON.parse(fs.readFileSync(0, 'utf8'));
const permissions = config?._internal?.modResults?.android?.manifest?.manifest?.['uses-permission'];
const infoPlist = config?._internal?.modResults?.ios?.infoPlist;

if (!Array.isArray(permissions)) {
    throw new Error('Expo introspection did not provide Android manifest permissions.');
}

const entriesFor = (permission) => permissions.filter(
    (entry) => entry?.$?.['android:name'] === permission,
);
const errors = [];

if (!infoPlist || typeof infoPlist !== 'object') {
    errors.push('Expo introspection did not provide the iOS Info.plist');
} else {
    if (!infoPlist.NSPhotoLibraryAddUsageDescription) {
        errors.push('NSPhotoLibraryAddUsageDescription must declare add-only Photos access');
    }
    if ('NSPhotoLibraryUsageDescription' in infoPlist) {
        errors.push('NSPhotoLibraryUsageDescription must be absent (photo-library read access is not used)');
    }
}
const blockedPermissions = [
    'android.permission.READ_EXTERNAL_STORAGE',
    'android.permission.WRITE_EXTERNAL_STORAGE',
    'android.permission.READ_MEDIA_IMAGES',
    'android.permission.READ_MEDIA_VIDEO',
    'android.permission.READ_MEDIA_VISUAL_USER_SELECTED',
];

for (const permission of blockedPermissions) {
    const entries = entriesFor(permission);
    if (!entries.some((entry) => entry.$['tools:node'] === 'remove')) {
        errors.push(`${permission} is not blocked with tools:node=remove`);
    }
    if (entries.some((entry) => entry.$['tools:node'] !== 'remove')) {
        errors.push(`${permission} is declared as an effective permission`);
    }
}

const audioEntries = entriesFor('android.permission.READ_MEDIA_AUDIO');
if (audioEntries.length > 0) {
    errors.push('android.permission.READ_MEDIA_AUDIO must be absent');
}

if (errors.length > 0) {
    throw new Error(`Image batch native permission check failed:\n- ${errors.join('\n- ')}`);
}

console.log('iOS add-only Photos and Android SAF-only permissions verified.');
