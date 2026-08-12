import * as React from 'react';
import { View } from 'react-native';
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

    const frameStyle = props.kind === 'audio'
        ? { width: 300, maxWidth: '100%' as const, height: 64, backgroundColor: '#000' }
        : {
            width: '100%' as const,
            maxWidth: 960,
            aspectRatio: props.aspectRatio ?? 16 / 9,
            backgroundColor: '#000',
            position: 'relative' as const,
            borderRadius: 12,
            overflow: 'hidden' as const,
        };
    return (
        <View testID={props.testID} style={frameStyle}>
            {source ? React.createElement(props.kind === 'audio' ? 'audio' : 'video', {
                ref: videoRef,
                src: source,
                controls: true,
                playsInline: true,
                preload: 'metadata',
                poster: props.posterUri,
                title: props.title,
                style: { width: '100%', height: '100%', backgroundColor: '#000', objectFit: 'contain', borderRadius: 12 },
            }) : null}
        </View>
    );
}
