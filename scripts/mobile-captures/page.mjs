import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root } from './paths.mjs';

export async function pageHTML(config, inputDirectory) {
  const load = name => readFile(join(root, 'web', name), 'utf8');
  const shared = await load('cards.js') + await load('shader.js');
  const sourceRoot = pathToFileURL(inputDirectory + '/').href;
  const init = `const CONFIG = ${JSON.stringify(config)};
    function screenSource(device, name) {
      return device === CONFIG.row ? ${JSON.stringify(sourceRoot)} + name + '.' + CONFIG.extension
        : 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    }`;
  let html = (await load(config.template + '.html'))
    .replace('{{BASE}}', pathToFileURL(root).href)
    .replaceAll('frames/', '.cache/frames/')
    .replace('{{SHARED}}', init + shared)
    .replace('{{PAINT}}', await load('paint.js'));
  if (config.tabletWidth) {
    html = html.replace('</style>', `
      .card.android { aspect-ratio: 5 / 8 !important; }
      .android .phone { width: ${config.tabletWidth}cqw; aspect-ratio: 5 / 8; }
      .android .screen { left: 0; top: 0; width: 100%; height: 100%; border-radius: 2.5%; }
      .android .back, .android .mask { display: none; }
      </style>`);
  }
  return html;
}

export async function settle(page, config, card = 1) {
  await page.evaluate(async config => {
    await document.fonts.ready;
    await Promise.all([...document.images].map(image => image.decode()));
    fit();
    if (config.fitPixel) {
      for (const phone of document.querySelectorAll('.android .phone')) {
        const card = phone.closest('.card').getBoundingClientRect();
        const rect = phone.getBoundingClientRect();
        const room = card.bottom - rect.top - card.width * .02;
        if (rect.height > room) phone.style.width = room * 1198 / 2531 + 'px';
      }
    }
    window.paint(config.shaderTime);
  }, { ...config, shaderTime: card === 1 ? config.heroTime ?? 20 : 20 });
}

export async function geometry(page) {
  return page.evaluate(() => {
    const card = document.querySelector('.row.on .slot:not(.away) .card, .row.on > .card:not(.away)');
    const rect = element => {
      const r = element.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    return { card: rect(card), copy: rect(card.querySelector('.copy')),
      device: rect(card.querySelector('.phone, .device')), screen: rect(card.querySelector('.screen')) };
  });
}