export interface LocalImage {
    uri: string;
    width: number;
    height: number;
    mimeType: string;
}

export interface ImagePreviewProps {
    images: LocalImage[];
    onRemove: (index: number) => void;
    maxImages?: number;
    disabled?: boolean;
}
