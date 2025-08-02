import * as React from 'react';
import { View, ScrollView, Text, ActivityIndicator } from 'react-native';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { testRunner, TestSuite, TestResult } from '@/dev/testRunner';
import { Ionicons } from '@expo/vector-icons';
import { Typography } from '@/constants/Typography';
import { InfoBox } from '@/components/atoms/InfoBox';

// Import all test files here
import '@/encryption/hmac_sha512.appspec';
import '@/encryption/deriveKey.appspec';

interface TestRunState {
    running: boolean;
    results: TestSuite[];
}

export default function TestsScreen() {
    const [state, setState] = React.useState<TestRunState>({
        running: false,
        results: []
    });

    const runAllTests = async () => {
        setState({ running: true, results: [] });
        
        try {
            const results = await testRunner.runAll();
            setState({ running: false, results });
        } catch (error) {
            console.error('Error running tests:', error);
            setState({ running: false, results: [] });
        }
    };

    const runSuite = async (suiteName: string) => {
        setState(prev => ({ ...prev, running: true }));
        
        try {
            const result = await testRunner.runSuite(suiteName);
            if (result) {
                setState(prev => ({
                    running: false,
                    results: [
                        ...prev.results.filter(r => r.name !== suiteName),
                        result
                    ]
                }));
            }
        } catch (error) {
            console.error('Error running test suite:', error);
            setState(prev => ({ ...prev, running: false }));
        }
    };

    const suites = testRunner.getSuites();
    const totalTests = state.results.reduce((sum, suite) => sum + suite.tests.length, 0);
    const passedTests = state.results.reduce((sum, suite) => 
        sum + suite.tests.filter(t => t.passed).length, 0);
    const failedTests = totalTests - passedTests;

    return (
        <ItemList>
            {/* Summary */}
            {state.results.length > 0 && (
                <View style={{ padding: 16, backgroundColor: 'white' }}>
                    <View style={{ flexDirection: 'row', gap: 16, marginBottom: 8 }}>
                        <View style={{ flex: 1 }}>
                            <Text style={{ ...Typography.mono(), fontSize: 32, fontWeight: '600' }}>
                                {totalTests}
                            </Text>
                            <Text style={{ ...Typography.default(), fontSize: 14, color: '#8E8E93' }}>
                                Total Tests
                            </Text>
                        </View>
                        <View style={{ flex: 1 }}>
                            <Text style={{ ...Typography.mono(), fontSize: 32, fontWeight: '600', color: '#34C759' }}>
                                {passedTests}
                            </Text>
                            <Text style={{ ...Typography.default(), fontSize: 14, color: '#8E8E93' }}>
                                Passed
                            </Text>
                        </View>
                        <View style={{ flex: 1 }}>
                            <Text style={{ ...Typography.mono(), fontSize: 32, fontWeight: '600', color: failedTests > 0 ? '#FF3B30' : '#8E8E93' }}>
                                {failedTests}
                            </Text>
                            <Text style={{ ...Typography.default(), fontSize: 14, color: '#8E8E93' }}>
                                Failed
                            </Text>
                        </View>
                    </View>
                </View>
            )}

            {/* Run All Tests */}
            <ItemGroup title="Actions">
                <Item
                    title="Run All Tests"
                    subtitle={`${suites.length} test suites available`}
                    icon={<Ionicons name="play-circle-outline" size={28} color="#34C759" />}
                    onPress={runAllTests}
                    loading={state.running}
                    showChevron={false}
                />
            </ItemGroup>

            {/* Test Suites */}
            <ItemGroup title="Test Suites">
                {suites.map(suiteName => {
                    const result = state.results.find(r => r.name === suiteName);
                    const hasRun = !!result;
                    const passed = result?.tests.every(t => t.passed) ?? false;
                    const testCount = result?.tests.length ?? 0;
                    const passedCount = result?.tests.filter(t => t.passed).length ?? 0;
                    
                    return (
                        <Item
                            key={suiteName}
                            title={suiteName}
                            subtitle={hasRun ? `${passedCount}/${testCount} tests passed` : 'Not run'}
                            icon={
                                hasRun ? (
                                    <Ionicons 
                                        name={passed ? "checkmark-circle" : "close-circle"} 
                                        size={28} 
                                        color={passed ? "#34C759" : "#FF3B30"} 
                                    />
                                ) : (
                                    <Ionicons name="ellipse-outline" size={28} color="#8E8E93" />
                                )
                            }
                            onPress={() => runSuite(suiteName)}
                            loading={state.running}
                        />
                    );
                })}
            </ItemGroup>

            {/* Test Results */}
            {state.results.map(suite => (
                <ItemGroup key={suite.name} title={`${suite.name} Results`}>
                    {suite.tests.map((test, index) => (
                        <View key={index} style={{ backgroundColor: 'white' }}>
                            <View style={{ 
                                padding: 16, 
                                flexDirection: 'row', 
                                alignItems: 'center',
                                gap: 12
                            }}>
                                <Ionicons 
                                    name={test.passed ? "checkmark-circle" : "close-circle"} 
                                    size={24} 
                                    color={test.passed ? "#34C759" : "#FF3B30"} 
                                />
                                <View style={{ flex: 1 }}>
                                    <Text style={{ ...Typography.default(), fontSize: 16 }}>
                                        {test.name}
                                    </Text>
                                    <Text style={{ ...Typography.mono(), fontSize: 12, color: '#8E8E93', marginTop: 2 }}>
                                        {test.duration}ms
                                    </Text>
                                </View>
                            </View>
                            {test.error && (
                                <View style={{ paddingHorizontal: 16, paddingBottom: 16 }}>
                                    <InfoBox variant="error">
                                        <Text style={{ ...Typography.mono(), fontSize: 12, color: '#FF3B30' }}>
                                            {test.error.message}
                                        </Text>
                                        {test.error.stack && (
                                            <Text style={{ 
                                                ...Typography.mono(), 
                                                fontSize: 10, 
                                                color: '#8E8E93',
                                                marginTop: 8 
                                            }}>
                                                {test.error.stack}
                                            </Text>
                                        )}
                                    </InfoBox>
                                </View>
                            )}
                        </View>
                    ))}
                </ItemGroup>
            ))}

            {state.running && (
                <View style={{ padding: 32, alignItems: 'center' }}>
                    <ActivityIndicator size="large" color="#007AFF" />
                    <Text style={{ ...Typography.default(), fontSize: 16, color: '#8E8E93', marginTop: 16 }}>
                        Running tests...
                    </Text>
                </View>
            )}
        </ItemList>
    );
}