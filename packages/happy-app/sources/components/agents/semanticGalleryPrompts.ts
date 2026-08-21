const SHARED_INPUT_RULES = `Accept either a short text idea or one current-request JPEG or PNG. If an image is provided, preserve the recognizable subject, core geometry, color relationships, and emotional tone while changing only the visual treatment and layout. If text is provided, invent a fictional, unbranded subject that demonstrates the format clearly. Never scan prior messages or local folders for source material. Avoid real logos, real campaign marks, watermarks, QR codes, timestamps, dense unreadable copy, duplicated subjects, broken anatomy, and clutter.`;

export const VINTAGE_FILM_EDITORIAL_PROMPT = `${SHARED_INPUT_RULES}

Create one nostalgic 35mm editorial photograph with a quiet café or studio atmosphere. Use a truthful main subject, cinematic crop, shallow depth of field, restrained warm film color, gentle highlight halation, realistic surface texture, subtle grain, and soft background falloff. Preserve source-scene details that establish identity, but remove incidental digital clutter. Keep the result observational and editorial rather than an advertisement. No added readable text, brand marks, extra hands, or unrelated props.`;

export const PRODUCT_TVC_STORYBOARD_PROMPT = `${SHARED_INPUT_RULES}

Create one polished 6-frame product-commercial storyboard arranged as a clean 3×2 contact sheet. Keep one consistent fictional product or supplied subject across every frame. Use this shot progression: atmospheric establishing frame, tactile material close-up, controlled hero reveal, functional interaction or transformation, premium packshot, and quiet end frame with negative space. Maintain consistent art direction, lighting, palette, lens language, and object geometry across panels. Use thin dividers and at most tiny neutral shot labels; no real logo, slogan, pricing, or fabricated claims.`;

export const CINEMATIC_STORYBOARD_PROMPT = `${SHARED_INPUT_RULES}

Create one 3×3 cinematic storyboard contact sheet for a coherent short scene. Preserve the same subject, location, time of day, wardrobe or object identity, and color grade across all nine panels. Progress from establishing shot through medium action, expressive close-ups, environmental inserts, a turning point, and a resolved final wide shot. Vary shot size and angle intentionally while maintaining screen direction and continuity. Use restrained film-still rendering, thin dividers, and no dialogue text, captions, logos, or watermarks.`;

export const VINTAGE_EDITORIAL_INFOGRAPHIC_PROMPT = `${SHARED_INPUT_RULES}

Create one vertical vintage editorial infographic that explains the supplied topic through a dominant hero illustration or photograph, 4–6 compact fact modules, one simple sequence or comparison, and a restrained legend. Use warm ivory paper, muted archival inks, fine rules, small serif headlines, mono annotation text, halftone or letterpress texture, and generous margins. Facts must come only from the user's wording; when data is absent, use clearly non-numeric placeholder structures rather than inventing statistics. Keep typography sparse and legible. No real masthead, brand, barcode, fake citation, or dense paragraph.`;

export const CHARACTER_MERCH_BOARD_PROMPT = `${SHARED_INPUT_RULES}

Create one editorial merchandise concept board for a single consistent fictional character or supplied subject. Show a hero character view plus coordinated applications such as a plush, enamel pin, sticker sheet, mug, tote, phone wallpaper, postcard, and acrylic charm. Preserve the same silhouette, facial cues, palette, line language, and key identifying detail across every application. Arrange the board as a refined catalog with ample breathing room and tiny neutral labels only. No real brand, trademarked character, pricing, store UI, production claim, or watermark.`;

export const BENTO_MEMORY_CARD_PROMPT = `${SHARED_INPUT_RULES}

Create one warm bento-grid memory card with 7–8 rounded modules. Include one large hero module, two truthful detail crops or illustrated echoes, a compact source-derived color palette, one material or environment texture, one small icon, and two quiet note modules. Use an editorial-newsroom-meets-diary aesthetic, generous spacing, consistent corner radii, soft paper or matte surfaces, and minimal fictional placeholder wording. The result should preserve a specific memory and visual hierarchy rather than resemble a generic dashboard. No real names, dates, location claims, app chrome, brand marks, or dense text.`;
