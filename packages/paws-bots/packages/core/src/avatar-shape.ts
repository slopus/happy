type AvatarPoint = readonly [number, number];

let organicAvatarTemplates: readonly (readonly AvatarPoint[])[] | undefined;

export function avatarIdentitySeed(identity: string): number {
  let hash = 0;
  for (let index = 0; index < identity.length; index++) {
    hash = (hash << 5) - hash + identity.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash);
}

/** Two eyes of one size, placed by their centres in the avatar's own view box. */
export interface AvatarEyes {
  readonly width: number;
  readonly height: number;
  readonly leftCx: number;
  readonly rightCx: number;
  readonly cy: number;
}

/** The pair as fully rounded bars, the face every organic and shipped-shape avatar wears. */
export function avatarEyeRects(eyes: AvatarEyes) {
  return [eyes.leftCx, eyes.rightCx].map((cx) => ({
    x: cx - eyes.width / 2,
    y: eyes.cy - eyes.height / 2,
    width: eyes.width,
    height: eyes.height,
    rx: eyes.width / 2,
  }));
}

export const ORGANIC_AVATAR_VIEWBOX = "-60 -60 120 120";

export const ORGANIC_AVATAR_EYES: AvatarEyes = {
  width: 7,
  height: 24,
  leftCx: -10.5,
  rightCx: 10.5,
  cy: 0,
};

/** Degrees the organic face leans, so bots sharing a body still differ. */
export function organicAvatarEyeTilt(seed: number): number {
  return (seed % 9) - 4;
}

/** Organic bodies come in this many families; the seed picks one. */
export const ORGANIC_AVATAR_FAMILY_COUNT = 10;

/** The body with two upper lobes, a central notch and a pointed bottom. */
export const ORGANIC_AVATAR_HEART_FAMILY = 6;

/** The organic body family every client draws for this identity (a bot's id). */
export function organicAvatarFamily(identity: string): number {
  return avatarIdentitySeed(identity) % ORGANIC_AVATAR_FAMILY_COUNT;
}

/** Families 2 and 8 are both round blobs, so they count as one look when telling bots apart. */
export function organicAvatarLook(family: number): number {
  return family === 8 ? 2 : family;
}

/** The distinct organic bodies a new bot can get: every look except the heart. */
export const ORGANIC_AVATAR_LOOKS: readonly number[] = [
  ...new Set(
    Array.from({ length: ORGANIC_AVATAR_FAMILY_COUNT }, (_, family) => family)
      .filter((family) => family !== ORGANIC_AVATAR_HEART_FAMILY)
      .map(organicAvatarLook),
  ),
];

/** A stable identity whose organic body is the given family, for previews before a bot has an id. */
export function organicAvatarSampleIdentity(family: number): string {
  for (let index = 0; ; index++) {
    const identity = `look-${family}-${index}`;
    if (organicAvatarFamily(identity) === family) return identity;
  }
}

