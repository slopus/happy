import React from 'react';
import { View, ScrollView } from 'react-native';
import { Text } from '../StyledText';

interface TerminalBlockProps {
    command?: string;
    output?: string;
    error?: string;
    maxHeight?: number;
    className?: string;
}

export function TerminalBlock({ 
    command, 
    output, 
    error,
    maxHeight = 300,
    className = '' 
}: TerminalBlockProps) {
    return (
        <View className={`bg-gray-900 rounded-lg overflow-hidden ${className}`}>
            {/* Command line */}
            {command && (
                <View className="px-4 py-3 border-b border-gray-700">
                    <View className="flex-row items-center">
                        <Text className="text-green-400 font-mono text-sm mr-2">$</Text>
                        <Text className="text-gray-100 font-mono text-sm flex-1" selectable>
                            {command}
                        </Text>
                    </View>
                </View>
            )}
            
            {/* Output/Error content */}
            {(output || error) && (
                <ScrollView 
                    style={{ maxHeight }}
                    className="px-4 py-3"
                    showsVerticalScrollIndicator={true}
                    nestedScrollEnabled={true}
                >
                    {error && (
                        <Text className="text-red-400 font-mono text-sm mb-2" selectable>
                            {error}
                        </Text>
                    )}
                    {output && (
                        <Text className="text-gray-300 font-mono text-sm" selectable>
                            {output}
                        </Text>
                    )}
                </ScrollView>
            )}
            
            {/* Empty state */}
            {!command && !output && !error && (
                <View className="px-4 py-8 items-center">
                    <Text className="text-gray-500 font-mono text-sm italic">
                        No output
                    </Text>
                </View>
            )}
        </View>
    );
}