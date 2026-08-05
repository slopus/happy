import * as React from 'react';
import { Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { t } from '@/text';
import type { MediaAttachmentPlayerProps } from './MediaAttachmentPlayer.types';

export function MediaAttachmentPlayer(props: MediaAttachmentPlayerProps) {
    const [source, setSource] = React.useState(() => (
        Object.keys(props.headers).length === 0 ? props.uri : null
    ));
    const videoRef = React.useRef<HTMLVideoElement | null>(null);

    React.useEffect(() => {
        if (Object.keys(props.headers).length === 0) {
            setSource(props.uri);
            return;
        }

        let cancelled = false;
        let objectUrl: string | null = null;
        const controller = new AbortController();
        setSource(null);
        void fetch(props.uri, { headers: props.headers, signal: controller.signal })
            .then((response) => {
                if (!response.ok) throw new Error(`media download failed: ${response.status}`);
                return response.arrayBuffer();
            })
            .then((buffer) => {
                if (cancelled) return;
                objectUrl = URL.createObjectURL(new Blob([buffer], { type: props.mimeType }));
                setSource(objectUrl);
            })
            .catch((error: unknown) => {
                if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) return;
                if (!cancelled) setSource(null);
            });

        return () => {
            cancelled = true;
            controller.abort();
            if (objectUrl) URL.revokeObjectURL(objectUrl);
        };
    }, [props.headers, props.mimeType, props.uri]);

    const enterFullscreen = React.useCallback(() => {
        void videoRef.current?.requestFullscreen?.();
    }, []);

    const height = props.kind === 'audio' ? 64 : 180;
    return (
        <View testID={props.testID} style={{ width: 300, height, backgroundColor: '#000', position: 'relative' }}>
            {source ? React.createElement(props.kind === 'audio' ? 'audio' : 'video', {
                ref: videoRef,
                src: source,
                controls: true,
                playsInline: true,
                preload: 'metadata',
                title: props.title,
                style: { width: '100%', height: '100%', backgroundColor: '#000' },
            }) : null}
            {props.kind === 'video' && source ? (
                <Pressable
                    testID={`${props.testID}-fullscreen`}
                    accessibilityRole="button"
                    accessibilityLabel={t('imageUpload.mediaFullscreen', { name: props.title })}
                    onPress={enterFullscreen}
                    style={({ pressed }) => ({
                        position: 'absolute',
                        top: 8,
                        right: 8,
                        width: 34,
                        height: 34,
                        borderRadius: 17,
                        alignItems: 'center',
                        justifyContent: 'center',
                        backgroundColor: 'rgba(0, 0, 0, 0.62)',
                        opacity: pressed ? 0.7 : 1,
                    })}
                >
                    <Ionicons name="expand" size={19} color="#fff" />
                </Pressable>
            ) : null}
        </View>
    );
}
