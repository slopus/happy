import { expect, it } from "vitest";
import { LOGO_BODY_PATH } from "./logo-avatar-art.js";

type Point = [number, number];
type Segment = [Point, Point, Point, Point];

it("keeps the body contour smooth through cubic joins and across its crown", () => {
  const numbers = (part: string) => [...part.matchAll(/-?\d+(?:\.\d+)?/g)].map(([n]) => Number(n));
  const point = (values: number[], offset = 0): Point => [
    values[offset] ?? NaN,
    values[offset + 1] ?? NaN,
  ];
  let start = point(numbers(LOGO_BODY_PATH.split("C")[0] ?? ""));
  const segments = [...LOGO_BODY_PATH.matchAll(/C([^CLHZ]+)/g)].map<Segment>(([, part]) => {
    const values = numbers(part ?? "");
    const points: Segment = [start, point(values), point(values, 2), point(values, 4)];
    start = points[3];
    return points;
  });
  expect(segments.length).toBeLessThanOrEqual(12);
  for (const [index, segment] of segments.entries()) {
    for (const p of segment) expect(p.every(Number.isFinite)).toBe(true);
    const previous = segments[index - 1];
    if (!previous) continue;
    const [, b, c, d] = previous;
    const [e, f, g] = segment;
    for (const axis of [0, 1] as const) {
      // Rounding path coordinates must not create visible kinks.
      expect(Math.abs(3 * (d[axis] - c[axis]) - 3 * (f[axis] - e[axis]))).toBeLessThan(0.01);
      expect(
        Math.abs(6 * (d[axis] - 2 * c[axis] + b[axis]) - 6 * (g[axis] - 2 * f[axis] + e[axis])),
      ).toBeLessThan(0.025);
    }
  }
  for (const [a, b, c, d] of segments)
    for (let step = 0; step <= 50; step++) {
      const t = step / 50;
      const y =
        (1 - t) ** 3 * a[1] +
        3 * (1 - t) ** 2 * t * b[1] +
        3 * (1 - t) * t ** 2 * c[1] +
        t ** 3 * d[1];
      if (y >= 12) continue;
      const velocity = (i: 0 | 1) =>
        3 * (1 - t) ** 2 * (b[i] - a[i]) +
        6 * (1 - t) * t * (c[i] - b[i]) +
        3 * t ** 2 * (d[i] - c[i]);
      const acceleration = (i: 0 | 1) =>
        6 * (1 - t) * (c[i] - 2 * b[i] + a[i]) + 6 * t * (d[i] - 2 * c[i] + b[i]);
      const curvature =
        (velocity(0) * acceleration(1) - velocity(1) * acceleration(0)) /
        Math.hypot(velocity(0), velocity(1)) ** 3;
      // The logo has a broad, convex dome rather than a pointed cap.
      expect(curvature).toBeGreaterThan(0);
      expect(curvature).toBeLessThan(0.08);
    }
});
