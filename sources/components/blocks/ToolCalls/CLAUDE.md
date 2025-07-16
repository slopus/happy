# Tool Call Visualization Components

## Design

Components use narrowed types, not the generic `ToolCall`. A higher-order component switches on `tool.name` and renders the appropriate component. TypeScript automatically narrows the type, so each component gets a specific type like `type BashToolCall = Omit<ToolCall, 'name'> & { name: 'Bash' }` instead of the generic [`ToolCall`](file://./../../../sync/reducer.ts).

Each file defines its own narrowed type locally:
```typescript
type BashToolCall = Omit<ToolCall, 'name'> & { name: 'Bash' }
```

Each file exports exactly two components:

## CompactView
- Renders in chat list 
- **You only design content** - wrapper provides borders/touch handling
- **Width constraint**: Cannot assume full width (wrapper may add buttons)
- 1-2 lines max
- No padding/borders/backgrounds in your component

## DetailedView  
- Renders in full-screen modal
- **You design everything** - full UI control
- ~70% screen height, full width
- Use ScrollView for overflow

```typescript
export const ToolBashCompactView = ({ tool }: { tool: BashToolCall }) => {
  return <Text>{tool.arguments.command}</Text>
};

export const ToolBashDetailedView = ({ tool }: { tool: BashToolCall }) => {
  return (
    <ScrollView>
      <Text>Command: {tool.arguments.command}</Text>
      <Text>Output: {tool.result}</Text>
    </ScrollView>
  );
};
```