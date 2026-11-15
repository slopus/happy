import type { MarkdownStyleMap } from "@ronradtke/react-native-markdown-display";
import { FitImage as UntypedFitImage } from "@ronradtke/react-native-markdown-display";
import type { ComponentType } from "react";
import { useContext, useState } from "react";
import type { ImageProps } from "react-native";
import { Pressable, Text, View } from "react-native";
import { markRemoteImageLoaded, RemoteImagesContext, remoteImageRenders } from "../markdown";
import { linkHost, NativeLink } from "./links";

// Its declared props extend a type React Native's public API no longer exports.
export const FitImage = UntypedFitImage as ComponentType<ImageProps & { indicator?: boolean }>;

export function LinkedRemoteImage({
  href,
  image,
  alt,
  title,
  styleMap,
}: {
  href: string;
  image: { href: string; host: string };
  alt?: string;
  title?: string;
  styleMap: MarkdownStyleMap;
}) {
  const loadRemote = useContext(RemoteImagesContext);
  const [, setRevision] = useState(0);
  if (remoteImageRenders(image.href, loadRemote, false)) {
    return (
      <NativeLink block href={href} style={styleMap.blocklink}>
        <View style={styleMap.image}>
          <FitImage
            indicator
            style={styleMap._VIEW_SAFE_image}
            source={{ uri: image.href }}
            accessible={Boolean(alt)}
            accessibilityLabel={alt}
          />
        </View>
      </NativeLink>
    );
  }
  return (
    <View style={styleMap.linked_image}>
      <RemoteMarkdownImage
        image={image}
        alt={alt}
        title={title}
        rejectedLink={false}
        labelStyle={styleMap.plain_text}
        styleMap={styleMap}
        onLoad={() => setRevision((revision) => revision + 1)}
      />
      <NativeLink href={href} style={styleMap.link}>
        {linkHost(href)}
      </NativeLink>
    </View>
  );
}

export function RemoteMarkdownImage({
  image,
  alt,
  title,
  insideLink = false,
  rejectedLink,
  labelStyle,
  styleMap,
  onLoad,
}: {
  image: { href: string; host: string };
  alt?: string;
  title?: string;
  insideLink?: boolean;
  rejectedLink: boolean;
  labelStyle: MarkdownStyleMap[string] | undefined;
  styleMap: MarkdownStyleMap;
  onLoad?: () => void;
}) {
  const loadRemote = useContext(RemoteImagesContext);
  // Bumping this redraws after a tap. Whether the image shows is read from the current URL.
  const [, setRevision] = useState(0);
  if (remoteImageRenders(image.href, loadRemote, rejectedLink)) {
    return (
      <FitImage
        indicator
        style={styleMap._VIEW_SAFE_image}
        source={{ uri: image.href }}
        accessible={Boolean(alt)}
        accessibilityLabel={alt}
      />
    );
  }
  if (rejectedLink || insideLink) return <Text style={labelStyle}>{alt || image.host}</Text>;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={alt ? `${alt}, ${image.host}` : image.host}
      accessibilityHint={title}
      // A 32pt chip with 6pt slop on each side keeps the 44pt touch target.
      hitSlop={6}
      onPress={(event) => {
        event.preventDefault();
        event.stopPropagation();
        markRemoteImageLoaded(image.href);
        onLoad?.();
        setRevision((revision) => revision + 1);
      }}
      style={styleMap.image_placeholder}
    >
      <View style={styleMap.image_placeholder_icon} />
      {alt ? (
        <Text numberOfLines={1} style={styleMap.image_placeholder_alt}>
          {alt}
        </Text>
      ) : null}
      <Text numberOfLines={1} style={styleMap.image_placeholder_host}>
        {image.host}
      </Text>
    </Pressable>
  );
}
