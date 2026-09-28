import * as React from 'react';
import { ImageBackground, View, type LayoutChangeEvent } from 'react-native';
import { DREAMSKIN_BACKGROUND_URL } from '@/desktopSkin';
import { useReducedTransparency } from '@/hooks/useReducedTransparency';

type Props = { reading?: boolean; photo?: boolean; readingWidth?: number };

/** A single, inert photo layer per desktop route. It never participates in chat layout. */
export function DesktopSkinCanvas({ reading = false, photo = true, readingWidth = 800 }: Props) {
    const reducedTransparency = useReducedTransparency();
    const [width, setWidth] = React.useState(0);
    const onLayout = React.useCallback((event: LayoutChangeEvent) => {
        const next = Math.round(event.nativeEvent.layout.width);
        setWidth((current) => current === next ? current : next);
    }, []);
    // The session darkens the photograph according to its actual main-pane width.
    // Home keeps the workspace photograph even when the capability panel is open.
    const showAtmosphere = !reducedTransparency && (!reading || width >= 800);
    const compactReading = reading && width < 1180;

    return (
        <View
            pointerEvents="none"
            onLayout={onLayout}
            style={{ position: 'absolute', inset: 0, overflow: 'hidden', backgroundColor: photo || reducedTransparency ? '#13171D' : 'transparent' } as any}
            testID="dreamskin-photo-canvas"
        >
            {photo && showAtmosphere && (
                <ImageBackground
                    source={{ uri: DREAMSKIN_BACKGROUND_URL }}
                    resizeMode="cover"
                    style={{ position: 'absolute', inset: 0 } as any}
                    imageStyle={{ opacity: 0.88 }}
                    testID="dreamskin-photo"
                />
            )}
            {photo && <View style={{ position: 'absolute', inset: 0, backgroundImage: showAtmosphere
                ? 'linear-gradient(90deg, rgba(13,17,23,.50) 0%, rgba(13,17,23,.34) 51%, rgba(13,17,23,.10) 100%)'
                : reducedTransparency ? 'none' : 'linear-gradient(135deg, #151B22, #1D252E)', backgroundColor: reducedTransparency ? '#13171D' : 'transparent' } as any} />}
            {reading && (
                <View
                    style={{ alignSelf: 'center', backgroundColor: reducedTransparency ? '#151A21' : !showAtmosphere ? 'rgba(21,26,33,0.92)' : compactReading ? 'rgba(21,26,33,0.70)' : 'rgba(21,26,33,0.51)', borderRadius: 18, height: '100%', maxWidth: readingWidth + 250, width: '100%' }}
                    testID="dreamskin-reading-surface"
                />
            )}
        </View>
    );
}
