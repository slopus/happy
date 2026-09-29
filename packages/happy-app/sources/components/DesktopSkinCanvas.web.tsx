import * as React from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import { desktopSkinBackgroundPosition, desktopSkinBackgroundUrl, photoDesktopSkin, type DesktopSkinId } from '@/desktopSkin';
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
    const visual = photoDesktopSkin(skin);
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
                <View
                    style={{ position: 'absolute', inset: 0, opacity: visual?.photoOpacity ?? 0.88,
                        backgroundImage: `url("${desktopSkinBackgroundUrl(skin)}")`, backgroundSize: 'cover',
                        backgroundPosition: desktopSkinBackgroundPosition(skin), backgroundRepeat: 'no-repeat',
                    } as any}
                    testID="dreamskin-photo"
                />
            )}
            {photo && <View style={{ position: 'absolute', inset: 0,
                backgroundImage: showAtmosphere ? visual?.photoScrim : reducedTransparency ? 'none' : visual?.photoFallback,
                backgroundColor: reducedTransparency || !showAtmosphere ? surface.canvas : 'transparent',
            } as any} />}
            {reading && (
                <View
                    style={{ alignSelf: 'center', backgroundColor: readingSurface, borderRadius: 18, height: '100%', maxWidth: readingWidth + 250, width: '100%' }}
                    testID="dreamskin-reading-surface"
                />
            )}
        </View>
    );
}
