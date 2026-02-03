import * as React from "react";
import { Modal, View, Pressable, useWindowDimensions, Platform, FlatList } from "react-native";
import { Image } from "expo-image";
import { StyleSheet } from "react-native-unistyles";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  runOnJS,
  interpolate,
  SharedValue,
} from "react-native-reanimated";

export type ImageViewerImage = {
  uri: string;
};

type Props = {
  images: ImageViewerImage[];
  visible: boolean;
  initialIndex?: number;
  onClose: () => void;
};

const MIN_SCALE = 1;
const MAX_SCALE = 5;
const DISMISS_THRESHOLD = 150;
const IS_WEB = Platform.OS === "web";

export function ImageViewer({ images, visible, initialIndex = 0, onClose }: Props) {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [currentIndex, setCurrentIndex] = React.useState(initialIndex);
  const flatListRef = React.useRef<FlatList>(null);

  // Shared value for background opacity (controlled by child)
  const dismissProgress = useSharedValue(0);

  // Track if image is zoomed to disable FlatList scrolling
  const [isZoomed, setIsZoomed] = React.useState(false);

  // Reset index when opening
  React.useEffect(() => {
    if (visible) {
      const idx = Math.min(initialIndex, images.length - 1);
      setCurrentIndex(idx);
      dismissProgress.value = 0;
      setIsZoomed(false);
      // Scroll to initial index
      setTimeout(() => {
        flatListRef.current?.scrollToIndex({ index: idx, animated: false });
      }, 0);
    }
  }, [visible, initialIndex, images.length]);

  const onViewableItemsChanged = React.useCallback(({ viewableItems }: { viewableItems: Array<{ index: number | null }> }) => {
    if (viewableItems.length > 0 && viewableItems[0].index !== null) {
      setCurrentIndex(viewableItems[0].index);
    }
  }, []);

  const viewabilityConfig = React.useMemo(() => ({
    itemVisiblePercentThreshold: 50,
  }), []);

  const getItemLayout = React.useCallback((_: unknown, index: number) => ({
    length: width,
    offset: width * index,
    index,
  }), [width]);

  const backgroundStyle = useAnimatedStyle(() => ({
    backgroundColor: `rgba(0, 0, 0, ${interpolate(dismissProgress.value, [0, 1], [0.95, 0])})`,
  }));

  const renderItem = React.useCallback(({ item, index }: { item: ImageViewerImage; index: number }) => (
    <ZoomableImage
      uri={item.uri}
      width={width}
      height={height}
      onClose={onClose}
      dismissProgress={dismissProgress}
      onZoomChange={setIsZoomed}
      isActive={index === currentIndex}
    />
  ), [width, height, onClose, dismissProgress, currentIndex]);

  if (!visible || images.length === 0) return null;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <GestureHandlerRootView style={styles.flex}>
        <Animated.View style={[styles.container, backgroundStyle]}>
          {/* Close button - web only */}
          {Platform.OS === 'web' && (
            <Pressable
              style={[styles.closeButton, { top: insets.top + 16 }]}
              onPress={onClose}
            >
              <Ionicons name="close" size={28} color="white" />
            </Pressable>
          )}

          {/* Image gallery with FlatList for smooth scrolling */}
          <FlatList
            ref={flatListRef}
            data={images}
            renderItem={renderItem}
            keyExtractor={(_, index) => index.toString()}
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            initialScrollIndex={Math.min(initialIndex, images.length - 1)}
            getItemLayout={getItemLayout}
            onViewableItemsChanged={onViewableItemsChanged}
            viewabilityConfig={viewabilityConfig}
            scrollEnabled={!isZoomed}
            style={styles.flex}
          />

          {/* Pagination dots */}
          {images.length > 1 && (
            <View style={[styles.pagination, { bottom: insets.bottom + 24 }]}>
              {images.map((_, index) => (
                <View
                  key={index}
                  style={[
                    styles.dot,
                    index === currentIndex && styles.dotActive,
                  ]}
                />
              ))}
            </View>
          )}
        </Animated.View>
      </GestureHandlerRootView>
    </Modal>
  );
}

type ZoomableImageProps = {
  uri: string;
  width: number;
  height: number;
  onClose: () => void;
  dismissProgress: SharedValue<number>;
  onZoomChange: (zoomed: boolean) => void;
  isActive: boolean;
};

