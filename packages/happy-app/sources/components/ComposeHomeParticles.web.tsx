import * as React from 'react';
import { View, StyleSheet } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

/**
 * ComposeHomeParticles 的 Web 降级实现。
 *
 * Web 入口不加载 CanvasKit（上游在 fbef7ecc 里明确停用了 LoadSkiaWeb，全局 Skia
 * 为 undefined），任何在 web 挂载 Skia <Canvas> 的组件都会在 Reanimated mapper 里
 * 抛 "Cannot read properties of undefined (reading 'PictureRecorder')"。因此本文件
 * 遵循代码库约定（AvatarSkia.web / QRCode.web）：用纯 2D canvas 复刻原生版的
 * curl 噪声流场蜂群，视觉一致，不依赖 Skia / Reanimated。
 *
 * 与原生版的差异：无重力感应（web 无加速度计，原生版在无传感器时也退回纯流场），
 * 辉光用 canvas shadowBlur 近似 Skia BlurMask。运动模型（噪声、参数、配色槽位）
 * 与 ComposeHomeParticles.tsx 保持同一套常量，改动时两边同步。
 */

// —— 蜂群规模与铺开范围（与原生版一致）——
const GREEN_COUNT = 96;
const BLUE_COUNT = 54;
const HOME_R_MIN = 18;
const HOME_R_SPAN = 220;

// —— curl 噪声流场参数（与原生版一致）——
const NOISE_SCALE = 0.0065;
const FLOW_TIME = 0.22;
const FLOW_AMP = 340;
const NOISE_EPS = 0.8;

interface ParticleCfg {
    homeX: number;
    homeY: number;
}

// 确定性伪随机，保证每次渲染同一团形态（与原生版同 seed 同形态）。
function buildConfigs(count: number, seed: number): ParticleCfg[] {
    const cfgs: ParticleCfg[] = [];
    let s = seed;
    const rnd = () => {
        s = (s * 16807) % 2147483647;
        return s / 2147483647;
    };
    const TAU = Math.PI * 2;
    for (let i = 0; i < count; i++) {
        const radius = HOME_R_MIN + rnd() * HOME_R_SPAN;
        const angle = rnd() * TAU;
        cfgs.push({
            homeX: Math.cos(angle) * radius,
            homeY: Math.sin(angle) * radius,
        });
    }
    return cfgs;
}

// 3D 值噪声（哈希角点 + 三线性平滑插值），第三维喂时间。
function hash3(ix: number, iy: number, iz: number) {
    const n = ix * 127.1 + iy * 311.7 + iz * 74.7;
    const s = Math.sin(n) * 43758.5453123;
    return s - Math.floor(s);
}

function vnoise(x: number, y: number, z: number) {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const iz = Math.floor(z);
    const fx = x - ix;
    const fy = y - iy;
    const fz = z - iz;
    const ux = fx * fx * (3 - 2 * fx);
    const uy = fy * fy * (3 - 2 * fy);
    const uz = fz * fz * (3 - 2 * fz);
    const c000 = hash3(ix, iy, iz);
    const c100 = hash3(ix + 1, iy, iz);
    const c010 = hash3(ix, iy + 1, iz);
    const c110 = hash3(ix + 1, iy + 1, iz);
    const c001 = hash3(ix, iy, iz + 1);
    const c101 = hash3(ix + 1, iy, iz + 1);
    const c011 = hash3(ix, iy + 1, iz + 1);
    const c111 = hash3(ix + 1, iy + 1, iz + 1);
    const x00 = c000 + (c100 - c000) * ux;
    const x10 = c010 + (c110 - c010) * ux;
    const x01 = c001 + (c101 - c001) * ux;
    const x11 = c011 + (c111 - c011) * ux;
    const y0 = x00 + (x10 - x00) * uy;
    const y1 = x01 + (x11 - x01) * uy;
    return y0 + (y1 - y0) * uz;
}

type ParticleMode = 'dark' | 'light';

const PALETTE: Record<ParticleMode, { glow: number; opacity: number }> = {
    dark: { glow: 6, opacity: 0.9 },
    light: { glow: 0, opacity: 0.82 },
};

interface Props {
    mode: ParticleMode;
}

interface Layer {
    cfgs: ParticleCfg[];
    color: string;
    radius: number;
    noiseOffsetX: number;
    noiseOffsetY: number;
}

// The field changes slowly, so 30fps preserves its ambient character while
// halving the main-thread noise and draw work compared with an uncapped rAF.
const WEB_FRAME_INTERVAL = 1000 / 30;
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

