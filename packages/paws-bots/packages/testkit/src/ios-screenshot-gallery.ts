export interface IosGalleryShot {
  name: string;
  src: string;
}

export interface IosGallerySection {
  id: string;
  title: string;
  shots: IosGalleryShot[];
}

export function renderIosScreenshotGallery(sections: IosGallerySection[]): string {
  const sidebar = sections
    .map(
      (section) =>
        `<a href="#${escapeHtml(section.id)}">${escapeHtml(section.title)} <span>${section.shots.length}</span></a>`,
    )
    .join("");
  const body = sections
    .map((section) => {
      const shots =
        section.shots.length === 0
          ? `<p class="missing">No screenshots captured.</p>`
          : section.shots
              .map(
                (shot) => `<figure data-name="${escapeHtml(shot.name.toLowerCase())}">
        <button type="button" data-src="${escapeHtml(shot.src)}" data-alt="${escapeHtml(shot.name)}">
          <img src="${escapeHtml(shot.src)}" alt="${escapeHtml(shot.name)}" />
        </button>
        <figcaption>${escapeHtml(shot.name)}</figcaption>
      </figure>`,
              )
              .join("");
      return `<section id="${escapeHtml(section.id)}">
      <h2>${escapeHtml(section.title)}</h2>
      <div class="grid">${shots}</div>
    </section>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Rakazo iOS screenshots</title>
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body { margin: 0; font: 15px/1.4 system-ui, sans-serif; }
    .layout { display: flex; align-items: flex-start; min-height: 100vh; }
    aside { position: sticky; top: 0; width: 220px; height: 100vh; overflow: auto; padding: 20px 16px; border-right: 1px solid #ddd; }
    aside input { width: 100%; margin: 12px 0; padding: 8px; }
    aside a { display: flex; justify-content: space-between; padding: 6px 0; color: inherit; text-decoration: none; }
    main { flex: 1; padding: 24px; }
    section { margin-bottom: 32px; }
    h2 { margin: 0 0 12px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 16px; }
    figure { margin: 0; }
    figure button { display: block; width: 100%; padding: 0; border: 0; background: transparent; cursor: zoom-in; }
    img { width: 100%; height: auto; border-radius: 8px; background: #eee; }
    figcaption { margin-top: 6px; font-size: 13px; word-break: break-word; }
    figure.is-hidden, section.is-hidden { display: none; }
    dialog { width: min(480px, 92vw); border: 0; padding: 12px; background: transparent; }
    dialog img { width: 100%; height: auto; border-radius: 12px; }
    dialog::backdrop { background: rgba(0, 0, 0, 0.72); }
  </style>
</head>
<body>
  <div class="layout">
    <aside>
      <strong>Sections</strong>
      <input id="filter" type="search" placeholder="Filter screenshot names" autocomplete="off" />
      <nav>${sidebar}</nav>
    </aside>
    <main>${body}</main>
  </div>
  <dialog id="lightbox"><img id="lightbox-img" alt="" /></dialog>
  <script>
    const filter = document.querySelector("#filter");
    const dialog = document.querySelector("#lightbox");
    const lightbox = document.querySelector("#lightbox-img");
    filter.addEventListener("input", () => {
      const query = filter.value.trim().toLowerCase();
      for (const section of document.querySelectorAll("main section")) {
        let visible = 0;
        for (const figure of section.querySelectorAll("figure")) {
          const match = !query || figure.dataset.name.includes(query);
          figure.classList.toggle("is-hidden", !match);
          if (match) visible += 1;
        }
        section.classList.toggle("is-hidden", query.length > 0 && visible === 0);
      }
    });
    for (const button of document.querySelectorAll("figure button")) {
      button.addEventListener("click", () => {
        lightbox.src = button.dataset.src;
        lightbox.alt = button.dataset.alt || "";
        dialog.showModal();
      });
    }
    dialog.addEventListener("click", () => dialog.close());
  </script>
</body>
</html>
`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
