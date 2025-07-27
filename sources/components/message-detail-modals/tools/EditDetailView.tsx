import React, { useState } from "react";
import { View, ScrollView, Text, Pressable } from "react-native";
import { Stack } from "expo-router";
import { z } from "zod";
import { type ToolCallMessage } from "@/sync/typesMessage";
import { DiffView } from '@/components/files/DiffView';
import { Metadata } from "@/sync/storageTypes";
import { getRelativePath } from "@/hooks/useGetPath";
import { ToolIcon } from "@/components/blocks/tools/design-tokens/ToolIcon";
import tw from 'twrnc';

// Zod schema for Edit tool arguments
const EditArgumentsSchema = z.object({
  file_path: z.string(),
  old_string: z.string(),
  new_string: z.string(),
  replace_all: z.boolean().optional(),
});

type EditArguments = z.infer<typeof EditArgumentsSchema>;

// Sliding toggle component for Unified/Split view
const ViewModeToggle: React.FC<{
  value: 'unified' | 'split';
  onChange: (value: 'unified' | 'split') => void;
}> = ({ value, onChange }) => {
  return (
    <View style={[tw`relative flex-row bg-gray-100 rounded-lg p-0.5`, { width: 140 }]}>
      {/* Sliding white background */}
      <View style={tw.style(
        'absolute top-0.5 rounded-md bg-white shadow-sm',
        // Dynamic positioning and size
        { 
          left: value === 'unified' ? 2 : 72, // 140/2 + 2 = 72
          width: 66, // (140-4)/2 = 68, but adjust for better fit
          height: 28
        }
      )} />
      
      <Pressable
        onPress={() => onChange('unified')}
        style={tw`flex-1 py-1.5 px-3 rounded-md z-10`}
      >
        <Text style={tw.style(
          'text-center text-xs font-medium',
          value === 'unified' ? 'text-gray-900' : 'text-gray-500'
        )}>
          Unified
        </Text>
      </Pressable>
      
      <Pressable
        onPress={() => onChange('split')}
        style={tw`flex-1 py-1.5 px-3 rounded-md z-10`}
      >
        <Text style={tw.style(
          'text-center text-xs font-medium',
          value === 'split' ? 'text-gray-900' : 'text-gray-500'
        )}>
          Split
        </Text>
      </Pressable>
    </View>
  );
};

// Helper functions
const getStatusDisplay = (state: string) => {
  switch (state) {
    case "running":
      return "Running";
    case "completed":
      return "Completed";
    case "error":
      return "Error";
    default:
      return state;
  }
};

const getStatusColorClass = (state: string) => {
  switch (state) {
    case "running":
      return "text-amber-500";
    case "completed":
      return "text-green-600";
    case "error":
      return "text-red-600";
    default:
      return "text-gray-500";
  }
};

interface EditDetailViewProps {
  message: ToolCallMessage;
  metadata: Metadata | null;
}

export function EditDetailView({ message, metadata }: EditDetailViewProps) {
  const [viewMode, setViewMode] = useState<'unified' | 'split'>('unified');
  const [wrapLines, setWrapLines] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  // Get the tool (should be the edit tool)
  const tool = message.tool;
  
  // Parse the tool arguments
  const parseResult = EditArgumentsSchema.safeParse(tool.input);
  
  if (!parseResult.success) {
    return (
      <View style={tw`flex-1 bg-white`}>
        <Stack.Screen options={{ title: "Edit File" }} />
        <View style={tw`p-4`}>
          <Text style={tw`text-lg font-semibold text-gray-900`}>File Edit</Text>
          <Text style={tw`text-red-600 text-sm italic`}>Invalid tool arguments</Text>
        </View>
      </View>
    );
  }

  const {
    file_path: filePath,
    old_string: oldString,
    new_string: newString,
    replace_all: replaceAll,
  } = parseResult.data;

  if (!filePath) {
    return (
      <View style={tw`flex-1 bg-white`}>
        <Stack.Screen options={{ title: "Edit File" }} />
        <View style={tw`p-4`}>
          <Text style={tw`text-lg font-semibold text-gray-900`}>File Edit</Text>
          <Text style={tw`text-red-600 text-sm italic`}>No file specified</Text>
        </View>
      </View>
    );
  }

  // Get relative path for display
  const displayPath = getRelativePath(metadata || null, filePath);

  return (
    <View style={tw`flex-1 bg-white`}>
      <Stack.Screen options={{ title: displayPath }} />
      
      {/* Minimal Header */}
      <View style={tw`px-4 pt-4 pb-3 border-b border-gray-200 bg-white`}>
        <View style={tw`flex-row items-center gap-2 mb-2`}>
          <ToolIcon name="pencil" state={tool.state} />
          <View style={tw`flex-1`}>
            <Text style={tw`text-lg font-semibold text-gray-900 font-mono`}>
              {displayPath}
            </Text>
            <Text style={tw`text-xs text-gray-500 mt-0.5`}>
              Edit File
            </Text>
          </View>
          <View style={tw`px-2 py-1 bg-gray-100 rounded-full`}>
            <Text style={tw.style(
              'text-xs font-medium',
              getStatusColorClass(tool.state)
            )}>
              {getStatusDisplay(tool.state)}
            </Text>
          </View>
        </View>

        {/* Replace All Mode */}
        {replaceAll && (
          <View style={tw`bg-amber-50 border border-amber-200 rounded-lg p-3`}>
            <Text style={tw`text-xs font-medium text-amber-800`}>
              🔄 Replace All Mode - All occurrences will be replaced
            </Text>
          </View>
        )}
      </View>

      {/* Full-width Diff View */}
      <View style={tw`flex-1`}>
        <DiffView
          oldText={oldString || ""}
          newText={newString || ""}
          oldTitle="Before"
          newTitle="After"
          showLineNumbers={true}
          showDiffStats={true}
          contextLines={3}
          wrapLines={wrapLines}
          style={tw`flex-1`}
        />
      </View>

      {/* Enhanced iOS-style Bottom Toolbar */}
      <View style={tw`bg-white border-t border-gray-200 shadow-lg`}>
        {/* Main toolbar row */}
        <View style={tw`flex-row items-center justify-between px-4 py-3`}>
          {/* Left section - View Mode Toggle */}
          <ViewModeToggle value={viewMode} onChange={setViewMode} />

          {/* Right section - More options */}
          <Pressable
            onPress={() => setShowSettings(true)}
            style={tw`px-4 py-2 bg-gray-100 rounded-lg`}
          >
            <Text style={tw`text-sm font-medium text-gray-700`}>
              More
            </Text>
          </Pressable>
        </View>

        {/* Optional: Secondary toolbar row for additional controls */}
        {showSettings && (
          <View style={tw`flex-row items-center justify-around px-4 pb-3 border-t border-gray-100`}>
            <Pressable style={tw`items-center p-2`}>
              <Text style={tw`text-xs text-gray-500`}>Copy</Text>
            </Pressable>
            <Pressable style={tw`items-center p-2`}>
              <Text style={tw`text-xs text-gray-500`}>Share</Text>
            </Pressable>
            <Pressable style={tw`items-center p-2`}>
              <Text style={tw`text-xs text-gray-500`}>Export</Text>
            </Pressable>
          </View>
        )}
      </View>
    </View>
  );
} 