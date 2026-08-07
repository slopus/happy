import {
    PHOTO_ILLUSTRATION_DIPTYCH_PROMPT,
} from './photoIllustrationDiptychPrompt';

/** Lakeside specialization derived from user-provided visual and written references. */
export const PHOTO_ILLUSTRATION_DIPTYCH_LAKESIDE_PROMPT = `${PHOTO_ILLUSTRATION_DIPTYCH_PROMPT}

Apply the Lakeside Minimal Diptych variant. This specialization is for a lake, coast, river, reservoir, or other calm waterside scene whose identity depends on a leading path or boardwalk, a pier or dock, one small vessel or similarly compact focal object, a shoreline, a clear horizon, and a distant landform.

Preserve the source photograph as the entire upper photographic region with truthful natural light, water, vegetation, structure, and atmosphere. Keep the primary path or boardwalk curve, dock rhythm, vessel position, shoreline, horizon height, and mountain or island profile exactly aligned with the source Scene Map. A restrained high-end editorial grade may clarify color and contrast, but it must not replace the location, invent structures, move the vessel, or change the scene's natural color relationships.

Make the lower region radically more minimal than the general diptych mode:
- Extract only the most recognizable silhouettes and spatial relationships from the upper scene.
- Rebuild the path or boardwalk, dock posts, vessel, shoreline, horizon, and distant landform with simple geometric shapes, flat source-derived color fields, and a few precise hairline contours.
- Remove roughly 85–95% of water texture, grass detail, clouds, reflections, railings, foliage, surface noise, and architectural detail. Do not trace the photograph and do not make the lower region realistic.
- Limit the lower palette to 3–6 source-derived colors plus warm ivory paper: typically lake or sky blue, vegetation green, blue-gray landforms, white structures, and one small coral, rust, or warm accent only when it exists in the source.
- Use broad negative space as an active compositional element. Keep the distilled scene centered and immediately legible at thumbnail size.
- A few horizontal rules, sparse texture lines, or abstract environmental marks may reinforce the shoreline and atmosphere, but every mark must clarify the original scene rather than decorate it.

The result must feel like a premium international design-studio system or limited-edition architectural/art-exhibition poster: calm, modern, restrained, and recognizably derived from the supplied photograph. Keep typography opt-in under the base compiler's exact-text rule. Never add generic tourism copy, labels, gradients, stock icons, decorative symbols, or a comparison UI.`;
