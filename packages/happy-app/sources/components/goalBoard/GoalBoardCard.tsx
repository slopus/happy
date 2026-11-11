import * as React from 'react';
import { View, type ViewStyle, type StyleProp } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

export const GoalBoardCardFocus = React.createContext<((focused: boolean) => void) | null>(null);

/** One theme surface surrounds both the body and its sibling actions. */
export function GoalBoardCard({ children, selected, style, testID }: { children: React.ReactNode; selected?: boolean; style?: StyleProp<ViewStyle>; testID?: string }) {
    const [hovered, setHovered] = React.useState(false);
    const [pressed, setPressed] = React.useState(false);
    const [focused, setFocused] = React.useState(false);
    return <GoalBoardCardFocus.Provider value={setFocused}><View testID={testID} onPointerEnter={() => setHovered(true)} onPointerLeave={() => { setHovered(false); setPressed(false); }}
        onPointerDown={() => setPressed(true)} onPointerUp={() => setPressed(false)} onPointerCancel={() => setPressed(false)}
        style={[styles.card, style, pressed ? styles.hovered : selected ? styles.selected : hovered ? styles.hovered : undefined, focused && styles.focused]}>{children}</View></GoalBoardCardFocus.Provider>;
}
const styles = StyleSheet.create(theme => ({
    card: { borderWidth: 1, borderColor: theme.colors.divider, borderRadius: 10, overflow: 'hidden', backgroundColor: theme.colors.surface },
    selected: { borderColor: theme.colors.textLink, backgroundColor: theme.colors.surfaceSelected },
    hovered: { backgroundColor: theme.colors.surfacePressed },
    focused: { borderColor: theme.colors.textLink },
}));
