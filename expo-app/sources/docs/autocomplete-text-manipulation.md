# Autocomplete Text Manipulation Documentation

Based on analysis of the Openland Apps repository, this document explains how text manipulation works for autocomplete functionality in both web and mobile implementations.

## Core Algorithm: findActiveWord

The foundation of the autocomplete system is the `findActiveWord` utility that detects when a user is typing a mention (@) or emoji (:).

```typescript
// packages/openland-y-utils/findActiveWord.ts
const stoplist = ['\n', ',', '(', ')'];
const prefixes = ['@', ':'];

function findActiveWord(content: string, selection: { start: number, end: number }): string | undefined {
    if (selection.start !== selection.end) {
        return undefined; // No active word if text is selected
    }
    
    let startIndex = findActiveWordStart(content, selection);
    let res = content.substring(startIndex, selection.end);
    
    if (res.length === 0) {
        return undefined;
    } else {
        return res;
    }
}
```

The algorithm:
1. Works backwards from cursor position
2. Looks for prefix characters (@ or :) that start a word
3. Stops at whitespace, newlines, or special characters
4. Returns the active word including the prefix

## Web Implementation (Quill.js)

### Text Input Component
The web implementation uses Quill.js rich text editor with custom formats for mentions and emojis.

```typescript
// packages/openland-web/components/unicorn/URickInput.tsx

// Extract active word from Quill editor
function extractActiveWord(quill: QuillType.Quill) {
    let selection = quill.getSelection();
    if (!selection) {
        return null;
    }
    let start = Math.max(0, selection.index - 64); // Maximum lookback
    
    return findActiveWord(
        quill.getText(start, selection.index + selection.length - start), 
        {
            start: selection.index,
            end: selection.index + selection.length,
        }
    );
}
```

### Text Replacement Logic
When a user selects a mention from the autocomplete suggestions:

```typescript
// URickInput.tsx - commitSuggestion method
commitSuggestion: (type: 'mention' | 'emoji', src: MentionToSend | { name: string; value: string }) => {
    let ed = editor.current;
    if (ed) {
        let selection = ed.getSelection(true);
        let autocompleteWord = extractActiveWord(ed);
        
        if (autocompleteWord) {
            // Insert the mention/emoji embed at current position
            ed.insertEmbed(selection.index, type, src, 'user');
            
            // Add space after mention (not emoji)
            if (type === 'mention') {
                ed.insertText(selection.index + 1, ' ', 'user');
            }
            
            // Delete the typed text (including the @ prefix)
            ed.deleteText(
                selection.index - autocompleteWord.length,
                autocompleteWord.length + selection.length,
                'user'
            );
            
            // Move cursor after the inserted mention/emoji
            ed.setSelection(selection.index + 1, 1, 'user');
        }
    }
}
```

The process:
1. Get current cursor position and selection
2. Find the active word being typed
3. Insert the mention/emoji as an embedded object
4. Delete the original typed text (e.g., "@john")
5. Position cursor after the inserted element

### Real-time Updates
The editor monitors text changes and updates autocomplete suggestions:

```typescript
q.on('editor-change', () => {
    // ... other logic
    
    if (props.onAutocompleteWordChange && props.autocompletePrefixes) {
        let selection = q.getSelection();
        if (selection) {
            let autocompleteWord: string | null = null;
            let activeWord = extractActiveWord(q);
            
            if (activeWord) {
                // Check if active word starts with any prefix
                for (let p of props.autocompletePrefixes) {
                    if (activeWord.toLowerCase().startsWith(p)) {
                        autocompleteWord = activeWord;
                        break;
                    }
                }
            }
            
            // Notify parent component of autocomplete word change
            if (lastAutocompleteText !== autocompleteWord) {
                lastAutocompleteText = autocompleteWord;
                props.onAutocompleteWordChange(autocompleteWord);
            }
        }
    }
});
```

## Mobile Implementation (React Native)

### Text Input Component
Mobile uses standard React Native TextInput with selection tracking:

```typescript
// packages/openland-mobile/pages/main/components/MessageInputInner.tsx
<TextInput
    ref={ref}
    selectionColor={theme.accentPrimary}
    style={{...}}
    onChangeText={props.onChangeText}
    onSelectionChange={props.onSelectionChange}
    value={props.text}
    multiline={true}
    {...inputProps}
/>
```

### Text Manipulation Pattern
While the exact mobile text replacement code wasn't found in the examined files, the pattern follows:

1. Track cursor position using `onSelectionChange`
2. Use `findActiveWord` with current text and selection
3. When mention selected, manipulate text string:
   ```typescript
   // Pseudo-code for mobile text replacement
   const replaceText = (text: string, selection: Selection, mention: string) => {
       const activeWord = findActiveWord(text, selection);
       if (activeWord) {
           const startIndex = selection.start - activeWord.length;
           const newText = 
               text.substring(0, startIndex) + 
               mention + ' ' + 
               text.substring(selection.end);
           return {
               text: newText,
               selection: { start: startIndex + mention.length + 1, end: startIndex + mention.length + 1 }
           };
       }
   };
   ```

### Suggestion Display
Mobile shows suggestions in a floating view above the keyboard:

```typescript
// packages/openland-mobile/pages/main/components/MessageInputBar.tsx
{props.suggestions && (
    <ZBlurredView intensity="normal" style={{ position: 'absolute', bottom: '100%', left: 0, right: 0 }}>
        {props.suggestions}
    </ZBlurredView>
)}
```

## Key Differences Between Platforms

### Web (Quill.js)
- Rich text editor with embedded objects
- Mentions stored as objects, not plain text
- Built-in undo/redo support
- More complex but feature-rich

### Mobile (React Native)
- Plain text manipulation
- Mentions stored as special text patterns
- Manual string manipulation
- Simpler but requires careful cursor management

## Implementation Tips

1. **Active Word Detection**: Always check from cursor position backwards, stop at special characters
2. **Text Replacement**: Calculate correct indices before and after replacement
3. **Cursor Management**: Always update cursor position after text manipulation
4. **Platform Differences**: Web can use rich text, mobile typically uses plain text with markers
5. **Performance**: Debounce autocomplete queries to avoid excessive API calls

## Data Flow

1. User types "@" or ":"
2. `findActiveWord` detects the prefix and extracts the query
3. Parent component receives the active word
4. GraphQL query fetches matching users/emojis
5. Suggestions displayed in dropdown/popup
6. User selects suggestion
7. Text manipulation replaces typed text with selection
8. Cursor positioned after inserted content

This architecture provides a responsive autocomplete experience across both web and mobile platforms while handling the complexity of text manipulation and cursor management.