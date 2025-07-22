import React from 'react';
import { Text, View } from 'react-native';
import { Typography } from '@/constants/Typography';

interface SimpleSyntaxHighlighterProps {
  code: string;
  language: string | null;
}

// Comprehensive color scheme - saturated pastel colors with unique bracket colors
const colors = {
  // Language constructs
  keyword: '#1d4ed8',        // Deep blue for keywords (function, const, etc.)
  controlFlow: '#9333ea',    // Deep purple for control flow (if, else, for, etc.)
  type: '#ea580c',           // Orange for types and classes
  modifier: '#c2410c',       // Orange-red for modifiers (public, private, etc.)
  
  // Literals and values
  string: '#059669',         // Emerald green for strings
  number: '#0891b2',         // Cyan/teal for numbers
  boolean: '#db2777',        // Pink for true/false/null
  regex: '#16a34a',          // Green for regex
  
  // Functions and methods
  function: '#9333ea',       // Deep purple for function names
  method: '#0ea5e9',         // Sky blue for method calls
  property: '#ea580c',       // Orange for properties
  
  // Comments and documentation
  comment: '#6b7280',        // Gray for comments
  docstring: '#6b7280',      // Gray for docstrings
  
  // Operators and punctuation
  operator: '#374151',       // Dark gray for operators
  assignment: '#1d4ed8',     // Deep blue for assignment operators
  comparison: '#9333ea',     // Deep purple for comparison operators
  logical: '#0891b2',        // Teal for logical operators
  
  // Brackets with UNIQUE colors - not used anywhere else
  bracket1: '#ff6b6b',       // Coral red - level 1
  bracket2: '#4ecdc4',       // Turquoise - level 2  
  bracket3: '#45b7d1',       // Light blue - level 3
  bracket4: '#f7b731',       // Golden yellow - level 4
  bracket5: '#5f27cd',       // Deep violet - level 5
  
  // Special tokens
  decorator: '#c2410c',      // Orange-red for decorators (@decorator)
  import: '#0891b2',         // Teal for import/export
  variable: '#374151',       // Dark gray for variables
  parameter: '#ea580c',      // Orange for parameters
  
  // Default
  default: '#374151',        // Dark gray default
  punctuation: '#6b7280',    // Gray for general punctuation
};

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
      <Text style={{ 
        fontFamily: Typography.mono().fontFamily,
        fontSize: 14,
        lineHeight: 20,
      }}>
        {tokens.map((token, index) => (
          <Text
            key={index}
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