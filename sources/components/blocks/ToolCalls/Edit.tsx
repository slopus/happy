import React, { useMemo, useState, useRef } from "react";
import { View, ScrollView, Text, Pressable } from "react-native";
import { MonoText } from "./design-tokens/MonoText";
import { ToolCall } from "@/sync/typesMessage";
import { z } from "zod";
import { SingleLineToolSummaryBlock } from "../SingleLineToolSummaryBlock";
import { DiffView } from '@/components/files/DiffView';
import { TOOL_COMPACT_VIEW_STYLES, TOOL_CONTAINER_STYLES } from "./constants";
import { Metadata } from "@/sync/storageTypes";
import { getRelativePath } from "@/hooks/useGetPath";
import { ToolIcon } from "./design-tokens/ToolIcon";
import { ShimmerToolName } from "./design-tokens/ShimmerToolName";
import { ToolName } from "./design-tokens/ToolName";
import { Toggle } from "@/components/Toggle";
import { Dropdown, DropdownOption } from "@/components/Dropdown";
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import tw from 'twrnc';

export type EditToolCall = Omit<ToolCall, "name"> & { name: "Edit" };

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

export function EditCompactView({
  tool,
  sessionId,
  messageId,
  metadata,
}: {
  tool: ToolCall;
  sessionId: string;
  messageId: string;
  metadata: Metadata | null;
}) {
  return (
    <SingleLineToolSummaryBlock sessionId={sessionId} messageId={messageId}>
      <EditCompactViewInner tool={tool} metadata={metadata} />
    </SingleLineToolSummaryBlock>
  );
}

// Compact view for display in session list (1-2 lines max)
export function EditCompactViewInner({
  tool,
  metadata,
}: {
  tool: ToolCall;
  metadata: Metadata | null;
}) {
  const parseResult = EditArgumentsSchema.safeParse(tool.input);

  // If we can't parse the arguments at all, we can explain that we can't show
  // any more information
  if (!parseResult.success) {
    return (
      <View className={TOOL_CONTAINER_STYLES.BASE_CONTAINER}>
        <ToolIcon name="pencil-outline" state={tool.state} />
        {tool.state === "running" && <ShimmerToolName>Editing</ShimmerToolName>}
        <ToolName>{tool.state}</ToolName>
        <MonoText
          className={TOOL_COMPACT_VIEW_STYLES.CONTENT_CLASSES}
          numberOfLines={1}
        >
          Invalid arguments
        </MonoText>
      </View>
    );
  }

  const args: EditArguments = parseResult.data;

  // Get relative path or filename
  const displayPath = getRelativePath(metadata, args.file_path);

  return (
    <View className={TOOL_CONTAINER_STYLES.BASE_CONTAINER}>
      <ToolIcon name="pencil" state={tool.state} />
      {tool.state === "running" && <ShimmerToolName>Editing</ShimmerToolName>}
      {tool.state !== "running" && <ToolName>Edit</ToolName>}
      <MonoText
        className={TOOL_COMPACT_VIEW_STYLES.CONTENT_CLASSES}
        numberOfLines={1}
      >
        {displayPath}
      </MonoText>
    </View>
  );
}

// Detailed view for full-screen modal
export const EditDetailedView = ({
  tool,
  metadata,
}: {
  tool: EditToolCall;
  metadata: Metadata | null;
}) => {
  const [viewMode, setViewMode] = useState<'unified' | 'split'>('unified');
  const [wrapLines, setWrapLines] = useState(false);
  const [showLineNumbers, setShowLineNumbers] = useState(true);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const gearButtonRef = useRef<View>(null);
  const insets = useSafeAreaInsets();

  const {
    file_path: filePath,
    old_string: oldString,
    new_string: newString,
    replace_all: replaceAll,
  } = tool.input;

  if (!filePath) {
    return (
      <View style={tw`flex-1 bg-white`}>
        <View style={tw`p-4`}>
          <Text style={tw`text-lg font-semibold text-gray-900`}>File Edit</Text>
          <Text style={tw`text-red-600 text-sm italic`}>No file specified</Text>
        </View>
      </View>
    );
  }

  // Get relative path for display
  const displayPath = getRelativePath(metadata || null, filePath);

  const dropdownOptions: DropdownOption[] = [
    {
      label: 'Unified Diff',
      value: 'unified-diff',
      icon: viewMode === 'unified' ? 
        <Ionicons name="checkmark" size={20} color="#34C759" /> : 
        <View style={{ width: 20 }} />
    },
    {
      label: 'Split Diff',
      value: 'split-diff',
      icon: viewMode === 'split' ? 
        <Ionicons name="checkmark" size={20} color="#34C759" /> : 
        <View style={{ width: 20 }} />
    },
    {
      label: 'Wrap Lines',
      value: 'wrap-lines',
      icon: wrapLines ? 
        <Ionicons name="checkmark" size={20} color="#34C759" /> : 
        <View style={{ width: 20 }} />
    },
    {
      label: 'Show Line Numbers',
      value: 'show-line-numbers',
      icon: showLineNumbers ? 
        <Ionicons name="checkmark" size={20} color="#34C759" /> : 
        <View style={{ width: 20 }} />
    },
  ];

  const handleDropdownSelect = (value: string) => {
    switch (value) {
      case 'unified-diff':
        setViewMode('unified');
        break;
      case 'split-diff':
        setViewMode('split');
        break;
      case 'wrap-lines':
        setWrapLines(!wrapLines);
        break;
      case 'show-line-numbers':
        setShowLineNumbers(!showLineNumbers);
        break;
    }
  };

  return (
    <View style={tw`flex-1 bg-white`}>
      {/* Header with Custom Gear Button */}
      <View style={tw`px-4 pt-4 pb-3 border-b border-gray-200 bg-white`}>
        <View style={tw`flex-row items-center gap-2 mb-2`}>
          <View style={tw`flex-1`}>
            <Text style={tw`text-xs text-gray-500 font-mono`}>
              {displayPath}
            </Text>
          </View>
          
          {/* Custom Gear Icon Button */}
          <Pressable
            ref={gearButtonRef}
            onPress={() => setIsDropdownOpen(true)}
            style={({ pressed }) => [
              tw`p-2 bg-white border border-gray-300 rounded-lg shadow-sm`,
              {'bg-blue-100' : pressed},
              { opacity: pressed ? 0.7 : 1 }
            ]}
          >
            <Ionicons name="settings-outline" size={20} color="#6B7280" />
          </Pressable>
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
      <DiffView
        oldText={oldString || ""}
        newText={newString || ""}
        oldTitle="Before"
        newTitle="After"
        showLineNumbers={showLineNumbers}
        showDiffStats={true}
        contextLines={3}
        wrapLines={wrapLines}
        bottomPadding={insets.bottom + 16}
        style={tw.style(`flex-1`)}
      />

      {/* External Dropdown */}
      <Dropdown
        options={dropdownOptions}
        onSelect={handleDropdownSelect}
        isOpen={isDropdownOpen}
        onClose={() => setIsDropdownOpen(false)}
        triggerRef={gearButtonRef}
      />
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

const getStatusColor = (state: string) => {
  switch (state) {
    case "running":
      return "#F59E0B";
    case "completed":
      return "#10B981";
    case "error":
      return "#EF4444";
    default:
      return "#6B7280";
  }
};

const getStatusDescription = (state: string) => {
  switch (state) {
    case "running":
      return "Edit is currently being applied...";
    case "completed":
      return "Edit applied successfully";
    case "error":
      return "Edit failed to apply";
    default:
      return `Status: ${state}`;
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