function ZoomableImage({ uri, width, height, onClose, dismissProgress, onZoomChange, isActive }: ZoomableImageProps) {
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const savedTranslateX = useSharedValue(0);
  const savedTranslateY = useSharedValue(0);
  const focalX = useSharedValue(0);
  const focalY = useSharedValue(0);
  const isMouseDragging = React.useRef(false);
  const mouseStart = React.useRef({ x: 0, y: 0 });
  const mouseStartTranslate = React.useRef({ x: 0, y: 0 });

  // For dismiss gesture
  const dismissY = useSharedValue(0);

  const imageHeight = height * 0.8;

  const clampTranslation = React.useCallback((x: number, y: number, currentScale: number) => {
    if (currentScale <= 1) {
      return { x, y };
    }
    const maxX = Math.max(0, (width * currentScale - width) / 2);
    const maxY = Math.max(0, (imageHeight * currentScale - imageHeight) / 2);
    return {
      x: Math.min(Math.max(x, -maxX), maxX),
      y: Math.min(Math.max(y, -maxY), maxY),
    };
  }, [width, imageHeight]);

  const getPointerPosition = React.useCallback((event: any) => {
    const nativeEvent = event?.nativeEvent ?? event;
    const x = nativeEvent?.pageX ?? nativeEvent?.clientX ?? 0;
    const y = nativeEvent?.pageY ?? nativeEvent?.clientY ?? 0;
    return { x, y };
  }, []);

  const handlePointerDown = React.useCallback((event: any) => {
    if (!IS_WEB) return;
    event?.stopPropagation?.();
    event?.preventDefault?.();
    if (event?.currentTarget?.setPointerCapture && event?.pointerId != null) {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    isMouseDragging.current = true;
    mouseStart.current = getPointerPosition(event);
    mouseStartTranslate.current = { x: translateX.value, y: translateY.value };
  }, [getPointerPosition, translateX, translateY]);

  const handlePointerMove = React.useCallback((event: any) => {
    if (!IS_WEB) return;
    if (!isMouseDragging.current) return;
    event?.stopPropagation?.();
    event?.preventDefault?.();
    const currentScale = scale.value;
    const { x, y } = getPointerPosition(event);
    const dx = x - mouseStart.current.x;
    const dy = y - mouseStart.current.y;
    const next = clampTranslation(
      mouseStartTranslate.current.x + dx,
      mouseStartTranslate.current.y + dy,
      currentScale
    );
    translateX.value = next.x;
    translateY.value = next.y;
  }, [clampTranslation, getPointerPosition, scale, translateX, translateY]);

  const handlePointerUp = React.useCallback((event?: any) => {
    if (!IS_WEB) return;
    if (!isMouseDragging.current) return;
    if (event?.currentTarget?.releasePointerCapture && event?.pointerId != null) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    isMouseDragging.current = false;
    savedTranslateX.value = translateX.value;
    savedTranslateY.value = translateY.value;
  }, [savedTranslateX, savedTranslateY, translateX, translateY]);

  // Reset zoom when becoming inactive
  React.useEffect(() => {
    if (!isActive) {
      scale.value = 1;
      savedScale.value = 1;
      translateX.value = 0;
      translateY.value = 0;
      savedTranslateX.value = 0;
      savedTranslateY.value = 0;
      dismissY.value = 0;
    }
  }, [isActive]);

  // Notify parent about zoom state
  const notifyZoomChange = React.useCallback((zoomed: boolean) => {
    onZoomChange(zoomed);
  }, [onZoomChange]);

  // Pinch gesture for zooming
  const pinchGesture = Gesture.Pinch()
    .onStart((e) => {
      'worklet';
      focalX.value = e.focalX;
      focalY.value = e.focalY;
    })
    .onUpdate((e) => {
      'worklet';
      const newScale = Math.min(Math.max(savedScale.value * e.scale, MIN_SCALE), MAX_SCALE);
      scale.value = newScale;

      if (newScale > 1) {
        const centerX = width / 2;
        const centerY = height / 2;
        const focalOffsetX = (focalX.value - centerX) * (1 - e.scale);
        const focalOffsetY = (focalY.value - centerY) * (1 - e.scale);

        const newX = savedTranslateX.value + focalOffsetX;
        const newY = savedTranslateY.value + focalOffsetY;
        const maxX = Math.max(0, (width * newScale - width) / 2);
        const maxY = Math.max(0, (imageHeight * newScale - imageHeight) / 2);
        translateX.value = Math.min(Math.max(newX, -maxX), maxX);
        translateY.value = Math.min(Math.max(newY, -maxY), maxY);
      }
    })
    .onEnd(() => {
      'worklet';
      savedScale.value = scale.value;
      savedTranslateX.value = translateX.value;
      savedTranslateY.value = translateY.value;

      if (scale.value < 1.1) {
        scale.value = withTiming(1);
        savedScale.value = 1;
        translateX.value = withTiming(0);
        translateY.value = withTiming(0);
        savedTranslateX.value = 0;
        savedTranslateY.value = 0;
        runOnJS(notifyZoomChange)(false);
      } else {
        runOnJS(notifyZoomChange)(true);
      }
    });

  // Pan gesture for zoomed image dragging and dismiss
  // Only activate for vertical movement when not zoomed, or any movement when zoomed
  const panGesture = Gesture.Pan()
    .activeOffsetY([-10, 10])
    .failOffsetX([-20, 20])
    .enabled(!IS_WEB)
    .onStart(() => {
      'worklet';
    })
    .onUpdate((e) => {
      'worklet';
      if (scale.value > 1) {
        // When zoomed in, pan the image
        const newX = savedTranslateX.value + e.translationX;
        const newY = savedTranslateY.value + e.translationY;
        const maxX = Math.max(0, (width * scale.value - width) / 2);
        const maxY = Math.max(0, (imageHeight * scale.value - imageHeight) / 2);
        translateX.value = Math.min(Math.max(newX, -maxX), maxX);
        translateY.value = Math.min(Math.max(newY, -maxY), maxY);
      } else {
        // When not zoomed, only handle vertical dismiss gesture
        dismissY.value = e.translationY;
        dismissProgress.value = Math.min(Math.abs(e.translationY) / DISMISS_THRESHOLD, 1);
      }
    })
    .onEnd((e) => {
      'worklet';
      if (scale.value > 1) {
        savedTranslateX.value = translateX.value;
        savedTranslateY.value = translateY.value;
      } else {
        const absY = Math.abs(e.translationY);

        if (absY > DISMISS_THRESHOLD) {
          runOnJS(onClose)();
          return;
        }

        dismissY.value = withTiming(0);
        dismissProgress.value = withTiming(0);
      }
    });

  // Double tap to zoom in/out
  const doubleTapGesture = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd((e) => {
      'worklet';
      if (scale.value > 1) {
        scale.value = withTiming(1);
        savedScale.value = 1;
        translateX.value = withTiming(0);
        translateY.value = withTiming(0);
        savedTranslateX.value = 0;
        savedTranslateY.value = 0;
        runOnJS(notifyZoomChange)(false);
      } else {
        const newScale = 2.5;
        const centerX = width / 2;
        const centerY = height / 2;
        const tapOffsetX = (e.x - centerX) * (1 - newScale);
        const tapOffsetY = (e.y - centerY) * (1 - newScale);

        const maxX = Math.max(0, (width * newScale - width) / 2);
        const maxY = Math.max(0, (imageHeight * newScale - imageHeight) / 2);
        const clampedX = Math.min(Math.max(tapOffsetX, -maxX), maxX);
        const clampedY = Math.min(Math.max(tapOffsetY, -maxY), maxY);

        scale.value = withTiming(newScale);
        savedScale.value = newScale;
        translateX.value = withTiming(clampedX);
        translateY.value = withTiming(clampedY);
        savedTranslateX.value = clampedX;
        savedTranslateY.value = clampedY;
        runOnJS(notifyZoomChange)(true);
      }
    });

  // Single tap to close
  const singleTapGesture = Gesture.Tap()
    .maxDuration(250)
    .requireExternalGestureToFail(doubleTapGesture)
    .onEnd(() => {
      'worklet';
      if (scale.value <= 1) {
        runOnJS(onClose)();
      }
    });

  const tapGestures = Gesture.Exclusive(doubleTapGesture, singleTapGesture);

  const composedGesture = Gesture.Race(
    Gesture.Simultaneous(pinchGesture, panGesture),
    tapGestures
  );

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value + dismissY.value },
      { scale: scale.value * interpolate(dismissProgress.value, [0, 1], [1, 0.9]) },
    ],
  }));

  return (
    <GestureDetector gesture={composedGesture}>
      <Animated.View
        style={[styles.imageContainer, { width, height }]}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onPointerLeave={handlePointerUp}
      >
        <Animated.View style={animatedStyle}>
          <Image
            source={{ uri }}
            style={{ width, height: imageHeight }}
            contentFit="contain"
          />
        </Animated.View>
      </Animated.View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  container: {
    flex: 1,
  },
  closeButton: {
    position: "absolute",
    right: 16,
    zIndex: 10,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "rgba(255, 255, 255, 0.2)",
    alignItems: "center",
    justifyContent: "center",
  },
  imageContainer: {
    justifyContent: "center",
    alignItems: "center",
  },
  pagination: {
    position: "absolute",
    left: 0,
    right: 0,
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: 8,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: "rgba(255, 255, 255, 0.4)",
  },
  dotActive: {
    backgroundColor: "white",
  },
});
