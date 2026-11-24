import type * as React from 'react';
import type { FlatList, View } from 'react-native';
import type { UserMessageAnchor } from '@/hooks/useUserMessageAnchors';
import type { DisplayItem } from '@/hooks/useGroupedMessages';

export interface ConversationAnchorRailProps {
    anchors: UserMessageAnchor[];
    items: DisplayItem[];
    rows: Array<{ id: string; renderKey: string }>;
    viewportRef: React.RefObject<View | null>;
    listRef: React.RefObject<FlatList | null>;
    inverted: boolean;
    hasMoreOlder?: boolean;
    onSelect: (anchor: UserMessageAnchor) => void;
    onOpenList: () => void;
    onAvailabilityChange: (available: boolean) => void;
}

/** Touch/native keeps the existing anchor sheet. The rail is a Web enhancement. */
export function ConversationAnchorRail(_props: ConversationAnchorRailProps) {
    return null;
}
