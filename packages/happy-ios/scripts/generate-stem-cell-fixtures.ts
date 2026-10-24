// Writes the stem cell geometry the desktop draws for a fixed set of IDs, so
// the Swift port can be pinned against it.
//
//   bun scripts/generate-stem-cell-fixtures.ts <happy-desktop-ui/src/stemCellGeometry.ts>
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const source = process.argv[2];
if (!source) throw new Error("usage: generate-stem-cell-fixtures.ts <stemCellGeometry.ts>");
const { stemCellGeometry, stemCellSmoothPath } = await import(resolve(source));

const ids = [
    "a",
    "lxn0wiutbtax5w7a42n1cuy4",
    "h3eepbcreh2mq7xw2tsthfp3",
    "s3k8m2q9w1e5r7y3u6i0o2p4",
    "zzzzzzzzzzzzzzzzzzzzzzzz",
    "stem-cell",
    "ünïcödé-✓",
    ...Array.from({ length: 10 }, (_, i) => `cell${i * 7919}x${(i * 104729) % 1000}`),
];
const cases = ids.flatMap((id) =>
    [0, 0.2, -0.2].map((drift) => {
        const shape = stemCellGeometry(id, drift);
        return { id, drift, membrane: shape.membrane, core: shape.core, ...(drift === 0 ? { path20: stemCellSmoothPath(shape.membrane, 20) } : {}) };
    }),
);
const out = resolve(import.meta.dir, "../Tests/HappyLayoutTests/Fixtures/stem-cell-geometry.json");
writeFileSync(out, JSON.stringify(cases));
console.log(`wrote ${cases.length} cases to ${out}`);
