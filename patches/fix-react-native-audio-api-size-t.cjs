/**
 * Xcode 26 compiles react-native-audio-api's Constants.h without a guaranteed
 * declaration of `size_t`. Include <cstddef> and qualify the type explicitly
 * so simulator builds remain portable across Apple toolchains.
 */
const fs = require('fs');
const path = require('path');

const nodeModulesRoots = [
    path.resolve(__dirname, '..', 'node_modules'),
    path.resolve(__dirname, '..', 'packages/happy-app/node_modules'),
];

let patched = 0;

for (const nodeModulesRoot of nodeModulesRoots) {
    const constantsHeader = path.join(
        nodeModulesRoot,
        'react-native-audio-api/common/cpp/audioapi/core/Constants.h'
    );
    if (!fs.existsSync(constantsHeader)) continue;

    let content = fs.readFileSync(constantsHeader, 'utf8');
    const original = content;

    if (!content.includes('#include <cstddef>')) {
        content = content.replace('#include <cmath>\n', '#include <cmath>\n#include <cstddef>\n');
    }
    content = content.replace(
        'static constexpr size_t MAX_FFT_SIZE = 32768;',
        'static constexpr std::size_t MAX_FFT_SIZE = 32768;'
    );

    if (content !== original) {
        fs.writeFileSync(constantsHeader, content, 'utf8');
        patched++;
    }
}

if (patched > 0) {
    console.log(`[patch] Fixed react-native-audio-api size_t for Xcode 26 (${patched} file(s))`);
}
