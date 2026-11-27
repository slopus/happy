import { Fragment, type ReactNode, useCallback, useId } from 'react';
import { getAssetUrls } from '@tldraw/assets/selfHosted';
import { DefaultStylePanel, ImageShapeUtil, Tldraw as UpstreamTldraw, TldrawUiPopover, TldrawUiPopoverContent, TldrawUiPopoverTrigger, useEditor, useValue,
    type Editor, type TLAssetId, type TLImageShape, type TldrawProps, type TLUiStylePanelProps } from 'tldraw';
import { currentSync } from './bridge';
import { attachProjectEditor, projectShapeVisibility } from './editor';
import { ProjectCanvasReview } from './ProjectCanvasReview';

export * from 'tldraw';

const assetUrls = getAssetUrls({ baseUrl: new URL('./assets/', document.baseURI).href });

function ProjectImageBitmap({ assetId, children }: { assetId: TLAssetId | null; children: ReactNode }) {
    const editor = useEditor();
    const quality = useValue('project image display quality',
        () => assetId === null ? undefined : editor.getAsset(assetId)?.meta.pawsDisplayQuality,
        [assetId, editor],
    );
    // Same-ID image updates normally wait on the SDK's editor ticks. A
    // promotion can finish while focus remains on the Paws asset panel.
    return <Fragment key={quality === 'original' ? 'original' : 'preview'}>{children}</Fragment>;
}

class ProjectImageShapeUtil extends ImageShapeUtil {
    override component(shape: TLImageShape) {
        return <ProjectImageBitmap assetId={shape.props.assetId}>{super.component(shape)}</ProjectImageBitmap>;
    }
}

function CanvasStylePanel(props: TLUiStylePanelProps) {
    const editor = useEditor();
    const mode = useValue('paws canvas style panel', () => {
        if (editor.isIn('select.crop')) return 'hidden';
        if (!editor.isIn('select')) return 'drawing';
        const shapes = editor.getSelectedShapes();
        if (!shapes.length) return 'hidden';
        return shapes.every(shape => shape.type === 'image') ? shapes.map(shape => shape.id).join('|') : 'drawing';
    }, [editor]);
    if (props.isMobile || mode === 'drawing') return <DefaultStylePanel {...props} />;
    if (mode === 'hidden') return null;
    return <ImageStylePopover key={mode} {...props} />;
}

function ImageStylePopover(props: TLUiStylePanelProps) {
    const id = useId();
    const english = currentSync()?.locale === 'en';
    return <TldrawUiPopover id={`paws-image-style-${id}`} className="paws-image-style">
        <TldrawUiPopoverTrigger>
            <button type="button" className="paws-image-style-toggle" data-testid="paws-image-style-toggle"
                aria-label={english ? 'Image style' : '图片样式'}>
                {english ? 'Style' : '样式'}
            </button>
        </TldrawUiPopoverTrigger>
        <TldrawUiPopoverContent side="bottom" align="end" collisionPadding={8}>
            <DefaultStylePanel {...props} isMobile />
        </TldrawUiPopoverContent>
    </TldrawUiPopover>;
}

/** Adds the Paws project scope while keeping the upstream canvas and toolbar mounted. */
const projectShapeUtils = [ProjectImageShapeUtil];

export function Tldraw({ components, onMount, ...props }: Extract<TldrawProps, { store?: undefined }>) {
    const scope = currentSync()?.sessionKey;
    const mount = useCallback((editor: Editor) => {
        const stopUpstream = onMount?.(editor);
        const stopPaws = scope ? attachProjectEditor(editor, scope) : undefined;
        return () => {
            stopPaws?.();
            stopUpstream?.();
        };
    }, [scope, onMount]);
    return <UpstreamTldraw {...props} shapeUtils={projectShapeUtils} assetUrls={assetUrls}
        components={{ ...components, StylePanel: CanvasStylePanel, InFrontOfTheCanvas: ProjectCanvasReview }}
        getShapeVisibility={projectShapeVisibility} persistenceKey={scope ? `paws-dsh-image-canvas:1:${scope}` : undefined} onMount={mount} />;
}
