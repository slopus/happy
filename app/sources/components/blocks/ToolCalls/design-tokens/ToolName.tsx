import { Text } from "../../../StyledText";
import { TOOL_COMPACT_VIEW_STYLES } from "../constants";

export function ToolName({ children }: { children: string; }) {
  return <Text className={TOOL_COMPACT_VIEW_STYLES.TOOL_NAME_CLASSES}>{children}</Text>;
}