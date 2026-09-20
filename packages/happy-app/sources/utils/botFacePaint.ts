import { ImageFormat, Skia } from '@shopify/react-native-skia';

import { BOT_FACE_PAINT_SIZE, botFaceSvg } from './botFace';

/** A painted face, in the one encoding the daemon accepts from here. */
export type BotFacePainting = {
    readonly mimeType: 'image/png';
    readonly bytes: Uint8Array;
};

/**
 * Paints a seed's face as PNG bytes.
 *
 * The daemon stores raster pictures only, so the SVG is drawn onto an offscreen
 * Skia surface here, off the React tree: nothing has to be mounted or visible
 * for a face to be painted, which is what lets it happen while the bot is being
 * made. The painting is the same size the desktop paints.
 */
export async function paintBotFace(seed: string): Promise<BotFacePainting> {
    const size = BOT_FACE_PAINT_SIZE;
    const svg = Skia.SVG.MakeFromString(botFaceSvg(seed, size));
    if (!svg) throw new Error('The face could not be painted.');
    const surface = Skia.Surface.MakeOffscreen(size, size);
    if (!surface) throw new Error('The face could not be painted.');
    const canvas = surface.getCanvas();
    canvas.clear(Skia.Color('transparent'));
    canvas.drawSvg(svg, size, size);
    surface.flush();
    const snapshot = surface.makeImageSnapshot();
    // A GPU-backed snapshot is read back to CPU memory before it is encoded.
    const image = snapshot.makeNonTextureImage() ?? snapshot;
    const bytes = image.encodeToBytes(ImageFormat.PNG, 100);
    if (bytes.length === 0) throw new Error('The face could not be painted.');
    return { mimeType: 'image/png', bytes };
}
