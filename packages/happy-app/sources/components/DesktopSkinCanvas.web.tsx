import * as React from 'react';
import { ImageBackground, View, type LayoutChangeEvent } from 'react-native';
import { desktopSkinBackgroundUrl, type DesktopSkinId } from '@/desktopSkin';
import { useReducedTransparency } from '@/hooks/useReducedTransparency';
import { useUnistyles } from 'react-native-unistyles';

type Props = { reading?: boolean; photo?: boolean; readingWidth?: number; skin: DesktopSkinId };

/** A single, inert photo layer per desktop route. It never participates in chat layout. */
export function DesktopSkinCanvas({ reading = false, photo = true, readingWidth = 800, skin }: Props) {
    const reducedTransparency = useReducedTransparency();
    const { theme } = useUnistyles();
    const [width, setWidth] = React.useState(0);
    const onLayout = React.useCallback((event: LayoutChangeEvent) => {
        const next = Math.round(event.nativeEvent.layout.width);
        setWidth((current) => current === next ? current : next);
    }, []);
    // The session darkens the photograph according to its actual main-pane width.
    // Home keeps the workspace photograph even when the capability panel is open.
    const showAtmosphere = !reducedTransparency && (!reading || width >= 800);
    const compactReading = reading && width < 1180;
    const warmNight = skin === 'warmNight';
    const surface = theme.colors.desktopSkin;
    const readingSurface = reducedTransparency ? surface.readingSolid : !showAtmosphere
        ? surface.readingHidden : compactReading ? surface.readingCompact : surface.readingWide;

    return (
        <View
            pointerEvents="none"
            onLayout={onLayout}
            style={{ position: 'absolute', inset: 0, overflow: 'hidden', backgroundColor: photo || reducedTransparency ? surface.canvas : 'transparent' } as any}
            testID="dreamskin-photo-canvas"
        >
            {photo && showAtmosphere && (
                <ImageBackground
                    source={{ uri: desktopSkinBackgroundUrl(skin) ?? '' }}
                    resizeMode="cover"
                    style={{ position: 'absolute', inset: 0 } as any}
                    imageStyle={{ opacity: 0.88 }}
                    testID="dreamskin-photo"
                />
            )}
            {photo && <View style={{ position: 'absolute', inset: 0, backgroundImage: showAtmosphere
                ? warmNight
                    ? 'linear-gradient(90deg, rgba(23,21,26,.58) 0%, rgba(23,21,26,.43) 51%, rgba(23,21,26,.30) 100%)'
                    : 'linear-gradient(90deg, rgba(13,17,23,.50) 0%, rgba(13,17,23,.34) 51%, rgba(13,17,23,.10) 100%)'
                : reducedTransparency ? 'none' : warmNight ? 'linear-gradient(135deg, #17151A, #302B30)' : 'linear-gradient(135deg, #151B22, #1D252E)', backgroundColor: reducedTransparency ? surface.canvas : 'transparent' } as any} />}
            {reading && (
                <View
                    style={{ alignSelf: 'center', backgroundColor: readingSurface, borderRadius: 18, height: '100%', maxWidth: readingWidth + 250, width: '100%' }}
                    testID="dreamskin-reading-surface"
                />
            )}
        </View>
    );
}
