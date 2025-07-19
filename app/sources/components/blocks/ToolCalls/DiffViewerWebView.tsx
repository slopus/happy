import React from 'react';
import { View, Text, ScrollView } from 'react-native';
import { parseDiff, Diff, Hunk } from 'react-native-diff-view';

interface DiffViewerWebViewProps {
  oldValue: string;
  newValue: string;
  leftTitle?: string;
  rightTitle?: string;
  splitView?: boolean;
  height?: number;
}

export const DiffViewerWebView: React.FC<DiffViewerWebViewProps> = ({
  oldValue,
  newValue,
  leftTitle = 'Original',
  rightTitle = 'Updated',
  splitView = false,
  height = 300,
}) => {
  // Create a unified diff format that react-native-diff-view can parse
  const createUnifiedDiff = (oldText: string, newText: string, filename: string = 'file.txt') => {
    const oldLines = oldText.split('\n');
    const newLines = newText.split('\n');
    
    // Simple diff creation - this is a basic implementation
    // In a real app, you might want to use a proper diff algorithm
    let diffText = `--- a/${filename}\n+++ b/${filename}\n`;
    
    const maxLines = Math.max(oldLines.length, newLines.length);
    let hunkStart = 1;
    let hunkSize = maxLines;
    
    diffText += `@@ -${hunkStart},${oldLines.length} +${hunkStart},${newLines.length} @@\n`;
    
    // Simple line-by-line comparison
    for (let i = 0; i < maxLines; i++) {
      const oldLine = oldLines[i] || '';
      const newLine = newLines[i] || '';
      
      if (i < oldLines.length && i < newLines.length) {
        if (oldLine === newLine) {
          diffText += ` ${oldLine}\n`;
        } else {
          diffText += `-${oldLine}\n`;
          diffText += `+${newLine}\n`;
        }
      } else if (i < oldLines.length) {
        diffText += `-${oldLine}\n`;
      } else if (i < newLines.length) {
        diffText += `+${newLine}\n`;
      }
    }
    
    return diffText;
  };

  try {
    const diffText = createUnifiedDiff(oldValue, newValue);
    const files = parseDiff(diffText);
    
    const renderFile = (file: any, index: number) => {
      const { hunks, type } = file;
      
      return (
        <View key={index} style={{ flex: 1 }}>
          {/* Header with titles */}
          {(leftTitle || rightTitle) && (
            <View style={{
              flexDirection: 'row',
              backgroundColor: '#f8f9fa',
              borderBottomWidth: 1,
              borderBottomColor: '#e9ecef',
              paddingVertical: 8,
              paddingHorizontal: 12,
            }}>
              {splitView ? (
                <>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 12, fontWeight: '600', color: '#495057' }}>
                      {leftTitle}
                    </Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 12, fontWeight: '600', color: '#495057' }}>
                      {rightTitle}
                    </Text>
                  </View>
                </>
              ) : (
                <Text style={{ fontSize: 12, fontWeight: '600', color: '#495057' }}>
                  {leftTitle} → {rightTitle}
                </Text>
              )}
            </View>
          )}
          
          <ScrollView
            horizontal={true}
            bounces={false}
            showsHorizontalScrollIndicator={false}
            style={{ flex: 1 }}
          >
            <Diff
              diffType={type}
              hunks={hunks}
              style={{
                backgroundColor: '#ffffff',
                minWidth: '100%',
              }}
              lineStyle={{
                paddingVertical: 2,
                paddingHorizontal: 4,
              }}
              gutterStyle={{
                backgroundColor: '#f8f9fa',
                borderRightWidth: 1,
                borderRightColor: '#e9ecef',
                paddingHorizontal: 8,
                minWidth: 40,
              }}
                             contentStyle={{
                 paddingHorizontal: 8,
               }}
            >
              {(hunks: any[]) => hunks.map((hunk: any) => (
                <Hunk key={hunk.content} hunk={hunk} />
              ))}
            </Diff>
          </ScrollView>
        </View>
      );
    };

    return (
      <View style={{ height, borderWidth: 1, borderColor: '#e9ecef', borderRadius: 6, backgroundColor: '#ffffff' }}>
        {files.length > 0 ? (
          files.map(renderFile)
        ) : (
          <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20 }}>
            <Text style={{ color: '#6c757d', fontSize: 14 }}>No differences found</Text>
          </View>
        )}
      </View>
    );
  } catch (error) {
    console.error('Error parsing diff:', error);
    
    // Fallback to simple side-by-side text display
    return (
      <View style={{ height, borderWidth: 1, borderColor: '#e9ecef', borderRadius: 6, backgroundColor: '#ffffff' }}>
        {/* Header */}
        {(leftTitle || rightTitle) && (
          <View style={{
            flexDirection: 'row',
            backgroundColor: '#f8f9fa',
            borderBottomWidth: 1,
            borderBottomColor: '#e9ecef',
            paddingVertical: 8,
            paddingHorizontal: 12,
          }}>
            {splitView ? (
              <>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 12, fontWeight: '600', color: '#495057' }}>
                    {leftTitle}
                  </Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 12, fontWeight: '600', color: '#495057' }}>
                    {rightTitle}
                  </Text>
                </View>
              </>
            ) : (
              <Text style={{ fontSize: 12, fontWeight: '600', color: '#495057' }}>
                {leftTitle} → {rightTitle}
              </Text>
            )}
          </View>
        )}
        
        <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false}>
          {splitView ? (
            <View style={{ flexDirection: 'row', flex: 1 }}>
              <View style={{ flex: 1, borderRightWidth: 1, borderRightColor: '#e9ecef' }}>
                <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                  <Text style={{
                    fontFamily: 'Courier New',
                    fontSize: 12,
                    lineHeight: 16,
                    padding: 8,
                    color: '#212529',
                  }}>
                    {oldValue}
                  </Text>
                </ScrollView>
              </View>
              <View style={{ flex: 1 }}>
                <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                  <Text style={{
                    fontFamily: 'Courier New',
                    fontSize: 12,
                    lineHeight: 16,
                    padding: 8,
                    color: '#212529',
                  }}>
                    {newValue}
                  </Text>
                </ScrollView>
              </View>
            </View>
          ) : (
            <View style={{ padding: 8 }}>
              <Text style={{
                fontFamily: 'Courier New',
                fontSize: 12,
                lineHeight: 16,
                color: '#212529',
              }}>
                {newValue}
              </Text>
            </View>
          )}
        </ScrollView>
      </View>
    );
  }
}; 