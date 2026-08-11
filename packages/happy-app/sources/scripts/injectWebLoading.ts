/**
 * Injects a first-paint loading placeholder into the web build's index.html.
 *
 * The web target uses `web.output: "single"` (SPA), so Expo ignores body
 * customisations in app/+html.tsx. This placeholder is rendered before the
 * application bundle executes and removes itself as soon as React mounts.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { ACCENTS, THEME_PACK_IDS, type ThemePackId } from '../themePacksData';

const ROOT_ANCHOR = '<div id="root"></div>';
const LOADER_ID = 'id="app-loading"';
const PARTICLE_COUNT = 36;
const LOOP_DURATION_SECONDS = 4.4;
const TRAIL_SPAN = 0.36;
const DEFAULT_THEME_PACK: ThemePackId = 'caramel';
const THEME_PREFERENCES = ['light', 'dark', 'adaptive'] as const;
const DEFAULT_ACCENT = ACCENTS.find((accent) => accent.id === DEFAULT_THEME_PACK) ?? ACCENTS[0];

type ThemePreference = typeof THEME_PREFERENCES[number];
export type LoadingThemeName = `${ThemePackId}Light` | `${ThemePackId}Dark`;

export function resolveLoadingThemeName(
    localSettingsRaw: string | null | undefined,
    prefersDark: boolean,
): LoadingThemeName {
    let themePreference: ThemePreference = 'adaptive';
    let themePack: ThemePackId = DEFAULT_THEME_PACK;

    if (localSettingsRaw) {
        try {
            const settings: unknown = JSON.parse(localSettingsRaw);
            if (settings && typeof settings === 'object' && !Array.isArray(settings)) {
                const candidate = settings as Record<string, unknown>;
                if (THEME_PREFERENCES.includes(candidate.themePreference as ThemePreference)) {
                    themePreference = candidate.themePreference as ThemePreference;
                }
                if (THEME_PACK_IDS.includes(candidate.themePack as ThemePackId)) {
                    themePack = candidate.themePack as ThemePackId;
                }
            }
        } catch {
            // Corrupt settings should not prevent the first-paint placeholder.
        }
    }

    const isDark = themePreference === 'dark'
        || (themePreference === 'adaptive' && prefersDark);
    return `${themePack}${isDark ? 'Dark' : 'Light'}`;
}

function buildThemeBootstrap(): string {
    const themePacks = JSON.stringify(THEME_PACK_IDS);
    const themePreferences = JSON.stringify(THEME_PREFERENCES);

    return `<script id="app-loading-theme-bootstrap">(()=>{let p="adaptive",t="caramel",d=false;try{d=window.matchMedia("(prefers-color-scheme: dark)").matches}catch{}try{const s=JSON.parse(localStorage.getItem("mmkv.default\\\\local-settings")||"{}");if(${themePreferences}.includes(s.themePreference))p=s.themePreference;if(${themePacks}.includes(s.themePack))t=s.themePack}catch{}document.documentElement.dataset.pawsLoaderTheme=t+((p==="dark"||(p==="adaptive"&&d))?"Dark":"Light")})()</script>`;
}

function buildThemeStyles(): string {
    return ACCENTS.flatMap((accent) => (
        (['light', 'dark'] as const).map((modeName) => {
            const mode = accent[modeName];
            const themeName = `${accent.id}${modeName === 'dark' ? 'Dark' : 'Light'}`;
            return `      html[data-paws-loader-theme="${themeName}"] #app-loading {
        --app-loading-bg: ${mode.bg};
        --app-loading-fg: ${mode.text};
        --app-loading-particle-a: ${mode.particleA};
        --app-loading-particle-b: ${mode.particleB};
      }`;
        })
    )).join('\n');
}

export function buildLissajousPath(steps = 180): string {
    return Array.from({ length: steps + 1 }, (_, index) => {
        const angle = (index / steps) * Math.PI * 2;
        const x = 50 + 28 * Math.sin(3 * angle + Math.PI / 2);
        const y = 50 + 24 * Math.sin(4 * angle);
        return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`;
    }).join(' ');
}

function buildParticles(): string {
    return Array.from({ length: PARTICLE_COUNT }, (_, index) => {
        const trailPosition = index / (PARTICLE_COUNT - 1);
        const strength = Math.pow(1 - trailPosition, 0.7);
        const radius = 0.7 + strength * 2.15;
        const opacity = 0.04 + strength * 0.96;
        const offset = trailPosition * TRAIL_SPAN * LOOP_DURATION_SECONDS;

        return `        <circle r="${radius.toFixed(2)}" opacity="${opacity.toFixed(3)}">
          <animateMotion dur="${LOOP_DURATION_SECONDS}s" begin="-${offset.toFixed(3)}s" repeatCount="indefinite" calcMode="linear">
            <mpath href="#app-loading-curve" />
          </animateMotion>
        </circle>`;
    }).join('\n');
}

export function createLoadingPlaceholder(): string {
    const curvePath = buildLissajousPath();
    const particles = buildParticles();
    const themeBootstrap = buildThemeBootstrap();
    const themeStyles = buildThemeStyles();

    return `
    <div id="app-loading" role="progressbar" aria-label="Paws">
      <svg id="app-loading-orbit" viewBox="0 0 100 100" aria-hidden="true" focusable="false">
        <defs>
          <path id="app-loading-curve" d="${curvePath}" />
        </defs>
        <g id="app-loading-motion">
          <use id="app-loading-track" href="#app-loading-curve" />
          <g id="app-loading-particles">
${particles}
          </g>
        </g>
      </svg>
    </div>
    ${themeBootstrap}
    <style id="app-loading-style">
      #app-loading {
        --app-loading-bg: ${DEFAULT_ACCENT.dark.bg};
        --app-loading-fg: ${DEFAULT_ACCENT.dark.text};
        --app-loading-particle-a: ${DEFAULT_ACCENT.dark.particleA};
        --app-loading-particle-b: ${DEFAULT_ACCENT.dark.particleB};
        position: fixed;
        inset: 0;
        z-index: 9999;
        display: grid;
        place-items: center;
        overflow: hidden;
        background: var(--app-loading-bg);
        color: var(--app-loading-fg);
      }
${themeStyles}
      #app-loading-orbit {
        width: clamp(116px, 17vmin, 164px);
        aspect-ratio: 1;
        overflow: visible;
        animation: app-loading-breathe 4.8s ease-in-out infinite;
      }
      #app-loading-motion {
        transform-box: fill-box;
        transform-origin: center;
        animation: app-loading-turn 24s linear infinite;
      }
      #app-loading-track {
        fill: none;
        stroke: currentColor;
        opacity: 0.09;
        stroke-width: 1.25;
        stroke-linecap: round;
        stroke-linejoin: round;
      }
      #app-loading-particles { fill: var(--app-loading-particle-a); }
      #app-loading-particles circle:first-child { fill: var(--app-loading-particle-b); }
      @keyframes app-loading-turn { to { transform: rotate(-360deg); } }
      @keyframes app-loading-breathe {
        0%, 100% { transform: scale(0.96); opacity: 0.88; }
        50% { transform: scale(1.04); opacity: 1; }
      }
      @media (prefers-color-scheme: light) {
        #app-loading {
          --app-loading-bg: ${DEFAULT_ACCENT.light.bg};
          --app-loading-fg: ${DEFAULT_ACCENT.light.text};
          --app-loading-particle-a: ${DEFAULT_ACCENT.light.particleA};
          --app-loading-particle-b: ${DEFAULT_ACCENT.light.particleB};
        }
      }
      @media (prefers-reduced-motion: reduce) {
        #app-loading-orbit, #app-loading-motion { animation: none; }
        #app-loading-particles { display: none; }
        #app-loading-track { stroke-width: 2; stroke: currentColor; opacity: 0.34; }
      }
      #root:not(:empty) ~ #app-loading { display: none; }
    </style>`;
}

export function injectWebLoading(html: string): string {
    if (html.includes(LOADER_ID)) {
        return html;
    }

    if (!html.includes(ROOT_ANCHOR)) {
        throw new Error(`could not find the ${ROOT_ANCHOR} anchor in index.html.`);
    }

    return html.replace(ROOT_ANCHOR, ROOT_ANCHOR + createLoadingPlaceholder());
}

function main(): void {
    const indexPath = join(process.cwd(), 'dist', 'index.html');

    if (!existsSync(indexPath)) {
        console.error(`[injectWebLoading] ${indexPath} not found. Run "expo export --platform web" first.`);
        process.exitCode = 1;
        return;
    }

    const html = readFileSync(indexPath, 'utf8');
    if (html.includes(LOADER_ID)) {
        console.log('[injectWebLoading] placeholder already present, skipping.');
        return;
    }

    try {
        writeFileSync(indexPath, injectWebLoading(html), 'utf8');
        console.log('[injectWebLoading] injected first-paint loading placeholder into dist/index.html.');
    } catch (error) {
        console.error(`[injectWebLoading] ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
    main();
}
