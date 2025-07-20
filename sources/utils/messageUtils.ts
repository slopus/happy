import { DecryptedMessage, MessageContent, ToolCall } from '@/sync/storageTypes';

/**
 * Extracts plain text from markdown by removing formatting
 */
function stripMarkdown(text: string): string {
  return text
    // Remove headers
    .replace(/^#{1,6}\s+/gm, '')
    // Remove bold and italic
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    // Remove inline code
    .replace(/`([^`]+)`/g, '$1')
    // Remove code blocks
    .replace(/```[\s\S]*?```/g, '[code]')
    // Remove links
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // Remove horizontal rules
    .replace(/^---+$/gm, '')
    // Remove list markers
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    // Clean up multiple whitespace
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Gets a readable summary of tool calls
 */
function getToolSummary(tools: ToolCall[]): string {
  if (tools.length === 0) return 'Used tools';
  
  if (tools.length === 1) {
    const tool = tools[0];
    const toolName = tool.name;
    
    // Try to extract meaningful info from common tools
    switch (toolName) {
      case 'Edit':
      case 'Write':
        const filePath = tool.arguments?.target_file || tool.arguments?.file_path;
        return filePath ? `Edited ${filePath}` : `Used ${toolName}`;
      
      case 'Read':
        const readPath = tool.arguments?.target_file || tool.arguments?.file_path;
        return readPath ? `Read ${readPath}` : 'Read file';
      
      case 'Bash':
      case 'RunCommand':
        const command = tool.arguments?.command;
        if (command && typeof command === 'string') {
          return `Ran: ${command.length > 20 ? command.substring(0, 20) + '...' : command}`;
        }
        return 'Ran command';
      
      default:
        return `Used ${toolName}`;
    }
  }
  
  // Multiple tools
  const toolNames = tools.map(t => t.name).slice(0, 3);
  if (tools.length <= 3) {
    return `Used ${toolNames.join(', ')}`;
  } else {
    return `Used ${toolNames.join(', ')} and ${tools.length - 3} more`;
  }
}

/**
 * Extracts text from Claude's complex message structure
 */
function extractClaudeTextContent(content: any): string | null {
  // Handle the complex nested structure of agent messages
  if (content && typeof content === 'object') {
    // Check if it's the outer agent content structure
    if (content.type === 'output' && content.data) {
      const data = content.data;
      
      // Check if it's an assistant message
      if (data.type === 'assistant' && data.message && data.message.content) {
        // Look for text content in the content array
        for (const item of data.message.content) {
          if (item.type === 'text' && item.text) {
            return item.text;
          }
        }
      }
    }
    
    // Check if it's a direct text content structure
    if (content.type === 'text' && content.text) {
      return content.text;
    }
  }
  
  return null;
}

/**
 * Extracts tool calls from Claude's message structure
 */
function extractClaudeToolCalls(content: any): any[] {
  if (content && typeof content === 'object') {
    // Check if it's the outer agent content structure
    if (content.type === 'output' && content.data) {
      const data = content.data;
      
      // Check if it's an assistant message with tool use
      if (data.type === 'assistant' && data.message && data.message.content) {
        const tools = [];
        for (const item of data.message.content) {
          if (item.type === 'tool_use') {
            tools.push({
              name: item.name,
              arguments: item.input || {},
              state: 'completed' // Assume completed for preview
            });
          }
        }
        return tools;
      }
    }
  }
  
  return [];
}

/**
 * Extracts a readable preview from message content
 */
export function getMessagePreview(message: DecryptedMessage | null, maxLength: number = 50): string {
  if (!message?.content) {
    return 'No content';
  }

  const content = message.content;

  // User messages
  if (content.role === 'user') {
    if (content.content && content.content.type === 'text') {
      const plainText = stripMarkdown(content.content.text);
      return plainText.length > maxLength
        ? plainText.substring(0, maxLength) + '...'
        : plainText;
    }
    return 'User message';
  }

  // Agent messages - handle the complex nested structure
  if (content.role === 'agent') {
    // First try to extract text content
    const textContent = extractClaudeTextContent(content.content);
    if (textContent) {
      const plainText = stripMarkdown(textContent);
      return plainText.length > maxLength
        ? plainText.substring(0, maxLength) + '...'
        : plainText;
    }
    
    // If no text, check for tool calls
    const toolCalls = extractClaudeToolCalls(content.content);
    if (toolCalls.length > 0) {
      return getToolSummary(toolCalls);
    }
    
    // Fallback for agent messages
    return 'Thinking...';
  }

  return 'Unknown message';
}

/**
 * Determines if a message is from the assistant/agent
 */
export function isMessageFromAssistant(message: DecryptedMessage | null): boolean {
  if (!message?.content) return false;
  return message.content.role === 'agent';
} 