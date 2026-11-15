// Frames carry the page's run id, so every submission names the task run it belongs to.
for (const frame of document.querySelectorAll("iframe[data-src]")) {
  frame.src = frame.dataset.src + location.search;
}
