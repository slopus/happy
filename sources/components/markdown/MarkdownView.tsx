import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { Link } from 'expo-router';
import { useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import * as React from 'react';
import { ScrollView, View, Platform, Pressable } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { SimpleSyntaxHighlighter } from '../SimpleSyntaxHighlighter';
import { Text } from '../StyledText';

import { MarkdownSpan, parseMarkdown } from './parseMarkdown';

import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { storeTempText } from '@/sync/persistence';
import { useLocalSetting } from '@/sync/storage';


// Option type for callback
export type Option = {
    title: string;
};

export const MarkdownView = React.memo((props: {
    markdown: string;
    onOptionPress?: (option: Option) => void;
}) => {
  const blocks = React.useMemo(() => {
    try {
      return parseMarkdown(props.markdown);
    } catch (error) {
      console.error('Error parsing markdown:', error);
      // Return a fallback simple text block
      return [{
        type: 'text' as const,
        content: [{ styles: [], text: props.markdown, url: null }],
      }];
    }
  }, [props.markdown]);
    
  // Backwards compatibility: The original version just returned the view, wrapping the list of blocks.
  // It made each of the individual text elements selectable. When we enable the markdownCopyV2 feature,
  // we disable the selectable property on individual text segments on mobile only. Instead, the long press
  // will be handled by a wrapper Pressable. If we don't disable the selectable property, then you will see
  // the native copy modal come up at the same time as the long press handler is fired.
  const markdownCopyV2 = useLocalSetting('markdownCopyV2');
  const selectable = Platform.OS === 'web' || !markdownCopyV2;
  const router = useRouter();

  const handleLongPress = React.useCallback(() => {
    try {
      const textId = storeTempText(props.markdown);
      router.push(`/text-selection?textId=${textId}`);
    } catch (error) {
      console.error('Error storing text for selection:', error);
      Modal.alert('Error', 'Failed to open text selection. Please try again.');
    }
  }, [props.markdown, router]);
  const renderContent = () => {
    return (
      <View>
        {blocks.map((block, index) => {
          if (block.type === 'text') {
            return <RenderTextBlock spans={block.content} key={index} first={index === 0} last={index === blocks.length - 1} selectable={selectable} />;
          } else if (block.type === 'header') {
            return <RenderHeaderBlock level={block.level} spans={block.content} key={index} first={index === 0} last={index === blocks.length - 1} selectable={selectable} />;
          } else if (block.type === 'horizontal-rule') {
            return <View style={style.horizontalRule} key={index} />;
          } else if (block.type === 'list') {
            return <RenderListBlock items={block.items} key={index} first={index === 0} last={index === blocks.length - 1} selectable={selectable} />;
          } else if (block.type === 'numbered-list') {
            return <RenderNumberedListBlock items={block.items} key={index} first={index === 0} last={index === blocks.length - 1} selectable={selectable} />;
          } else if (block.type === 'code-block') {
            return <RenderCodeBlock content={block.content} language={block.language} key={index} first={index === 0} last={index === blocks.length - 1} selectable={selectable} />;
          } else if (block.type === 'options') {
            return <RenderOptionsBlock items={block.items} key={index} first={index === 0} last={index === blocks.length - 1} selectable={selectable} onOptionPress={props.onOptionPress} />;
          } else {
            return null;
          }
        })}
      </View>
    );
  };

  if (!markdownCopyV2) {
    return renderContent();
  }
    
  if (Platform.OS === 'web') {
    return renderContent();
  }
    
  return <Pressable onLongPress={handleLongPress} delayLongPress={500}>{renderContent()}</Pressable>;
});

function RenderTextBlock(props: { spans: MarkdownSpan[], first: boolean, last: boolean, selectable: boolean }) {
  return <Text selectable={props.selectable} style={[style.text, props.first && style.first, props.last && style.last]}><RenderSpans spans={props.spans} baseStyle={style.text} /></Text>;
}

function RenderHeaderBlock(props: { level: 1 | 2 | 3 | 4 | 5 | 6, spans: MarkdownSpan[], first: boolean, last: boolean, selectable: boolean }) {
  const s = (style as any)[`header${props.level}`];
  const headerStyle = [style.header, s, props.first && style.first, props.last && style.last];
  return <Text selectable={props.selectable} style={headerStyle}><RenderSpans spans={props.spans} baseStyle={headerStyle} /></Text>;
}

function RenderListBlock(props: { items: MarkdownSpan[][], first: boolean, last: boolean, selectable: boolean }) {
  const listStyle = [style.text, style.list];
  return (
    <View style={{ flexDirection: 'column', marginBottom: 8, gap: 1 }}>
      {props.items.map((item, index) => (
        <Text selectable={props.selectable} style={listStyle} key={index}>- <RenderSpans spans={item} baseStyle={listStyle} /></Text>
      ))}
    </View>
  );
}

function RenderNumberedListBlock(props: { items: { number: number, spans: MarkdownSpan[] }[], first: boolean, last: boolean, selectable: boolean }) {
  const listStyle = [style.text, style.list];
  return (
    <View style={{ flexDirection: 'column', marginBottom: 8, gap: 1 }}>
      {props.items.map((item, index) => (
        <Text selectable={props.selectable} style={listStyle} key={index}>{item.number.toString()}. <RenderSpans spans={item.spans} baseStyle={listStyle} /></Text>
      ))}
    </View>
  );
}

// Helper function to detect if this is a terminal/command block
function isCommandBlock(language: string | null, content: string): boolean {
  // Check language indicators
  const commandLanguages = ['bash', 'sh', 'shell', 'powershell', 'ps1', 'cmd', 'terminal', 'zsh', 'fish'];
  if (language && commandLanguages.includes(language.toLowerCase())) {
    return true;
  }

  // Check content patterns for common command indicators
  const commandPatterns = [
    /^\s*[$#%>]\s+/m,  // Shell prompts: $ # % >
    /^\s*PS\s*[C-Z]:\\.*>\s*/m,  // PowerShell prompt
    /^\s*(npm|yarn|git|docker|curl|wget|ls|cd|mkdir|rm|cp|mv)\s+/m,  // Common commands
    /^\s*(sudo|chmod|chown|grep|find|sed|awk)\s+/m,  // Unix commands
  ];

  return commandPatterns.some(pattern => pattern.test(content));
}

// Helper function to clean command text by removing shell prompts
function cleanCommandText(content: string): string {
  const lines = content.split('\n');
  const cleanedLines = lines.map(line => {
    // Remove common shell prompts
    line = line.replace(/^\s*[$#%>]\s+/, '');  // $ # % >
    line = line.replace(/^\s*PS\s*[C-Z]:\\.*>\s*/, '');  // PowerShell prompt
    line = line.replace(/^\s*[a-zA-Z0-9-_]+@[a-zA-Z0-9-_]+:\S*\$\s*/, '');  // user@host:path$
    line = line.replace(/^\s*[a-zA-Z]:\\.*>\s*/, '');  // C:\path>
    return line;
  });

  return cleanedLines.join('\n').trim();
}

function RenderCodeBlock(props: { content: string, language: string | null, first: boolean, last: boolean, selectable: boolean }) {
  const isCommand = isCommandBlock(props.language, props.content);

  const handleCopyCommand = React.useCallback(async () => {
    try {
      const cleanedCommand = cleanCommandText(props.content);
      await Clipboard.setStringAsync(cleanedCommand);
      Modal.alert('Copied', 'Command copied to clipboard');
    } catch (error) {
      console.error('Error copying command:', error);
      Modal.alert('Error', 'Failed to copy command');
    }
  }, [props.content]);
  return (
    <View style={[style.codeBlock, props.first && style.first, props.last && style.last]}>
      {/* Header with language and copy button for commands */}
      <View style={style.codeHeader}>
        <View style={{ flex: 1 }}>
          {props.language && <Text selectable={props.selectable} style={style.codeLanguage}>{props.language}</Text>}
        </View>
        {isCommand && (
          <Pressable
            style={({ pressed }) => [
              style.copyButton,
              pressed && style.copyButtonPressed,
            ]}
            onPress={handleCopyCommand}
          >
            <Ionicons name="copy-outline" size={16} color="#666" />
            <Text style={style.copyButtonText}>Copy</Text>
          </Pressable>
        )}
      </View>

      <ScrollView
        style={{ flexGrow: 0, flexShrink: 0 }}
        horizontal={true}
        contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 16 }}
        showsHorizontalScrollIndicator={false}
      >
        <SimpleSyntaxHighlighter
          code={props.content}
          language={props.language}
          selectable={props.selectable}
        />
      </ScrollView>
    </View>
  );
}

function RenderOptionsBlock(props: {
    items: string[],
    first: boolean,
    last: boolean,
    selectable: boolean,
    onOptionPress?: (option: Option) => void
}) {
  // Don't render anything if no items
  if (props.items.length === 0) {
    return null;
  }

  return (
    <View style={[style.optionsContainer, props.first && style.first, props.last && style.last]}>
      {props.items.map((item, index) => {
        if (props.onOptionPress) {
          return (
            <Pressable
              key={index}
              style={({ pressed }) => [
                style.optionItem,
                pressed && style.optionItemPressed,
              ]}
              onPress={() => props.onOptionPress?.({ title: item })}
            >
              <Text selectable={props.selectable} style={style.optionText}>{item}</Text>
            </Pressable>
          );
        } else {
          return (
            <View key={index} style={style.optionItem}>
              <Text selectable={props.selectable} style={style.optionText}>{item}</Text>
            </View>
          );
        }
      })}
    </View>
  );
}

function RenderSpans(props: { spans: MarkdownSpan[], baseStyle?: any }) {
  const handleLinkPress = React.useCallback((url: string) => {
    try {
      if (Platform.OS !== 'web') {
        // Open external URLs in in-app browser on mobile
        WebBrowser.openBrowserAsync(url);
      }
    } catch (error) {
      console.error('Error opening link:', error);
      Modal.alert('Error', 'Failed to open link. Please copy and paste the URL manually.');
    }
  }, []);

  return (<>
    {props.spans.map((span, index) => {
      try {
        if (span.url) {
          return (
            <Link
              key={index}
              href={span.url as any}
              target="_blank"
              style={[style.link, span.styles.map(s => style[s])]}
              onPress={(e) => {
                if (Platform.OS !== 'web') {
                  e.preventDefault();
                  handleLinkPress(span.url!);
                }
              }}
            >
              {span.text}
            </Link>
          );
        } else {
          return <Text key={index} selectable style={[props.baseStyle, span.styles.map(s => style[s])]}>{span.text}</Text>;
        }
      } catch (error) {
        console.error('Error rendering span:', error);
        // Fallback to plain text
        return <Text key={index} selectable style={props.baseStyle}>{span.text}</Text>;
      }
    })}
  </>);
}


const style = StyleSheet.create((theme) => ({

  // Plain text

  text: {
    ...Typography.default(),
    fontSize: 16,
    lineHeight: 24, // Reduced from 28 to 24
    marginTop: 8,
    marginBottom: 8,
    color: theme.colors.text,
    fontWeight: '400',
  },

  italic: {
    fontStyle: 'italic',
  },
  bold: {
    fontWeight: 'bold',
  },
  semibold: {
    fontWeight: '600',
  },
  code: {
    ...Typography.mono(),
    fontSize: 16,
    lineHeight: 21,  // Reduced from 24 to 21
    backgroundColor: theme.colors.surfaceHighest,
    color: theme.colors.text,
  },
  link: {
    ...Typography.default(),
    color: theme.colors.textLink,
    fontWeight: '400',
  },

  // Headers

  header: {
    ...Typography.default('semiBold'),
    color: theme.colors.text,
  },
  header1: {
    fontSize: 16,
    lineHeight: 24,  // Reduced from 36 to 24
    fontWeight: '900',
    marginTop: 16,
    marginBottom: 8,
  },
  header2: {
    fontSize: 20,
    lineHeight: 24,  // Reduced from 36 to 32
    fontWeight: '600',
    marginTop: 16,
    marginBottom: 8,
  },
  header3: {
    fontSize: 16,
    lineHeight: 28,  // Reduced from 32 to 28
    fontWeight: '600',
    marginTop: 16,
    marginBottom: 8,
  },
  header4: {
    fontSize: 16,
    lineHeight: 24,
    fontWeight: '600',
    marginTop: 8,
    marginBottom: 8,
  },
  header5: {
    fontSize: 16,
    lineHeight: 24,  // Reduced from 28 to 24
    fontWeight: '600',
  },
  header6: {
    fontSize: 16,
    lineHeight: 24, // Reduced from 28 to 24
    fontWeight: '600',
  },

  //
  // List
  //

  list: {
    ...Typography.default(),
    color: theme.colors.text,
    marginTop: 0,
    marginBottom: 0,
  },

  //
  // Common
  //

  first: {
    // marginTop: 0
  },
  last: {
    // marginBottom: 0
  },

  //
  // Code Block
  //

  codeBlock: {
    backgroundColor: theme.colors.surfaceHighest,
    borderRadius: 8,
    marginVertical: 8,
  },
  codeHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 8,
    paddingHorizontal: 16,
  },
  codeLanguage: {
    ...Typography.mono(),
    color: theme.colors.textSecondary,
    fontSize: 12,
    marginBottom: 0,
  },
  copyButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.divider,
    gap: 4,
  },
  copyButtonPressed: {
    opacity: 0.7,
    backgroundColor: theme.colors.surfaceHigh,
  },
  copyButtonText: {
    ...Typography.default(),
    fontSize: 12,
    color: theme.colors.textSecondary,
  },
  codeText: {
    ...Typography.mono(),
    color: theme.colors.text,
    fontSize: 14,
    lineHeight: 20,
  },
  horizontalRule: {
    height: 1,
    backgroundColor: theme.colors.divider,
    marginTop: 8,
    marginBottom: 8,
  },

  //
  // Options Block
  //

  optionsContainer: {
    flexDirection: 'column',
    gap: 8,
    marginVertical: 8,
  },
  optionItem: {
    backgroundColor: theme.colors.surfaceHighest,
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: theme.colors.divider,
  },
  optionItemPressed: {
    opacity: 0.7,
    backgroundColor: theme.colors.surfaceHigh,
  },
  optionText: {
    ...Typography.default(),
    fontSize: 16,
    lineHeight: 24,
    color: theme.colors.text,
  },
}));