import * as React from "react";
import { Modal, View, Pressable, FlatList, useWindowDimensions } from "react-native";
import { Image } from "expo-image";
import { StyleSheet } from "react-native-unistyles";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";

export type ImageViewerImage = {
  uri: string;
};

type Props = {
  images: ImageViewerImage[];
  visible: boolean;
  initialIndex?: number;
  onClose: () => void;
};

export function ImageViewer({ images, visible, initialIndex = 0, onClose }: Props) {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const flatListRef = React.useRef<FlatList>(null);
  const [currentIndex, setCurrentIndex] = React.useState(initialIndex);

  React.useEffect(() => {
    if (visible && flatListRef.current && images.length > 0) {
      const safeIndex = Math.min(initialIndex, images.length - 1);
      flatListRef.current.scrollToIndex({ index: safeIndex, animated: false });
      setCurrentIndex(safeIndex);
    }
  }, [visible, initialIndex, images.length]);

  const renderItem = React.useCallback(({ item }: { item: ImageViewerImage }) => (
    <Pressable
      style={{ width, height, justifyContent: "center", alignItems: "center" }}
      onPress={onClose}
    >
      <Image
        source={{ uri: item.uri }}
        style={{ width, height: height * 0.8 }}
        contentFit="contain"
      />
    </Pressable>
  ), [onClose, width, height]);

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

  if (!visible) return null;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <View style={styles.container}>
        <Pressable
          style={[styles.closeButton, { top: insets.top + 16 }]}
          onPress={onClose}
        >
          <Ionicons name="close" size={28} color="white" />
        </Pressable>

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
          style={{ flex: 1 }}
        />

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
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.95)",
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
