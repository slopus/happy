import { type DecryptedMessage } from '@/sync/storageTypes';
import { type ToolCall } from '@/sync/typesMessage';
import { stringifyToolCommand } from './toolCommand';

/**
 * Extracts plain text from markdown by removing formatting
 */
export function stripMarkdown(text: string): string {
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
 * Splits plain text into read-aloud chunks of at most `maxLength` characters,
 * at sentence ends where possible, else between words. Each chunk is one RPC
 * round trip: short enough that Piper answers well inside the server's 30s RPC
 * timeout and the WAV stays far below its 8 MiB message cap (~300 chars ≈ 15s
 * of speech ≈ 1.3 MB on the wire), and playback can start after the first one.
 */
export function splitForReadAloud(text: string, maxLength = 300): string[] {
  // Only punctuation followed by whitespace ends a sentence, so "3.14" stays whole.
  const pieces = text.replace(/([.!?])\s+/g, '$1\n').split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .flatMap((s) => s.length > maxLength ? s.split(' ') : [s]);
  const chunks: string[] = [];
  for (const piece of pieces) {
    const last = chunks[chunks.length - 1];
    if (last !== undefined && last.length + 1 + piece.length <= maxLength) {
      chunks[chunks.length - 1] = `${last} ${piece}`;
    } else {
      chunks.push(piece);
    }
  }
  return chunks;
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
        const filePath = tool.input?.target_file || tool.input?.file_path;
        return filePath ? `Edited ${filePath}` : `Used ${toolName}`;
      
      case 'Read':
        const readPath = tool.input?.target_file || tool.input?.file_path;
        return readPath ? `Read ${readPath}` : 'Read file';
      
      case 'Bash':
      case 'RunCommand':
      case 'CodexBash':
      case 'GeminiBash':
        const command = stringifyToolCommand(tool.input?.command);
        if (command) {
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
    // Format 1: Direct text content structure
    if (content.type === 'text' && typeof content.data === 'string') {
      return content.data;
    }
    
    // Format 2: Simple text structure (alternative direct format)
    if (content.type === 'text' && typeof content.text === 'string') {
      return content.text;
    }
    
    // Format 3: String content directly
    if (typeof content === 'string') {
      return content;
    }
    
    // Format 4: Complex nested structure (output type)
    if (content.type === 'output' && content.data) {
      const data = content.data;
      
      // Handle summary messages - should not reach here anymore due to SessionsList filtering
      if (data.type === 'summary' && data.summary) {
        return 'Summary message (should be filtered)';
      }
      
      // Check if it's an assistant message
      if (data.type === 'assistant' && data.message && data.message.content) {
        // Look for text content in the content array
        for (const item of data.message.content) {
          if (item.type === 'text' && item.text) {
            return item.text;
          }
        }
      }
      
      // Handle other data types that might contain text
      if (data.type === 'user' && data.message && data.message.content) {
        // User messages might also have text
        if (typeof data.message.content === 'string') {
          return data.message.content;
        }
        if (Array.isArray(data.message.content)) {
          for (const item of data.message.content) {
            if (typeof item === 'string') {
              return item;
            }
            if (item.type === 'text' && item.text) {
              return item.text;
            }
          }
        }
      }
    }
    
    // Format 5: Alternative structure patterns - try common text fields
    const possibleTextFields = ['text', 'content', 'message', 'body'];
    for (const field of possibleTextFields) {
      if (content[field] && typeof content[field] === 'string') {
        return content[field];
      }
    }
    
    // Format 6: Nested content field
    if (content.content && typeof content.content === 'string') {
      return content.content;
    }
    
    // Format 7: Check if data field contains string directly
    if (content.data && typeof content.data === 'string') {
      return content.data;
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

  // Agent messages - handle BOTH raw and processed formats
  if (content.role === 'agent') {
    // FIRST: Check if this is the processed Message format (simple structure)
    // This handles: {role: 'agent', content: {type: 'text', text: '...'}}
    if (content.content && typeof content.content === 'object') {
      if (content.content.type === 'text' && content.content.text) {
        const plainText = stripMarkdown(content.content.text);
        return plainText.length > maxLength
          ? plainText.substring(0, maxLength) + '...'
          : plainText;
      }
      
      if (content.content.type === 'tool' && content.content.tools) {
        return getToolSummary(content.content.tools);
      }
    }
    
    // SECOND: Try the complex DecryptedMessage format (nested structure)
    const textContent = extractClaudeTextContent(content.content);
    if (textContent) {
      const plainText = stripMarkdown(textContent);
      return plainText.length > maxLength
        ? plainText.substring(0, maxLength) + '...'
        : plainText;
    }
    
    // THIRD: Check for tool calls in DecryptedMessage format
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
