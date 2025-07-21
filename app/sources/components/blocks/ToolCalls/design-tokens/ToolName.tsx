import { Text } from "../../../StyledText";

export function ToolName({ children }: { children: string; }) {
  return <Text className={"text-[16px] text-neutral-500 font-bold px-1"}>{children}</Text>;
}