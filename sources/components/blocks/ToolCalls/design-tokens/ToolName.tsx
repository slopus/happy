import { Text } from "../../../StyledText";

export function ToolName({ children, state }: { children: string; state?: 'running' | 'completed' | 'error' }) {
    if (state === "error") {
        <Text className={`text-[16px] text-red-500 font-bold px-1`}>{children}</Text>
    }
  return <Text className={"text-[16px] text-neutral-500 font-bold px-1"}>{children}</Text>;
}