export function organicAvatarPath(seed: number, phaseOffset = 0): string {
  const phase = ((seed % 360) * Math.PI) / 180 + phaseOffset;
  const family = seed % ORGANIC_AVATAR_FAMILY_COUNT;
  if (!organicAvatarTemplates) {
    organicAvatarTemplates = [
      [
        [-43, 22],
        [-51, 16],
        [-53, 6],
        [-49, -4],
        [-40, -12],
        [-30, -13],
        [-27, -24],
        [-18, -34],
        [-6, -36],
        [4, -32],
        [12, -42],
        [25, -45],
        [37, -38],
        [43, -27],
        [42, -17],
        [51, -11],
        [56, 0],
        [54, 12],
        [46, 20],
        [30, 24],
        [0, 25],
        [-29, 25],
      ],
      [
        [0, -52],
        [12, -35],
        [28, -17],
        [39, 2],
        [42, 21],
        [34, 38],
        [19, 49],
        [0, 52],
        [-19, 49],
        [-34, 38],
        [-42, 21],
        [-39, 2],
        [-28, -17],
        [-12, -35],
      ],
      [
        [-42, -23],
        [-27, -40],
        [-7, -46],
        [14, -40],
        [33, -27],
        [46, -8],
        [46, 14],
        [35, 34],
        [14, 46],
        [-8, 46],
        [-29, 38],
        [-43, 21],
        [-48, 0],
      ],
      Array.from({ length: 40 }, (_, index) => {
        const angle = (index / 40) * Math.PI * 2;
        const radius = 44 + Math.cos(angle * 5) * 5;
        return [Math.cos(angle) * radius, Math.sin(angle) * radius];
      }),
      Array.from({ length: 36 }, (_, index) => {
        const angle = (index / 36) * Math.PI * 2;
        const radius = 43 + Math.cos(angle * 6) * 7;
        return [Math.cos(angle) * radius, Math.sin(angle) * radius];
      }),
      Array.from({ length: 32 }, (_, index) => {
        const angle = (index / 32) * Math.PI * 2;
        const x = Math.cos(angle);
        const y = Math.sin(angle);
        return [
          Math.sign(x) * Math.sqrt(Math.abs(x)) * 46,
          Math.sign(y) * Math.sqrt(Math.abs(y)) * 43,
        ];
      }),
      [
        [0, 48],
        [-14, 36],
        [-32, 20],
        [-45, 0],
        [-43, -20],
        [-29, -36],
        [-10, -39],
        [0, -27],
        [10, -39],
        [29, -36],
        [43, -20],
        [45, 0],
        [32, 20],
        [14, 36],
      ],
      [
        [-48, 35],
        [-38, 22],
        [-34, -8],
        [-27, -31],
        [-12, -44],
        [0, -48],
        [12, -44],
        [27, -31],
        [34, -8],
        [38, 22],
        [48, 35],
        [26, 42],
        [0, 44],
        [-26, 42],
      ],
      [
        [-45, -19],
        [-28, -38],
        [-4, -46],
        [22, -41],
        [42, -25],
        [49, -2],
        [42, 23],
        [22, 42],
        [-4, 47],
        [-29, 38],
        [-46, 18],
        [-50, 0],
      ],
      [
        [-50, 0],
        [-45, -20],
        [-30, -38],
        [0, -48],
        [30, -38],
        [45, -20],
        [50, 0],
        [35, 10],
        [18, 12],
        [16, 38],
        [0, 46],
        [-16, 38],
        [-18, 12],
        [-35, 10],
      ],
    ] as const;
  }
  const templates = organicAvatarTemplates;
  const xScale = 1 + Math.sin(phase) * 0.035;
  const yScale = 1 + Math.cos(phase) * 0.025;
  const shear = Math.sin(phase * 1.7) * 0.025;
  let points = (templates[family] ?? templates[5]!).map(([x, y]) => ({
    x: x * xScale + y * shear,
    y: y * yScale,
  }));
  const smoothingPasses = family >= 3 && family <= 5 ? 1 : 2;
  for (let pass = 0; pass < smoothingPasses; pass++) {
    points = points.flatMap((point, index) => {
      const next = points[(index + 1) % points.length]!;
      return [
        { x: point.x * 0.75 + next.x * 0.25, y: point.y * 0.75 + next.y * 0.25 },
        { x: point.x * 0.25 + next.x * 0.75, y: point.y * 0.25 + next.y * 0.75 },
      ];
    });
  }
  const pointCount = points.length;
  const round = (value: number) => Math.round(value * 100) / 100;
  const first = points[0]!;
  let path = `M${round(first.x)} ${round(first.y)}`;
  for (let index = 0; index < pointCount; index++) {
    const before = points[(index - 1 + pointCount) % pointCount]!;
    const current = points[index]!;
    const next = points[(index + 1) % pointCount]!;
    const after = points[(index + 2) % pointCount]!;
    path += `C${round(current.x + (next.x - before.x) / 6)} ${round(current.y + (next.y - before.y) / 6)} ${round(next.x - (after.x - current.x) / 6)} ${round(next.y - (after.y - current.y) / 6)} ${round(next.x)} ${round(next.y)}`;
  }
  return `${path}Z`;
}
