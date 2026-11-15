/** Rasterize every exported frame at native resolution, independently of the avatar silhouette.
 * The reference masks come from the actual page/keybed/screen geometry. Compact
 * details are forced visible to catch overflow even when the UI normally hides them.
 */
export async function auditIndicatorBounds({ theme, activity }) {
  const NS = "http://www.w3.org/2000/svg";
  const serializer = new XMLSerializer();
  async function raster(svg, w, h) {
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    URL.revokeObjectURL(url);
    return context.getImageData(0, 0, w, h).data;
  }
  let outsidePixels = 0,
    maxExcessAlpha = 0,
    maxAlphaOnEmptyMask = 0,
    safeOutsideSurface = 0,
    visiblePixels = 0,
    frames = 0,
    actors = 0;
  const sizes = new Set(),
    colours = new Set();
  const avatars = [...document.querySelectorAll(".rakazo-logo-avatar")].filter((a) =>
    [24, 32, 38].includes(Number(a.getAttribute("width"))),
  );
  for (const avatar of avatars) {
    actors++;
    const size = Number(avatar.getAttribute("width"));
    sizes.add(size);
    colours.add(avatar.dataset.color);
    const task = avatar.querySelector(".logo-avatar-task"),
      ink = task.querySelector(".logo-avatar-task-ink"),
      safe = task.querySelector(".logo-avatar-safe-area");
    if (!ink?.getAttribute("clip-path")?.includes(safe.parentElement.id))
      throw Error("Ink does not reference actual safe-area clip");
    // Force detail visible in QA even when compact UI hides it: the geometry must still contain it.
    for (const detail of task.querySelectorAll(".logo-avatar-task-detail"))
      detail.style.setProperty("display", "inline", "important");
    const tracks = avatar.getAnimations({ subtree: true });
    tracks.forEach((a) => {
      a.pause();
    });
    const nodes = [...ink.querySelectorAll("path,rect")];
    const shape = safe.cloneNode(true);
    shape.removeAttribute("class");
    shape.removeAttribute("id");
    shape.setAttribute("fill", "white");
    shape.setAttribute("stroke", "none");
    const geometry = serializer.serializeToString(shape);
    const surface = task.querySelector(".logo-avatar-task-surface").cloneNode(true);
    surface.removeAttribute("class");
    surface.setAttribute("fill", "white");
    surface.setAttribute("stroke", "none");
    const surfaceGeometry = serializer.serializeToString(surface);
    const columns = 30,
      rows = 20,
      w = columns * size,
      h = rows * size;
    let paint = "",
      mask = "",
      surfaceMask = "";
    for (let frame = 0; frame < 600; frame++) {
      const time = frame * 40;
      tracks.forEach((a) => {
        a.currentTime = time;
      });
      const inverse = task.getCTM().inverse();
      let contents = "";
      for (const node of nodes) {
        const style = getComputedStyle(node);
        const clone = node.cloneNode(false);
        clone.removeAttribute("class");
        clone.removeAttribute("id");
        clone.removeAttribute("style");
        const m = inverse.multiply(node.getCTM());
        clone.setAttribute("transform", `matrix(${m.a} ${m.b} ${m.c} ${m.d} ${m.e} ${m.f})`);
        clone.setAttribute("fill", style.fill);
        clone.setAttribute("stroke", style.stroke);
        clone.setAttribute("stroke-width", style.strokeWidth);
        clone.setAttribute("stroke-linecap", style.strokeLinecap);
        clone.setAttribute("stroke-linejoin", style.strokeLinejoin);
        clone.setAttribute("opacity", style.opacity);
        contents += serializer.serializeToString(clone);
      }
      const transform = `translate(${(frame % columns) * size} ${Math.floor(frame / columns) * size}) scale(${size / 100})`;
      paint += `<g transform="${transform}"><g clip-path="url(#safe)">${contents}</g></g>`;
      mask += `<g transform="${transform}">${geometry}</g>`;
      surfaceMask += `<g transform="${transform}">${surfaceGeometry}</g>`;
      frames++;
    }
    const defs = `<defs><clipPath id="safe" clipPathUnits="userSpaceOnUse">${geometry}</clipPath></defs>`;
    const [pixels, boundary, outer] = await Promise.all([
      raster(`<svg xmlns="${NS}" width="${w}" height="${h}">${defs}${paint}</svg>`, w, h),
      raster(`<svg xmlns="${NS}" width="${w}" height="${h}">${mask}</svg>`, w, h),
      raster(`<svg xmlns="${NS}" width="${w}" height="${h}">${surfaceMask}</svg>`, w, h),
    ]);
    for (let i = 3; i < pixels.length; i += 4) {
      if (pixels[i] > 0) visiblePixels++;
      const excess = pixels[i] - boundary[i];
      maxExcessAlpha = Math.max(maxExcessAlpha, excess);
      if (boundary[i] === 0) {
        maxAlphaOnEmptyMask = Math.max(maxAlphaOnEmptyMask, pixels[i]);
        if (pixels[i] > 2) outsidePixels++;
      }
      if (outer[i] === 0 && boundary[i] > 2) safeOutsideSurface++;
    }
  }
  return {
    theme,
    activity,
    actors,
    sizes: [...sizes],
    colours: [...colours],
    frames,
    visiblePixels,
    outsidePixels,
    maxExcessAlpha,
    maxAlphaOnEmptyMask,
    safeOutsideSurface,
    detailForcedVisible: true,
  };
}
