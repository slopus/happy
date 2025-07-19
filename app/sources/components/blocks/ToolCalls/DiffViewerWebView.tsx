import React from "react";
import { View, ScrollView, Text } from "react-native";
import {
  parseDiff,
  Diff,
  Hunk,
  IHunk,
} from "react-native-diff-view";

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
  leftTitle = "Original",
  rightTitle = "Updated",
  splitView = false,
  height = 300,
}) => {
  console.log("!!!!got old value", oldValue);
  console.log("!!!!got new value", newValue);
  
  // Add safety checks for props
  if (oldValue === undefined || newValue === undefined) {
    console.error("oldValue or newValue is undefined!");
    return (
      <View>
        <Text>Error: Missing diff values</Text>
      </View>
    );
  }

  // Create a unified diff format that react-native-diff-view can parse
  const createUnifiedDiff = (
    oldText: string,
    newText: string,
    filename: string = "file.txt"
  ) => {
    // Handle empty oldText properly
    const oldLines = oldText.trim() === "" ? [] : oldText.split("\n");
    const newLines = newText.trim() === "" ? [] : newText.split("\n");

    // Create a proper diff with correct line numbers and all required properties
    let diffText = `--- a/${filename}\n+++ b/${filename}\n`;

    const maxLines = Math.max(oldLines.length, newLines.length);
    let hunkStart = oldLines.length === 0 ? 0 : 1;

    diffText += `@@ -${hunkStart},${oldLines.length} +1,${newLines.length} @@\n`;

    // Handle the case where oldText is empty (new file)
    if (oldLines.length === 0) {
      // All lines are additions
      for (let i = 0; i < newLines.length; i++) {
        diffText += `+${newLines[i]}\n`;
      }
    } else if (newLines.length === 0) {
      // All lines are deletions
      for (let i = 0; i < oldLines.length; i++) {
        diffText += `-${oldLines[i]}\n`;
      }
    } else {
      // Simple line-by-line comparison
      for (let i = 0; i < maxLines; i++) {
        const oldLine = oldLines[i] || "";
        const newLine = newLines[i] || "";

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
    }

    return diffText;
  };

  // Post-process the parsed diff to add missing properties that react-native-diff-view expects
  const enhanceParsedDiff = (files: any[]) => {
    return files.map(file => {
      const enhancedHunks = file.hunks.map((hunk: any) => {
        const enhancedChanges = hunk.changes.map((change: any, index: number) => {
          const enhanced = { ...change };
          
          // Set missing boolean properties
          enhanced.isNormal = change.type === 'normal';
          enhanced.isInsert = change.type === 'insert';
          enhanced.isDelete = change.type === 'delete';
          
          // Set proper line numbers based on change type
          if (change.type === 'delete') {
            enhanced.oldLineNumber = change.lineNumber;
            enhanced.newLineNumber = undefined;
          } else if (change.type === 'insert') {
            enhanced.oldLineNumber = undefined;
            enhanced.newLineNumber = change.lineNumber;
          } else if (change.type === 'normal') {
            enhanced.oldLineNumber = change.lineNumber;
            enhanced.newLineNumber = change.lineNumber;
          }
          
          console.log(`!!!!Enhanced change[${index}]:`, enhanced);
          return enhanced;
        });
        
        return {
          ...hunk,
          changes: enhancedChanges
        };
      });
      
      return {
        ...file,
        hunks: enhancedHunks
      };
    });
  };

  try {
    const diffText = createUnifiedDiff(oldValue, newValue);
    console.log("!!!!got diff text", diffText);
    
    const files = parseDiff(diffText);
    console.log("!!!!got files", files);
    
    // CRITICAL: Enhance the parsed diff with missing properties
    const enhancedFiles = enhanceParsedDiff(files);
    console.log("!!!!got enhanced files", enhancedFiles);
    
    if (!enhancedFiles || enhancedFiles.length === 0) {
      return (
        <View>
          <Text>No diff to display</Text>
        </View>
      );
    }

    const file = enhancedFiles[0];
    console.log("!!!!enhanced file type:", file.type);
    console.log("!!!!enhanced file hunks:", file.hunks);
    
    if (!file.hunks || file.hunks.length === 0) {
      return (
        <View>
          <Text>No changes to display</Text>
        </View>
      );
    }

    // DEBUG: Let's examine the enhanced hunk structure in detail
    const hunk = file.hunks[0];
    console.log("!!!!DEBUG ENHANCED hunk structure:");
    console.log("- hunk:", hunk);
    console.log("- hunk.content:", hunk.content);
    console.log("- hunk.changes:", hunk.changes);
    console.log("- hunk.oldStart:", hunk.oldStart);
    console.log("- hunk.oldLines:", hunk.oldLines);
    console.log("- hunk.newStart:", hunk.newStart);
    console.log("- hunk.newLines:", hunk.newLines);
    
    if (hunk.changes) {
      hunk.changes.forEach((change: any, i: number) => {
        console.log(`!!!!DEBUG ENHANCED change[${i}]:`, change);
        console.log(`- change.type:`, change.type);
        console.log(`- change.content:`, change.content);
        console.log(`- change.lineNumber:`, change.lineNumber);
        console.log(`- change.oldLineNumber:`, change.oldLineNumber);
        console.log(`- change.newLineNumber:`, change.newLineNumber);
        console.log(`- change.isNormal:`, change.isNormal);
        console.log(`- change.isInsert:`, change.isInsert);
        console.log(`- change.isDelete:`, change.isDelete);
      });
    }

    // Try to use the original Hunk component with enhanced data
    return (
      <View>
        <Text style={{ fontSize: 12, color: 'gray', marginBottom: 10 }}>
          DEBUG: Trying original Hunk component with ENHANCED data
        </Text>
        
        {/* First show our working custom renderer */}
        <View style={{ backgroundColor: '#f0f0f0', padding: 10, marginBottom: 10 }}>
          <Text style={{ fontSize: 12, fontWeight: 'bold' }}>Custom Renderer (Working):</Text>
          {file.hunks.map((hunk: IHunk, index: number) => (
            <View key={`custom-${index}`} style={{ backgroundColor: '#f5f5f5', marginBottom: 5, padding: 5 }}>
              <Text style={{ fontSize: 11, color: 'blue' }}>
                {hunk.content || `Hunk ${index + 1}`}
              </Text>
              {hunk.changes && hunk.changes.map((change: any, changeIndex: number) => (
                <Text 
                  key={`custom-change-${index}-${changeIndex}`}
                  style={{ 
                    fontSize: 12, 
                    fontFamily: 'monospace',
                    backgroundColor: change.type === 'insert' ? '#e6ffed' : 
                                   change.type === 'delete' ? '#ffeef0' : 'transparent',
                  }}
                >
                  {change.content || ''}
                </Text>
              ))}
            </View>
          ))}
        </View>

        {/* Now try the original library components with ENHANCED data */}
        <View style={{ backgroundColor: '#ffe6e6', padding: 10 }}>
          <Text style={{ fontSize: 12, fontWeight: 'bold', color: 'red' }}>
            Original Library Components (Testing with Enhanced Data):
          </Text>
          <Diff diffType={file.type} hunks={file.hunks}>
            {(hunks: IHunk[]) => {
              console.log("!!!!Diff children function called with ENHANCED hunks:", hunks);
              return hunks.map((hunk: IHunk, index: number) => {
                console.log(`!!!!About to render Hunk component for ENHANCED hunk ${index}:`, hunk);
                try {
                  return (
                    <View key={`original-${index}`} style={{ marginBottom: 5 }}>
                      <Text style={{ fontSize: 10, color: 'purple' }}>
                        Before Hunk Component (Enhanced Data)
                      </Text>
                      <Hunk hunk={hunk} />
                      <Text style={{ fontSize: 10, color: 'green' }}>
                        🎉 After Hunk Component (SUCCESS!)
                      </Text>
                    </View>
                  );
                } catch (hunkError) {
                  console.error("!!!!Error rendering ENHANCED Hunk:", hunkError);
                  console.error("!!!!Enhanced Hunk that caused error:", hunk);
                  return (
                    <View key={`error-${index}`} style={{ backgroundColor: '#ffcccc', padding: 5 }}>
                      <Text style={{ fontSize: 12, color: 'red' }}>
                        Enhanced Hunk Error: {String(hunkError)}
                      </Text>
                      <Text style={{ fontSize: 10 }}>
                        Enhanced Hunk data: {JSON.stringify(hunk, null, 2)}
                      </Text>
                    </View>
                  );
                }
              });
            }}
          </Diff>
        </View>
      </View>
    );

  } catch (error) {
    console.error("Error in DiffViewerWebView:", error);
    return (
      <View>
        <Text style={{ color: 'red' }}>Error rendering diff: {String(error)}</Text>
        <Text style={{ fontSize: 12, marginTop: 10 }}>
          Old: {JSON.stringify(oldValue)}
        </Text>
        <Text style={{ fontSize: 12, marginTop: 5 }}>
          New: {JSON.stringify(newValue)}
        </Text>
      </View>
    );
  }
};