export const ComposeHomeParticles = React.memo(({ mode }: Props) => {
    const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
    const { theme } = useUnistyles();
    const green = theme.colors.particle.primary;
    const blue = theme.colors.particle.accent;

    React.useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const pal = PALETTE[mode];
        const layers: Layer[] = [
            { cfgs: buildConfigs(GREEN_COUNT, 1337), color: green, radius: 1.5, noiseOffsetX: 0, noiseOffsetY: 0 },
            // 蓝色用错开的噪声坐标，避免和绿色完全同向（与原生版一致）。
            { cfgs: buildConfigs(BLUE_COUNT, 8081), color: blue, radius: 1.3, noiseOffsetX: 31.7, noiseOffsetY: 17.3 },
        ];

        let w = 0;
        let h = 0;
        let raf = 0;
        let lastFrameAt = Number.NEGATIVE_INFINITY;
        let documentVisible = !document.hidden;
        const motionQuery = window.matchMedia(REDUCED_MOTION_QUERY);
        let reduceMotion = motionQuery.matches;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);

        const TAU = Math.PI * 2;
        const draw = (now: number) => {
            if (w === 0 || h === 0) return;
            const t = now * 0.0017;
            const tz = t * FLOW_TIME;
            const cx0 = w * 0.5;
            const cy0 = h * 0.46;
            ctx.clearRect(0, 0, w, h);
            ctx.globalAlpha = pal.opacity;
            ctx.shadowBlur = pal.glow > 0 ? pal.glow * 2 : 0;
            for (const layer of layers) {
                ctx.fillStyle = layer.color;
                ctx.shadowColor = pal.glow > 0 ? layer.color : 'transparent';
                ctx.beginPath();
                for (let i = 0; i < layer.cfgs.length; i++) {
                    const p = layer.cfgs[i];
                    const homeX = cx0 + p.homeX;
                    const homeY = cy0 + p.homeY;
                    const nx = homeX * NOISE_SCALE + layer.noiseOffsetX;
                    const ny = homeY * NOISE_SCALE + layer.noiseOffsetY;
                    const p0 = vnoise(nx, ny, tz);
                    const pdx = vnoise(nx + NOISE_EPS, ny, tz);
                    const pdy = vnoise(nx, ny + NOISE_EPS, tz);
                    const x = homeX + (pdy - p0) * FLOW_AMP;
                    const y = homeY - (pdx - p0) * FLOW_AMP;
                    ctx.moveTo(x + layer.radius, y);
                    ctx.arc(x, y, layer.radius, 0, TAU);
                }
                ctx.fill();
            }
        };

        const resize = () => {
            const rect = canvas.getBoundingClientRect();
            w = rect.width;
            h = rect.height;
            canvas.width = Math.max(1, Math.round(w * dpr));
            canvas.height = Math.max(1, Math.round(h * dpr));
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            if (reduceMotion) draw(0);
        };
        const ro = new ResizeObserver(resize);
        ro.observe(canvas);

        const frame = (now: number) => {
            raf = requestAnimationFrame(frame);
            if (!documentVisible || reduceMotion || now - lastFrameAt < WEB_FRAME_INTERVAL) return;
            lastFrameAt = now;
            draw(now);
        };

        const refreshAnimation = () => {
            cancelAnimationFrame(raf);
            if (!documentVisible || reduceMotion) {
                if (reduceMotion) draw(0);
                return;
            }
            lastFrameAt = Number.NEGATIVE_INFINITY;
            raf = requestAnimationFrame(frame);
        };
        const handleVisibilityChange = () => {
            documentVisible = !document.hidden;
            refreshAnimation();
        };
        const handleMotionPreferenceChange = (event: MediaQueryListEvent) => {
            reduceMotion = event.matches;
            refreshAnimation();
        };

        document.addEventListener('visibilitychange', handleVisibilityChange);
        motionQuery.addEventListener('change', handleMotionPreferenceChange);
        resize();
        refreshAnimation();

        return () => {
            cancelAnimationFrame(raf);
            ro.disconnect();
            document.removeEventListener('visibilitychange', handleVisibilityChange);
            motionQuery.removeEventListener('change', handleMotionPreferenceChange);
        };
    }, [mode, green, blue]);

    return (
        <View style={[StyleSheet.absoluteFill, { pointerEvents: 'none' }]}>
            <canvas ref={canvasRef} style={{ width: '100%', height: '100%' }} />
        </View>
    );
});

ComposeHomeParticles.displayName = 'ComposeHomeParticles';
