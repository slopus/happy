import React, { useState } from 'react';
import { ScrollView, View, Text, Pressable, TextInput, Switch } from 'react-native';
import { DiffView } from '@/components/files/DiffView';
import { useColorScheme } from '@/components/useColorScheme';

// Sample text pairs for testing
const SAMPLES = [
  {
    name: 'Simple Code Change',
    old: `function greet(name) {
  console.log("Hello, " + name);
  return "Hello, " + name;
}`,
    new: `function greet(name, title = '') {
  const greeting = title ? \`Hello, \${title} \${name}\` : \`Hello, \${name}\`;
  console.log(greeting);
  return greeting;
}`
  },
  {
    name: 'Multi-line Edit',
    old: `const config = {
  host: 'localhost',
  port: 3000,
  debug: true
};

function connect() {
  console.log('Connecting...');
}`,
    new: `const config = {
  host: process.env.HOST || 'localhost',
  port: process.env.PORT || 3000,
  debug: process.env.NODE_ENV !== 'production',
  timeout: 5000
};

async function connect(options = {}) {
  console.log('Connecting with options:', options);
  await new Promise(resolve => setTimeout(resolve, 100));
  console.log('Connected!');
}`
  },
  {
    name: 'New File',
    old: '',
    new: `import React from 'react';

export const Button = ({ onClick, children }) => {
  return (
    <button onClick={onClick} className="btn">
      {children}
    </button>
  );
};`
  },
  {
    name: 'File Deletion',
    old: `// Deprecated module
export function oldFunction() {
  console.warn('This function is deprecated');
  return null;
}`,
    new: ''
  },
  {
    name: 'Character Diff',
    old: 'The quick brown fox jumps over the lazy dog.',
    new: 'The quick brown fox leaps over the sleepy cat.'
  },
  {
    name: 'Long Lines',
    old: 'This is a very long line that should demonstrate how the diff viewer handles text wrapping when lines exceed the viewport width. It contains a lot of text to ensure that we can properly test the horizontal scrolling functionality.',
    new: 'This is a very long line that should demonstrate how the diff viewer handles text wrapping when lines exceed the viewport width. It has been modified and contains even more text to ensure that we can properly test the horizontal scrolling functionality with different content.'
  },
  {
    name: 'Inline Changes',
    old: `function calculate(a, b) {
  const result = a + b;
  console.log("Result is: " + result);
  return result;
}`,
    new: `function calculateSum(a, b, c = 0) {
  const result = a + b + c;
  console.log(\`Result is: \${result}\`);
  return result;
}`
  }
];

// Define colors inline
const COLORS = {
  light: {
    background: '#FFFFFF',
    surface: '#FFFFFF',
    surfaceVariant: '#F3F4F6',
    onBackground: '#111827',
    onSurface: '#111827',
    onSurfaceVariant: '#6B7280',
    outline: '#D1D5DB',
    primary: '#3B82F6',
    onPrimary: '#FFFFFF',
    primaryContainer: '#DBEAFE',
    onPrimaryContainer: '#1E3A8A',
    info: '#3B82F6',
    infoContainer: '#DBEAFE',
  },
  dark: {
    background: '#111827',
    surface: '#1F2937',
    surfaceVariant: '#374151',
    onBackground: '#F9FAFB',
    onSurface: '#F9FAFB',
    onSurfaceVariant: '#9CA3AF',
    outline: '#4B5563',
    primary: '#60A5FA',
    onPrimary: '#1E3A8A',
    primaryContainer: '#1E3A8A',
    onPrimaryContainer: '#DBEAFE',
    info: '#60A5FA',
    infoContainer: '#1E3A8A',
  }
};

