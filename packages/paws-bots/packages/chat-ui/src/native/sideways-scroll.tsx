import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { GestureResponderEvent, StyleProp, ViewStyle } from "react-native";
import { ScrollView, View } from "react-native";

const scrollFrame: ViewStyle = {
  width: "100%",
  maxWidth: "100%",
  minWidth: 0,
  flexShrink: 1,
  flexDirection: "row",
};

// Matches Pressable's default long-press delay.
const MESSAGE_LONG_PRESS_DELAY = 500;
export const MarkdownLongPressContext = createContext<
  ((event: GestureResponderEvent) => void) | undefined
>(undefined);

/**
 * A block that scrolls sideways when it is wider than the bubble. Tables pass the width they lay
 * out to; code is measured.
 */
export function SidewaysScrollView({
  contentWidth,
  onViewportWidth,
  style,
  children,
}: {
  contentWidth?: number;
  onViewportWidth?: (width: number) => void;
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
}) {
  const onLongPress = useContext(MarkdownLongPressContext);
  const touchStart = useRef({ x: 0, y: 0 });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cancelLongPress = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = undefined;
  }, []);
  useEffect(() => cancelLongPress, [cancelLongPress]);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [measuredWidth, setMeasuredWidth] = useState(0);
  const measured = contentWidth === undefined;
  const width = contentWidth ?? measuredWidth;
  // A block that fits isn't a scroll area, so VoiceOver shouldn't announce scroll bars on it.
  const overflows = viewportWidth > 0 && width > viewportWidth;
  return (
    <View
      style={scrollFrame}
      onLayout={(event) => {
        const next = Math.round(event.nativeEvent.layout.width);
        setViewportWidth(next);
        onViewportWidth?.(next);
      }}
    >
      <ScrollView
        horizontal
        scrollEnabled={overflows}
        showsHorizontalScrollIndicator={overflows}
        showsVerticalScrollIndicator={false}
        nestedScrollEnabled
        directionalLockEnabled
        onContentSizeChange={measured ? (next) => setMeasuredWidth(Math.round(next)) : undefined}
        style={[
          style,
          viewportWidth > 0 ? { width: viewportWidth } : { flexGrow: 1, flexShrink: 1 },
        ]}
        // Measured content fills a bubble it fits, like a block that doesn't scroll.
        contentContainerStyle={{ flexGrow: measured ? 1 : 0 }}
      >
        <View
          // Claim before the bubble blocks native scrolling; deeper link responders still win.
          onStartShouldSetResponder={() => overflows}
          onResponderGrant={(event) => {
            cancelLongPress();
            touchStart.current = { x: event.nativeEvent.pageX, y: event.nativeEvent.pageY };
            if (onLongPress) {
              event.persist();
              timer.current = setTimeout(() => {
                timer.current = undefined;
                onLongPress(event);
              }, MESSAGE_LONG_PRESS_DELAY);
            }
          }}
          onResponderMove={({ nativeEvent }) => {
            if (
              Math.abs(nativeEvent.pageX - touchStart.current.x) > 5 ||
              Math.abs(nativeEvent.pageY - touchStart.current.y) > 5
            )
              cancelLongPress();
          }}
          onResponderRelease={cancelLongPress}
          onResponderTerminate={cancelLongPress}
          onResponderTerminationRequest={() => true}
          style={
            measured
              ? { flexGrow: 1 }
              : { width: contentWidth, minWidth: contentWidth, flexShrink: 0 }
          }
        >
          {children}
        </View>
      </ScrollView>
    </View>
  );
}
