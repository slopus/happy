import React, { useState } from 'react';
import { Text, useInput, Box } from 'ink';

interface DaemonPromptProps {
    onSelect: (autoStart: boolean) => void;
}

export const DaemonPrompt: React.FC<DaemonPromptProps> = ({ onSelect }) => {
    const [selectedIndex, setSelectedIndex] = useState(0); // 0 = Yes, 1 = No
    
    const options = [
        { value: true, label: 'Yes (recommended)', key: 'Y' },
        { value: false, label: 'No', key: 'N' }
    ];

    useInput((input, key) => {
        const upperInput = input.toUpperCase();
        
        if (key.upArrow || key.leftArrow) {
            setSelectedIndex(0);
        } else if (key.downArrow || key.rightArrow) {
            setSelectedIndex(1);
        } else if (key.return) {
            onSelect(options[selectedIndex].value);
        } else if (upperInput === 'Y') {
            onSelect(true);
        } else if (upperInput === 'N') {
            onSelect(false);
        } else if (key.escape || (key.ctrl && input === 'c')) {
            // Default to not auto-starting if cancelled
            onSelect(false);
        }
    });

    return (
        <Box flexDirection="column">
            <Box marginBottom={1}>
                <Text bold color="cyan">🚀 Happy Daemon Setup</Text>
            </Box>
            
            <Box flexDirection="column" marginBottom={1}>
                <Text>📱 Happy can run a background service that allows you to:</Text>
                <Text color="cyan">  • Spawn new conversations from your phone</Text>
                <Text color="cyan">  • Continue closed conversations remotely</Text>
                <Text color="cyan">  • Work with Claude while your computer has internet</Text>
            </Box>
            
            <Box marginBottom={1}>
                <Text>Would you like Happy to start this service automatically?</Text>
            </Box>

            <Box flexDirection="column">
                {options.map((option, index) => {
                    const isSelected = selectedIndex === index;
                    
                    return (
                        <Box key={option.key}>
                            <Text color={isSelected ? "green" : "gray"}>
                                {isSelected ? '› ' : '  '}
                                [{option.key}] {option.label}
                            </Text>
                        </Box>
                    );
                })}
            </Box>

            <Box marginTop={1}>
                <Text dimColor>Press Y/N or use arrows + Enter to select</Text>
            </Box>
        </Box>
    );
};