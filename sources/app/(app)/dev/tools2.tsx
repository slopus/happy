import React, { useState } from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { Stack } from 'expo-router';
import { ToolView } from '@/components/blocks/ToolView';
import { ItemGroup } from '@/components/ItemGroup';
import { Item } from '@/components/Item';

export default function Tools2Screen() {
    const [selectedExample, setSelectedExample] = useState<string>('all');

    // Example tool calls data - matching ToolCall interface
    const examples = {
        read: {
            name: 'Read',
            state: 'completed' as const,
            input: {
                file_path: '/Users/steve/project/src/components/Header.tsx',
                offset: 100,
                limit: 50
            },
            result: `import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

export const Header = ({ title }) => {
    return (
        <View style={styles.container}>
            <Text style={styles.title}>{title}</Text>
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        height: 60,
        backgroundColor: '#fff',
        justifyContent: 'center',
        alignItems: 'center',
    },
    title: {
        fontSize: 18,
        fontWeight: 'bold',
    },
});`,
            children: []
        },
        readError: {
            name: 'Read',
            state: 'error' as const,
            input: {
                file_path: '/Users/steve/project/src/components/NotFound.tsx'
            },
            result: 'File not found: /Users/steve/project/src/components/NotFound.tsx',
            children: []
        },
        edit: {
            name: 'Edit',
            state: 'completed' as const,
            input: {
                file_path: '/Users/steve/project/package.json',
                old_string: '"version": "1.0.0"',
                new_string: '"version": "1.0.1"',
                replace_all: false
            },
            result: 'File updated successfully',
            children: []
        },
        bash: {
            name: 'Bash',
            state: 'completed' as const,
            input: {
                command: 'npm install react-native-reanimated',
                description: 'Install animation library',
                timeout: 60000
            },
            result: `added 15 packages, and audited 1250 packages in 12s

125 packages are looking for funding
  run \`npm fund\` for details

found 0 vulnerabilities`,
            children: []
        },
        bashRunning: {
            name: 'Bash',
            state: 'running' as const,
            input: {
                command: 'npm run build',
                description: 'Building the application'
            },
            children: []
        },
        bashError: {
            name: 'Bash',
            state: 'error' as const,
            input: {
                command: 'npm run nonexistent-script',
                description: 'Run a script that doesn\'t exist'
            },
            result: `npm ERR! Missing script: "nonexistent-script"
npm ERR! 
npm ERR! Did you mean one of these?
npm ERR!     npm run test
npm ERR!     npm run build
npm ERR!     npm run start`,
            children: []
        },
        bashLongCommand: {
            name: 'Bash',
            state: 'completed' as const,
            input: {
                command: 'git log --pretty=format:"%h - %an, %ar : %s" --graph --since=2.weeks --author="John Doe" --grep="fix" --all',
                description: 'Search git history for fixes'
            },
            result: `* 3a4f5b6 - John Doe, 2 days ago : fix: resolve memory leak in worker threads
* 1c2d3e4 - John Doe, 5 days ago : fix: correct typo in documentation
* 9f8e7d6 - John Doe, 1 week ago : fix: handle edge case in data parser
* 5b4c3d2 - John Doe, 10 days ago : fix: update dependencies to patch vulnerabilities`,
            children: []
        },
        bashMultiline: {
            name: 'Bash',
            state: 'completed' as const,
            input: {
                command: 'echo "Starting deployment..." && npm run build && npm run test && echo "Deployment complete!"',
                description: 'Multi-step deployment process'
            },
            result: `Starting deployment...

> myapp@1.0.0 build
> webpack --mode production

asset main.js 245 KiB [emitted] [minimized] (name: main)
asset index.html 1.2 KiB [emitted]
webpack compiled successfully in 3241 ms

> myapp@1.0.0 test
> jest

PASS  src/App.test.js
PASS  src/utils.test.js
PASS  src/components/Header.test.js

Test Suites: 3 passed, 3 total
Tests:       15 passed, 15 total
Time:        4.123s

Deployment complete!`,
            children: []
        },
        bashLargeOutput: {
            name: 'Bash',
            state: 'completed' as const,
            input: {
                command: 'ls -la node_modules/.bin',
                description: 'List all executable scripts'
            },
            result: `total 1864
drwxr-xr-x  234 user  staff   7488 Dec 15 14:32 .
drwxr-xr-x  782 user  staff  25024 Dec 15 14:32 ..
lrwxr-xr-x    1 user  staff     18 Dec 15 14:30 acorn -> ../acorn/bin/acorn
lrwxr-xr-x    1 user  staff     29 Dec 15 14:30 autoprefixer -> ../autoprefixer/bin/autoprefixer
lrwxr-xr-x    1 user  staff     25 Dec 15 14:30 browserslist -> ../browserslist/cli.js
lrwxr-xr-x    1 user  staff     26 Dec 15 14:30 css-blank-pseudo -> ../css-blank-pseudo/cli.js
lrwxr-xr-x    1 user  staff     26 Dec 15 14:30 css-has-pseudo -> ../css-has-pseudo/cli.js
lrwxr-xr-x    1 user  staff     29 Dec 15 14:30 css-prefers-color-scheme -> ../css-prefers-color-scheme/cli.js
lrwxr-xr-x    1 user  staff     17 Dec 15 14:30 cssesc -> ../cssesc/bin/cssesc
lrwxr-xr-x    1 user  staff     20 Dec 15 14:30 detective -> ../detective/bin/detective.js
lrwxr-xr-x    1 user  staff     16 Dec 15 14:30 esparse -> ../esprima/bin/esparse.js
lrwxr-xr-x    1 user  staff     18 Dec 15 14:30 esvalidate -> ../esprima/bin/esvalidate.js
lrwxr-xr-x    1 user  staff     20 Dec 15 14:30 he -> ../he/bin/he
lrwxr-xr-x    1 user  staff     23 Dec 15 14:30 html-minifier-terser -> ../html-minifier-terser/cli.js
lrwxr-xr-x    1 user  staff     19 Dec 15 14:30 import-local-fixture -> ../import-local/fixtures/cli.js
lrwxr-xr-x    1 user  staff     13 Dec 15 14:30 jest -> ../jest/bin/jest.js`,
            children: []
        },
        bashNoOutput: {
            name: 'Bash',
            state: 'completed' as const,
            input: {
                command: 'mkdir -p temp/test/dir',
                description: 'Create nested directories'
            },
            result: '',
            children: []
        },
        bashWithWarnings: {
            name: 'Bash',
            state: 'completed' as const,
            input: {
                command: 'npm audit',
                description: 'Check for security vulnerabilities',
                timeout: 30000
            },
            result: `found 3 vulnerabilities (1 low, 2 moderate)

To address all issues, run:
  npm audit fix

To address issues that do not require attention, run:
  npm audit fix --force`,
            children: []
        },
        search: {
            name: 'Search',
            state: 'completed' as const,
            input: {
                query: 'useState',
                path: './src',
                include: '*.tsx'
            },
            result: JSON.stringify({
                results: [
                    { file: 'App.tsx', line: 5, match: 'const [count, setCount] = useState(0);' },
                    { file: 'components/Counter.tsx', line: 3, match: 'const [value, setValue] = useState(props.initial);' }
                ],
                totalMatches: 2
            }, null, 2),
            children: []
        },
        write: {
            name: 'Write',
            state: 'completed' as const,
            input: {
                file_path: '/Users/steve/project/src/utils/helpers.ts',
                content: `export function formatDate(date: Date): string {
    return date.toLocaleDateString();
}

export function formatTime(date: Date): string {
    return date.toLocaleTimeString();
}`
            },
            result: 'File created successfully',
            children: []
        }
    };

    const renderExample = (key: string, example: any) => {
        if (selectedExample !== 'all' && selectedExample !== key) {
            return null;
        }

        return (
            <View key={key} style={styles.exampleContainer}>
                <Text style={styles.exampleTitle}>{key}</Text>
                <ToolView 
                    tool={example} 
                    metadata={null}
                    onPress={() => console.log(`Pressed tool: ${key}`)}
                />
            </View>
        );
    };

    return (
        <>
            <Stack.Screen
                options={{
                    headerTitle: 'Tool Views Demo',
                }}
            />
            
            <ScrollView style={styles.container}>
                <View style={styles.content}>
                    <Text style={styles.pageTitle}>Tool View Components</Text>
                    <Text style={styles.description}>
                        Examples of different tool calls and their visual representations
                    </Text>

                    <ItemGroup title="Filter Examples">
                        <Item
                            title="All Examples"
                            selected={selectedExample === 'all'}
                            onPress={() => setSelectedExample('all')}
                        />
                        <Item
                            title="Read Tool"
                            selected={selectedExample === 'read'}
                            onPress={() => setSelectedExample('read')}
                        />
                        <Item
                            title="Edit Tool"
                            selected={selectedExample === 'edit'}
                            onPress={() => setSelectedExample('edit')}
                        />
                        <Item
                            title="Bash Tool"
                            selected={selectedExample === 'bash'}
                            onPress={() => setSelectedExample('bash')}
                        />
                        <Item
                            title="Other Tools"
                            selected={selectedExample === 'other'}
                            onPress={() => setSelectedExample('other')}
                        />
                    </ItemGroup>

                    <View style={styles.examplesSection}>
                        <Text style={styles.sectionTitle}>Examples</Text>
                        
                        {selectedExample === 'all' || selectedExample === 'read' ? (
                            <>
                                {renderExample('read', examples.read)}
                                {renderExample('readError', examples.readError)}
                            </>
                        ) : null}

                        {selectedExample === 'all' || selectedExample === 'edit' ? (
                            renderExample('edit', examples.edit)
                        ) : null}

                        {selectedExample === 'all' || selectedExample === 'bash' ? (
                            <>
                                {renderExample('bash', examples.bash)}
                                {renderExample('bashRunning', examples.bashRunning)}
                                {renderExample('bashError', examples.bashError)}
                                {renderExample('bashLongCommand', examples.bashLongCommand)}
                                {renderExample('bashMultiline', examples.bashMultiline)}
                                {renderExample('bashLargeOutput', examples.bashLargeOutput)}
                                {renderExample('bashNoOutput', examples.bashNoOutput)}
                                {renderExample('bashWithWarnings', examples.bashWithWarnings)}
                            </>
                        ) : null}

                        {selectedExample === 'all' || selectedExample === 'other' ? (
                            <>
                                {renderExample('search', examples.search)}
                                {renderExample('write', examples.write)}
                            </>
                        ) : null}
                    </View>
                </View>
            </ScrollView>
        </>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#F2F2F7',
    },
    content: {
        flex: 1,
    },
    pageTitle: {
        fontSize: 28,
        fontWeight: 'bold',
        marginTop: 20,
        marginBottom: 8,
        paddingHorizontal: 16,
    },
    description: {
        fontSize: 16,
        color: '#666',
        marginBottom: 20,
        paddingHorizontal: 16,
    },
    sectionTitle: {
        fontSize: 20,
        fontWeight: '600',
        marginTop: 24,
        marginBottom: 16,
        paddingHorizontal: 16,
    },
    examplesSection: {
        paddingBottom: 40,
    },
    exampleContainer: {
        marginBottom: 16,
        paddingHorizontal: 16,
    },
    exampleTitle: {
        fontSize: 14,
        fontWeight: '600',
        color: '#666',
        marginBottom: 8,
        textTransform: 'uppercase',
    },
});