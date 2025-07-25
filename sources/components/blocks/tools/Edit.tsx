import React from "react";
import { View, Text } from "react-native";
import { MonoText } from "./design-tokens/MonoText";
import { ToolCall } from "@/sync/typesMessage";
import { z } from "zod";
import { SingleLineToolSummaryBlock } from "../SingleLineToolSummaryBlock";
import { TOOL_COMPACT_VIEW_STYLES, TOOL_CONTAINER_STYLES } from "./constants";
import { Metadata } from "@/sync/storageTypes";
import { getRelativePath } from "@/hooks/useGetPath";
import { ToolIcon } from "./design-tokens/ToolIcon";
import { ShimmerToolName } from "./design-tokens/ShimmerToolName";
import { ToolName } from "./design-tokens/ToolName";

export type EditToolCall = Omit<ToolCall, "name"> & { name: "Edit" };

// Zod schema for Edit tool arguments
const EditArgumentsSchema = z.object({
  file_path: z.string(),
  old_string: z.string(),
  new_string: z.string(),
  replace_all: z.boolean().optional(),
});

type EditArguments = z.infer<typeof EditArgumentsSchema>;



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




