import React from 'react';
import { Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';

interface SimpleSyntaxHighlighterProps {
  code: string;
  language: string | null;
}

// Get theme-aware colors
const getColors = (theme: any) => ({
  // Use theme colors directly for syntax highlighting
  keyword: theme.colors.syntaxKeyword,
  controlFlow: theme.colors.syntaxKeyword,
  type: theme.colors.syntaxKeyword,
  modifier: theme.colors.syntaxKeyword,
  
  string: theme.colors.syntaxString,
  number: theme.colors.syntaxNumber,
  boolean: theme.colors.syntaxNumber,
  regex: theme.colors.syntaxString,
  
  function: theme.colors.syntaxFunction,
  method: theme.colors.syntaxFunction,
  property: theme.colors.syntaxDefault,
  
  comment: theme.colors.syntaxComment,
  docstring: theme.colors.syntaxComment,
  
  operator: theme.colors.syntaxDefault,
  assignment: theme.colors.syntaxKeyword,
  comparison: theme.colors.syntaxKeyword,
  logical: theme.colors.syntaxKeyword,
  
  bracket1: theme.colors.syntaxBracket1,
  bracket2: theme.colors.syntaxBracket2,
  bracket3: theme.colors.syntaxBracket3,
  bracket4: theme.colors.syntaxBracket4,
  bracket5: theme.colors.syntaxBracket5,
  
  decorator: theme.colors.syntaxKeyword,
  import: theme.colors.syntaxKeyword,
  variable: theme.colors.syntaxDefault,
  parameter: theme.colors.syntaxDefault,
  
  default: theme.colors.syntaxDefault,
  punctuation: theme.colors.syntaxDefault,
});

// Bracket pairs for nesting detection
const bracketPairs = {
  '(': ')',
  '[': ']',
  '{': '}',
  '<': '>',
};

const openBrackets = Object.keys(bracketPairs);
const closeBrackets = Object.values(bracketPairs);

// Enhanced tokenizer with comprehensive token types
const tokenizeCode = (code: string, language: string | null) => {
  const tokens: Array<{ text: string; type: string; nestLevel?: number }> = [];
  
  if (!language) {
    return [{ text: code, type: 'default' }];
  }

  const lang = language.toLowerCase();
  
  // Language-specific keyword sets
  const keywordSets = {
    controlFlow: ['if', 'else', 'elif', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue', 'return', 'yield', 'try', 'catch', 'finally', 'throw', 'with'],
    keywords: ['function', 'const', 'let', 'var', 'def', 'class', 'interface', 'enum', 'struct', 'union', 'namespace', 'module'],
    types: ['int', 'string', 'bool', 'float', 'double', 'char', 'void', 'any', 'unknown', 'never', 'object', 'array', 'number', 'boolean'],
    modifiers: ['public', 'private', 'protected', 'static', 'final', 'abstract', 'virtual', 'override', 'async', 'await', 'export', 'default'],
    boolean: ['true', 'false', 'null', 'undefined', 'None', 'True', 'False', 'nil'],
    imports: ['import', 'from', 'export', 'require', 'include', 'using', 'package'],
  };

  // Language-specific additions
  if (lang === 'python' || lang === 'py') {
    keywordSets.keywords.push('def', 'lambda', 'pass', 'global', 'nonlocal', 'as', 'in', 'is', 'not', 'and', 'or');
    keywordSets.types.push('str', 'list', 'dict', 'tuple', 'set');
  } else if (lang === 'typescript' || lang === 'ts') {
    keywordSets.types.push('Record', 'Partial', 'Required', 'Readonly', 'Pick', 'Omit');
    keywordSets.keywords.push('type', 'interface', 'extends', 'implements', 'keyof', 'typeof');
  } else if (lang === 'java') {
    keywordSets.keywords.push('package', 'extends', 'implements', 'super', 'this');
    keywordSets.modifiers.push('synchronized', 'transient', 'volatile', 'native', 'strictfp');
  }

  // Enhanced regex patterns for comprehensive tokenization
  const patterns = [
    // Comments (highest priority)
    { regex: /(\/\*[\s\S]*?\*\/)/g, type: 'comment' },
    { regex: /(\/\/.*$)/gm, type: 'comment' },
    { regex: /(#.*$)/gm, type: 'comment' },
    { regex: /("""[\s\S]*?"""|'''[\s\S]*?''')/g, type: 'docstring' },
    
    // Strings and regex
    { regex: /(r?["'`])((?:(?!\1)[^\\]|\\.)*)(\1)/g, type: 'string' },
    { regex: /(\/(?:[^\/\\\n]|\\.)+\/[gimuy]*)/g, type: 'regex' },
    
    // Numbers (including hex, binary, floats)
    { regex: /\b(0x[0-9a-fA-F]+|0b[01]+|0o[0-7]+|\d+\.?\d*(?:[eE][+-]?\d+)?)\b/g, type: 'number' },
    
    // Decorators
    { regex: /@\w+/g, type: 'decorator' },
    
    // Function definitions and calls
    { regex: /\b(function|def|async function)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g, type: 'function', captureGroup: 2 },
    { regex: /\b([a-zA-Z_$][a-zA-Z0-9_$]*)\s*(?=\()/g, type: 'function' },
    
    // Method calls (object.method)
    { regex: /\.([a-zA-Z_$][a-zA-Z0-9_$]*)\s*(?=\()/g, type: 'method', captureGroup: 1 },
    { regex: /\.([a-zA-Z_$][a-zA-Z0-9_$]*)/g, type: 'property', captureGroup: 1 },
    
    // Keywords by category
    { regex: new RegExp(`\\b(${keywordSets.imports.join('|')})\\b`, 'g'), type: 'import' },
    { regex: new RegExp(`\\b(${keywordSets.controlFlow.join('|')})\\b`, 'g'), type: 'controlFlow' },
    { regex: new RegExp(`\\b(${keywordSets.keywords.join('|')})\\b`, 'g'), type: 'keyword' },
    { regex: new RegExp(`\\b(${keywordSets.types.join('|')})\\b`, 'g'), type: 'type' },
    { regex: new RegExp(`\\b(${keywordSets.modifiers.join('|')})\\b`, 'g'), type: 'modifier' },
    { regex: new RegExp(`\\b(${keywordSets.boolean.join('|')})\\b`, 'g'), type: 'boolean' },
    
    // Operators by category
    { regex: /(===|!==|==|!=|<=|>=|<|>)/g, type: 'comparison' },
    { regex: /(&&|\|\||!)/g, type: 'logical' },
    { regex: /(=|\+=|\-=|\*=|\/=|%=|\|=|&=|\^=)/g, type: 'assignment' },
    { regex: /(\+|\-|\*|\/|%|\*\*)/g, type: 'operator' },
    { regex: /(\?|:)/g, type: 'operator' },
    
    // Brackets and punctuation
    { regex: /([()[\]{}])/g, type: 'bracket' },
    { regex: /([.,;])/g, type: 'punctuation' },
  ];

  // Calculate bracket nesting levels
  const calculateBracketNesting = (code: string) => {
    const nestingMap = new Map<number, number>();
    const stack: Array<{ char: string; pos: number }> = [];
    
    for (let i = 0; i < code.length; i++) {
      const char = code[i];
      
      if (openBrackets.includes(char)) {
        stack.push({ char, pos: i });
        nestingMap.set(i, stack.length);
      } else if (closeBrackets.includes(char)) {
        if (stack.length > 0) {
          const lastOpen = stack.pop();
          if (lastOpen && bracketPairs[lastOpen.char as keyof typeof bracketPairs] === char) {
            nestingMap.set(i, stack.length + 1);
          }
        }
      }
    }
    
    return nestingMap;
  };

  const nestingMap = calculateBracketNesting(code);

  // Split code into lines to preserve line breaks
  const lines = code.split('\n');
  let globalOffset = 0;
  
  lines.forEach((line, lineIndex) => {
    if (lineIndex > 0) {
      tokens.push({ text: '\n', type: 'default' });
      globalOffset += 1; // for the \n character
    }
    
    const lineTokens: Array<{ start: number; end: number; type: string; text: string; captureGroup?: number }> = [];

    // Find all matches for all patterns
    patterns.forEach(pattern => {
      let match;
      pattern.regex.lastIndex = 0;
      while ((match = pattern.regex.exec(line)) !== null) {
        const tokenText = pattern.captureGroup ? match[pattern.captureGroup] : match[0];
        const tokenStart = pattern.captureGroup ? match.index + match[0].indexOf(tokenText) : match.index;
        
        lineTokens.push({
          start: tokenStart,
          end: tokenStart + tokenText.length,
          type: pattern.type,
          text: tokenText,
          captureGroup: pattern.captureGroup
        });
      }
    });

    // Sort tokens by position and remove overlaps
    lineTokens.sort((a, b) => a.start - b.start);
    
    const filteredTokens: typeof lineTokens = [];
    let lastEnd = 0;
    lineTokens.forEach(token => {
      if (token.start >= lastEnd) {
        filteredTokens.push(token);
        lastEnd = token.end;
      }
    });

    // Add tokens with proper nesting levels for brackets
    let currentIndex = 0;
    filteredTokens.forEach(token => {
      // Add text before this token
      if (token.start > currentIndex) {
        const beforeText = line.slice(currentIndex, token.start);
        if (beforeText) {
          tokens.push({ text: beforeText, type: 'default' });
        }
      }
      
      // Add the token with nesting level if it's a bracket
      if (token.type === 'bracket') {
        const globalPos = globalOffset + token.start;
        const nestLevel = nestingMap.get(globalPos) || 1;
        tokens.push({ 
          text: token.text, 
          type: token.type,
          nestLevel: nestLevel
        });
      } else {
        tokens.push({ text: token.text, type: token.type });
      }
      
      currentIndex = token.end;
    });

    // Add remaining text
    if (currentIndex < line.length) {
      const remainingText = line.slice(currentIndex);
      if (remainingText) {
        tokens.push({ text: remainingText, type: 'default' });
      }
    }
    
    globalOffset += line.length;
  });

  return tokens;
};

export const SimpleSyntaxHighlighter: React.FC<SimpleSyntaxHighlighterProps> = ({
  code,
  language
}) => {
  const { theme } = useUnistyles();
  const colors = getColors(theme);
  const tokens = tokenizeCode(code, language);

  const getColorForType = (type: string, nestLevel?: number): string => {
    switch (type) {
      case 'keyword': return colors.keyword;
      case 'controlFlow': return colors.controlFlow;
      case 'type': return colors.type;
      case 'modifier': return colors.modifier;
      case 'string': return colors.string;
      case 'number': return colors.number;
      case 'boolean': return colors.boolean;
      case 'regex': return colors.regex;
      case 'function': return colors.function;
      case 'method': return colors.method;
      case 'property': return colors.property;
      case 'comment': return colors.comment;
      case 'docstring': return colors.docstring;
      case 'operator': return colors.operator;
      case 'assignment': return colors.assignment;
      case 'comparison': return colors.comparison;
      case 'logical': return colors.logical;
      case 'decorator': return colors.decorator;
      case 'import': return colors.import;
      case 'variable': return colors.variable;
      case 'parameter': return colors.parameter;
      case 'punctuation': return colors.punctuation;
      case 'bracket': 
        switch ((nestLevel || 1) % 5) {
          case 1: return colors.bracket1;
          case 2: return colors.bracket2;
          case 3: return colors.bracket3;
          case 4: return colors.bracket4;
          case 0: return colors.bracket5; // Level 5, 10, 15, etc.
          default: return colors.bracket1;
        }
      default: return colors.default;
    }
  };

  return (
    <View>
      <Text 
        selectable
        style={{ 
          fontFamily: Typography.mono().fontFamily,
          fontSize: 14,
          lineHeight: 20,
        }}
      >
        {tokens.map((token, index) => (
          <Text
            key={index}
            selectable
            style={{
              color: getColorForType(token.type, token.nestLevel),
              fontFamily: Typography.mono().fontFamily,
              fontWeight: ['keyword', 'controlFlow', 'type', 'function'].includes(token.type) ? '600' : '400',
            }}
          >
            {token.text}
          </Text>
        ))}
      </Text>
    </View>
  );
}; 