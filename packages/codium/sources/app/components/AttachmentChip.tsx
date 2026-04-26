import { useEffect, useState } from 'react'
import './AttachmentChip.css'

export interface Attachment {
    path: string
    name: string
    ext: string
}

const IMAGE_EXTS = new Set([
    'png',
    'jpg',
    'jpeg',
    'gif',
    'webp',
    'svg',
    'heic',
])

interface AttachmentChipProps {
    attachment: Attachment
    onRemove?: (path: string) => void
}

function FileIcon() {
    return (
        <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
            <path d="M14 2v6h6" />
        </svg>
    )
}

function FolderIcon() {
    return (
        <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
        </svg>
    )
}

function CloseIcon() {
    return (
        <svg
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
        </svg>
    )
}

export function AttachmentChip({ attachment, onRemove }: AttachmentChipProps) {
    const isImage = IMAGE_EXTS.has(attachment.ext)
    const isFolder = attachment.ext === 'folder' || attachment.ext === 'project'
    const [thumb, setThumb] = useState<string | null>(null)

    useEffect(() => {
        if (!isImage || !window.files) return
        let cancelled = false
        window.files.readDataUrl(attachment.path).then((url) => {
            if (!cancelled) setThumb(url)
        })
        return () => {
            cancelled = true
        }
    }, [attachment.path, isImage])

    return (
        <div
            className={
                isImage ? 'attachment-chip attachment-chip--image' : 'attachment-chip'
            }
            title={attachment.path}
        >
            <div className="attachment-chip__preview">
                {isImage && thumb ? (
                    <img src={thumb} alt={attachment.name} />
                ) : isFolder ? (
                    <FolderIcon />
                ) : (
                    <FileIcon />
                )}
            </div>
            <div className="attachment-chip__meta">
                <div className="attachment-chip__name">{attachment.name}</div>
                {!isImage && attachment.ext && (
                    <div className="attachment-chip__ext">
                        {isFolder ? attachment.ext : `.${attachment.ext}`}
                    </div>
                )}
            </div>
            {onRemove && (
                <button
                    type="button"
                    className="attachment-chip__close"
                    aria-label={`Remove ${attachment.name}`}
                    onClick={() => onRemove(attachment.path)}
                >
                    <CloseIcon />
                </button>
            )}
        </div>
    )
}
