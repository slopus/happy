import * as React from 'react';
import { View } from 'react-native';
import type { FileDocument } from './controller';

/** Binary archives share the same tabs, refresh, download and version identity as text files. */
export function WorkspaceMediaPreview({ media, name }: { media: NonNullable<FileDocument['media']>; name: string }) {
    const [url, setUrl] = React.useState('');
    React.useEffect(() => {
        const value = URL.createObjectURL(new Blob([media.bytes as BlobPart], { type: media.mime }));
        setUrl(value);
        return () => URL.revokeObjectURL(value);
    }, [media]);
    if (!url) return null;
    return <View style={{ flex: 1, minHeight: 0, alignItems: 'center', justifyContent: 'center', padding: 12 }} testID="workspace-media-preview">
        {media.mime.startsWith('image/') ? <img src={url} alt={name} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
            : media.mime.startsWith('audio/') ? <audio controls src={url} aria-label={name} style={{ width: '100%' }} />
                : media.mime.startsWith('video/') ? <video controls src={url} aria-label={name} style={{ maxWidth: '100%', maxHeight: '100%' }} />
                    : <iframe title={name} src={url} style={{ width: '100%', height: '100%', border: 0 }} />}
    </View>;
}