export default function DiffDemoScreen() {
  const colorScheme = useColorScheme();
  const colors = COLORS[colorScheme ?? 'light'];
  
  const [selectedSample, setSelectedSample] = useState(0);
  const [showLineNumbers, setShowLineNumbers] = useState(true);
  const [contextLines, setContextLines] = useState(3);
  const [customOld, setCustomOld] = useState('');
  const [customNew, setCustomNew] = useState('');
  const [useCustom, setUseCustom] = useState(false);
  const [wrapLines, setWrapLines] = useState(true);
  const [fontScaleX, setFontScaleX] = useState(1);

  const currentSample = SAMPLES[selectedSample];
  const oldText = useCustom ? customOld : currentSample.old;
  const newText = useCustom ? customNew : currentSample.new;

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScrollView style={{ flex: 1 }}>
        <View style={{ padding: 16 }}>
          <Text style={{ 
            fontSize: 28, 
            fontWeight: 'bold', 
            color: colors.onBackground,
            marginBottom: 16 
          }}>
            Diff View Demo
          </Text>

        {/* Controls */}
        <View style={{ 
          backgroundColor: colors.surface, 
          padding: 16, 
          marginBottom: 16,
          borderWidth: 1,
          borderColor: colors.outline
        }}>
          <Text style={{ 
            fontSize: 18, 
            fontWeight: '600', 
            color: colors.onSurface,
            marginBottom: 12 
          }}>
            Options
          </Text>

          {/* Sample Selection */}
          {!useCustom && (
            <View style={{ marginBottom: 16 }}>
              <Text style={{ color: colors.onSurfaceVariant, marginBottom: 8 }}>
                Sample:
              </Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                {SAMPLES.map((sample, index) => (
                  <Pressable
                    key={index}
                    onPress={() => setSelectedSample(index)}
                    style={{
                      paddingHorizontal: 16,
                      paddingVertical: 8,
                      backgroundColor: selectedSample === index ? colors.primaryContainer : colors.surfaceVariant,
                      borderWidth: 1,
                      borderColor: selectedSample === index ? colors.primary : colors.outline,
                      marginRight: 8,
                    }}
                  >
                    <Text style={{ 
                      color: selectedSample === index ? colors.onPrimaryContainer : colors.onSurfaceVariant,
                      fontSize: 14,
                      fontWeight: selectedSample === index ? '600' : '400'
                    }}>
                      {sample.name}
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>
            </View>
          )}


          {/* Show Line Numbers */}
          <View style={{ flexDirection: 'row', marginBottom: 12, alignItems: 'center' }}>
            <Text style={{ color: colors.onSurfaceVariant, flex: 1 }}>
              Show Line Numbers:
            </Text>
            <Switch
              value={showLineNumbers}
              onValueChange={setShowLineNumbers}
              trackColor={{ false: colors.surfaceVariant, true: colors.primary }}
            />
          </View>

          {/* Wrap Lines */}
          <View style={{ flexDirection: 'row', marginBottom: 12, alignItems: 'center' }}>
            <Text style={{ color: colors.onSurfaceVariant, flex: 1 }}>
              Wrap Lines:
            </Text>
            <Switch
              value={wrapLines}
              onValueChange={setWrapLines}
              trackColor={{ false: colors.surfaceVariant, true: colors.primary }}
            />
          </View>

          {/* Font Scale */}
          <View style={{ flexDirection: 'row', marginBottom: 12, alignItems: 'center' }}>
            <Text style={{ color: colors.onSurfaceVariant, flex: 1 }}>
              Font Scale: {fontScaleX.toFixed(2)}x
            </Text>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              {[0.8, 0.9, 1.0, 1.1, 1.2].map((scale) => (
                <Pressable
                  key={scale}
                  onPress={() => setFontScaleX(scale)}
                  style={{
                    paddingHorizontal: 12,
                    paddingVertical: 6,
                    backgroundColor: fontScaleX === scale ? colors.primary : colors.surfaceVariant,
                    borderWidth: 1,
                    borderColor: fontScaleX === scale ? colors.primary : colors.outline,
                  }}
                >
                  <Text style={{ 
                    color: fontScaleX === scale ? colors.onPrimary : colors.onSurfaceVariant,
                    fontSize: 14
                  }}>
                    {scale}x
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>

          {/* Context Lines */}
          <View style={{ flexDirection: 'row', marginBottom: 12, alignItems: 'center' }}>
            <Text style={{ color: colors.onSurfaceVariant, flex: 1 }}>
              Context Lines: {contextLines}
            </Text>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              {[1, 3, 5, 10].map((value) => (
                <Pressable
                  key={value}
                  onPress={() => setContextLines(value)}
                  style={{
                    paddingHorizontal: 12,
                    paddingVertical: 6,
                    backgroundColor: contextLines === value ? colors.primary : colors.surfaceVariant,
                    borderWidth: 1,
                    borderColor: contextLines === value ? colors.primary : colors.outline,
                  }}
                >
                  <Text style={{ 
                    color: contextLines === value ? colors.onPrimary : colors.onSurfaceVariant,
                    fontSize: 14
                  }}>
                    {value}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>

          {/* Custom Input Toggle */}
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Text style={{ color: colors.onSurfaceVariant, flex: 1 }}>
              Use Custom Input:
            </Text>
            <Switch
              value={useCustom}
              onValueChange={setUseCustom}
              trackColor={{ false: colors.surfaceVariant, true: colors.primary }}
            />
          </View>
        </View>

        {/* Custom Input Fields */}
        {useCustom && (
          <View style={{ marginBottom: 16 }}>
            <View style={{ marginBottom: 12 }}>
              <Text style={{ 
                color: colors.onSurfaceVariant, 
                marginBottom: 4,
                fontSize: 14
              }}>
                Original Text:
              </Text>
              <TextInput
                value={customOld}
                onChangeText={setCustomOld}
                multiline
                numberOfLines={6}
                style={{
                  backgroundColor: colors.surfaceVariant,
                  padding: 12,
                  color: colors.onSurface,
                  fontFamily: 'monospace',
                  fontSize: 13,
                  minHeight: 120,
                  textAlignVertical: 'top',
                  borderWidth: 1,
                  borderColor: colors.outline
                }}
                placeholder="Enter original text..."
                placeholderTextColor={colors.onSurfaceVariant}
              />
            </View>

            <View>
              <Text style={{ 
                color: colors.onSurfaceVariant, 
                marginBottom: 4,
                fontSize: 14
              }}>
                Modified Text:
              </Text>
              <TextInput
                value={customNew}
                onChangeText={setCustomNew}
                multiline
                numberOfLines={6}
                style={{
                  backgroundColor: colors.surfaceVariant,
                  padding: 12,
                  color: colors.onSurface,
                  fontFamily: 'monospace',
                  fontSize: 13,
                  minHeight: 120,
                  textAlignVertical: 'top',
                  borderWidth: 1,
                  borderColor: colors.outline
                }}
                placeholder="Enter modified text..."
                placeholderTextColor={colors.onSurfaceVariant}
              />
            </View>
          </View>
        )}

          {/* Info */}
          <View style={{ 
            backgroundColor: colors.infoContainer, 
            padding: 16, 
            borderWidth: 1,
            borderColor: colors.info,
            marginBottom: 16
          }}>
            <Text style={{ 
              color: colors.info,
              fontSize: 16,
              fontWeight: '600',
              marginBottom: 8
            }}>
              About DiffView
            </Text>
            <Text style={{ color: colors.onSurface, lineHeight: 20 }}>
              This component uses the 'diff' library (jsdiff) to calculate differences between two texts. 
              It supports multiple diff types (lines, words, characters) and can display changes in either 
              unified or split view mode.
            </Text>
          </View>
        </View>
      </ScrollView>

      {/* Diff View - Full Height */}
      <View style={{ flex: 1, borderTopWidth: 1, borderTopColor: colors.outline }}>
        <View style={{ 
          backgroundColor: colors.surface,
          paddingHorizontal: 16,
          paddingVertical: 12,
          borderBottomWidth: 1,
          borderBottomColor: colors.outline
        }}>
          <Text style={{ 
            fontSize: 18, 
            fontWeight: '600', 
            color: colors.onBackground
          }}>
            Result
          </Text>
        </View>
        
        <DiffView
          oldText={oldText}
          newText={newText}
          showLineNumbers={showLineNumbers}
          contextLines={contextLines}
          oldTitle="Before"
          newTitle="After"
          style={{ flex: 1 }}
          wrapLines={wrapLines}
          fontScaleX={fontScaleX}
        />
      </View>
    </View>
  );
}