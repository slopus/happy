# Avatar placeholder provenance

These 200 pictures are what someone, an account, an agent connection, a bot
or a task with no picture of its own wears (`AvatarPlaceholder` picks one by
its ID). They are the avatars on the front page of
https://shaders.craftedstudios.co, rendered by that page's own still exporter
(`toBlob` of [@craftedstudios/shaders](https://www.npmjs.com/package/@craftedstudios/shaders)
1.0.1, one frame at each seed's phase, square, 1024px) on 2026-10-30, scaled to
384px and encoded as WebP at quality 80. Nothing was redrawn.

`scripts/generate-avatar-placeholders.mjs` makes them again. The page is a wall
of five effects with 40 seeds each, and the files keep its order.

@craftedstudios/shaders is MIT licensed, Copyright (c) 2026 Crafted Studios.
Its license asks that the notice go with copies of substantial portions of
the software, so `LICENSE-craftedstudios-shaders.txt` beside this file is the
package's own and travels with the pictures. The site states no other terms.

With Animated Avatars on (Settings › Appearance) the same placeholders move.
`Sources/HappyUI/Components/AvatarShaderSource.swift` is the package's avatar
shader (`src/shader.js`) ported to Metal, and
`Sources/HappyLayout/AvatarShaderTable.swift` holds what it draws each picture
with, made by the package's own `resolve` and `angleOf` for the seed and effect
below (`scripts/generate-avatar-shader-table.mjs`). Both are under the same MIT
license. At its phase the shader draws the picture's own frame.

| File | Seed | Effect |
| --- | --- | --- |
| `avatar-placeholder-001.webp` | `0b7ttho` | linear |
| `avatar-placeholder-002.webp` | `0fg4o7x` | linear |
| `avatar-placeholder-003.webp` | `1m1r0rs` | linear |
| `avatar-placeholder-004.webp` | `1i71fx4` | linear |
| `avatar-placeholder-005.webp` | `0o1erfx` | linear |
| `avatar-placeholder-006.webp` | `15z12br` | linear |
| `avatar-placeholder-007.webp` | `1dbqndc` | linear |
| `avatar-placeholder-008.webp` | `14jbwk2` | linear |
| `avatar-placeholder-009.webp` | `08h1mbb` | linear |
| `avatar-placeholder-010.webp` | `0uphsra` | linear |
| `avatar-placeholder-011.webp` | `0s36r1d` | linear |
| `avatar-placeholder-012.webp` | `0p309tb` | linear |
| `avatar-placeholder-013.webp` | `05enf2f` | linear |
| `avatar-placeholder-014.webp` | `1cg0ru6` | linear |
| `avatar-placeholder-015.webp` | `19j6poq` | linear |
| `avatar-placeholder-016.webp` | `04sstbs` | linear |
| `avatar-placeholder-017.webp` | `0072n7j` | linear |
| `avatar-placeholder-018.webp` | `06zh0k7` | linear |
| `avatar-placeholder-019.webp` | `04axc1g` | linear |
| `avatar-placeholder-020.webp` | `1yad9ae` | linear |
| `avatar-placeholder-021.webp` | `1yem8bp` | linear |
| `avatar-placeholder-022.webp` | `1qhbqau` | linear |
| `avatar-placeholder-023.webp` | `0q4vvla` | linear |
| `avatar-placeholder-024.webp` | `1feo3qw` | linear |
| `avatar-placeholder-025.webp` | `0qli410` | linear |
| `avatar-placeholder-026.webp` | `1xyjz52` | linear |
| `avatar-placeholder-027.webp` | `0kali99` | linear |
| `avatar-placeholder-028.webp` | `08i95v2` | linear |
| `avatar-placeholder-029.webp` | `15olitb` | linear |
| `avatar-placeholder-030.webp` | `0jmqpun` | linear |
| `avatar-placeholder-031.webp` | `0muae6v` | linear |
| `avatar-placeholder-032.webp` | `1vgaj9h` | linear |
| `avatar-placeholder-033.webp` | `0qzpj10` | linear |
| `avatar-placeholder-034.webp` | `11ulejg` | linear |
| `avatar-placeholder-035.webp` | `0jkcarj` | linear |
| `avatar-placeholder-036.webp` | `1e4y6vr` | linear |
| `avatar-placeholder-037.webp` | `0wud0it` | linear |
| `avatar-placeholder-038.webp` | `00fdq4f` | linear |
| `avatar-placeholder-039.webp` | `0mtogdc` | linear |
| `avatar-placeholder-040.webp` | `0kgblxm` | linear |
| `avatar-placeholder-041.webp` | `0ecwfje` | radial |
| `avatar-placeholder-042.webp` | `0z3hzdo` | radial |
| `avatar-placeholder-043.webp` | `1wrzjs9` | radial |
| `avatar-placeholder-044.webp` | `1k0l34b` | radial |
| `avatar-placeholder-045.webp` | `1x8vwas` | radial |
| `avatar-placeholder-046.webp` | `0tpelqh` | radial |
| `avatar-placeholder-047.webp` | `0b0nfkx` | radial |
| `avatar-placeholder-048.webp` | `086c6vj` | radial |
| `avatar-placeholder-049.webp` | `1bgyyt5` | radial |
| `avatar-placeholder-050.webp` | `07svkyy` | radial |
| `avatar-placeholder-051.webp` | `0mv5r4z` | radial |
| `avatar-placeholder-052.webp` | `1veaap3` | radial |
| `avatar-placeholder-053.webp` | `0cxrqd7` | radial |
| `avatar-placeholder-054.webp` | `188kvd1` | radial |
| `avatar-placeholder-055.webp` | `1y32msd` | radial |
| `avatar-placeholder-056.webp` | `06bgtv5` | radial |
| `avatar-placeholder-057.webp` | `1qwpb0w` | radial |
| `avatar-placeholder-058.webp` | `1kj5eyc` | radial |
| `avatar-placeholder-059.webp` | `14qch0o` | radial |
| `avatar-placeholder-060.webp` | `13k4nko` | radial |
| `avatar-placeholder-061.webp` | `1z0qq2q` | radial |
| `avatar-placeholder-062.webp` | `1ryry6n` | radial |
| `avatar-placeholder-063.webp` | `1a88ffx` | radial |
| `avatar-placeholder-064.webp` | `1v5gxi1` | radial |
| `avatar-placeholder-065.webp` | `1ty8mw7` | radial |
| `avatar-placeholder-066.webp` | `0p57c47` | radial |
| `avatar-placeholder-067.webp` | `1tb5dts` | radial |
| `avatar-placeholder-068.webp` | `0icudwj` | radial |
| `avatar-placeholder-069.webp` | `1ay84w7` | radial |
| `avatar-placeholder-070.webp` | `1g7te58` | radial |
| `avatar-placeholder-071.webp` | `0ija41q` | radial |
| `avatar-placeholder-072.webp` | `1fx8ydk` | radial |
| `avatar-placeholder-073.webp` | `0kv1tm2` | radial |
| `avatar-placeholder-074.webp` | `1ubmwts` | radial |
| `avatar-placeholder-075.webp` | `0j5pcmp` | radial |
| `avatar-placeholder-076.webp` | `0lk4t2h` | radial |
| `avatar-placeholder-077.webp` | `0etvsib` | radial |
| `avatar-placeholder-078.webp` | `0to3hew` | radial |
| `avatar-placeholder-079.webp` | `0cxvm71` | radial |
| `avatar-placeholder-080.webp` | `0719v7r` | radial |
| `avatar-placeholder-081.webp` | `0xbl1q7` | thermal |
| `avatar-placeholder-082.webp` | `1sodzoj` | thermal |
| `avatar-placeholder-083.webp` | `1sl67j4` | thermal |
| `avatar-placeholder-084.webp` | `084fqg4` | thermal |
| `avatar-placeholder-085.webp` | `1khn0h7` | thermal |
| `avatar-placeholder-086.webp` | `06ilxiy` | thermal |
| `avatar-placeholder-087.webp` | `1c218lc` | thermal |
| `avatar-placeholder-088.webp` | `04wbcbb` | thermal |
| `avatar-placeholder-089.webp` | `05io4iz` | thermal |
| `avatar-placeholder-090.webp` | `0ao1e19` | thermal |
| `avatar-placeholder-091.webp` | `12znf6x` | thermal |
| `avatar-placeholder-092.webp` | `0tbsfu7` | thermal |
| `avatar-placeholder-093.webp` | `1k8volm` | thermal |
| `avatar-placeholder-094.webp` | `14cr7zg` | thermal |
| `avatar-placeholder-095.webp` | `1hg8zf3` | thermal |
| `avatar-placeholder-096.webp` | `1qif401` | thermal |
| `avatar-placeholder-097.webp` | `011ku1p` | thermal |
| `avatar-placeholder-098.webp` | `19jywoo` | thermal |
| `avatar-placeholder-099.webp` | `09iymg8` | thermal |
| `avatar-placeholder-100.webp` | `1x1zzdd` | thermal |
| `avatar-placeholder-101.webp` | `01oo2mu` | thermal |
| `avatar-placeholder-102.webp` | `1wl2fr6` | thermal |
| `avatar-placeholder-103.webp` | `1qw05n9` | thermal |
| `avatar-placeholder-104.webp` | `0u9wxij` | thermal |
| `avatar-placeholder-105.webp` | `0hf0ahw` | thermal |
| `avatar-placeholder-106.webp` | `1vbnae2` | thermal |
| `avatar-placeholder-107.webp` | `0gnwunr` | thermal |
| `avatar-placeholder-108.webp` | `1tljb5y` | thermal |
| `avatar-placeholder-109.webp` | `1id23tr` | thermal |
| `avatar-placeholder-110.webp` | `0dd489d` | thermal |
| `avatar-placeholder-111.webp` | `012bp7t` | thermal |
| `avatar-placeholder-112.webp` | `07n0inn` | thermal |
| `avatar-placeholder-113.webp` | `0820i7u` | thermal |
| `avatar-placeholder-114.webp` | `0m84csm` | thermal |
| `avatar-placeholder-115.webp` | `1wcvxnv` | thermal |
| `avatar-placeholder-116.webp` | `1au95cn` | thermal |
| `avatar-placeholder-117.webp` | `1vd0s10` | thermal |
| `avatar-placeholder-118.webp` | `0mul63e` | thermal |
| `avatar-placeholder-119.webp` | `0w0kmfb` | thermal |
| `avatar-placeholder-120.webp` | `1nuyyuf` | thermal |
| `avatar-placeholder-121.webp` | `0zdiukf` | topography |
| `avatar-placeholder-122.webp` | `0yzp8v7` | topography |
| `avatar-placeholder-123.webp` | `0dikiut` | topography |
| `avatar-placeholder-124.webp` | `02bxyvh` | topography |
| `avatar-placeholder-125.webp` | `1bgufkt` | topography |
| `avatar-placeholder-126.webp` | `0phrurp` | topography |
| `avatar-placeholder-127.webp` | `1fybg31` | topography |
| `avatar-placeholder-128.webp` | `025va5g` | topography |
| `avatar-placeholder-129.webp` | `1pbiyi0` | topography |
| `avatar-placeholder-130.webp` | `0ecze33` | topography |
| `avatar-placeholder-131.webp` | `1sqqevh` | topography |
| `avatar-placeholder-132.webp` | `0xqjfvc` | topography |
| `avatar-placeholder-133.webp` | `1tidwrn` | topography |
| `avatar-placeholder-134.webp` | `10fqjp6` | topography |
| `avatar-placeholder-135.webp` | `0j0czp3` | topography |
| `avatar-placeholder-136.webp` | `1ceomg3` | topography |
| `avatar-placeholder-137.webp` | `1vr3dhq` | topography |
| `avatar-placeholder-138.webp` | `08exagq` | topography |
| `avatar-placeholder-139.webp` | `06nph2o` | topography |
| `avatar-placeholder-140.webp` | `0hv3kh0` | topography |
| `avatar-placeholder-141.webp` | `1x3rl4s` | topography |
| `avatar-placeholder-142.webp` | `1ymfdyj` | topography |
| `avatar-placeholder-143.webp` | `1qldjsr` | topography |
| `avatar-placeholder-144.webp` | `1w90hld` | topography |
| `avatar-placeholder-145.webp` | `0fix1ls` | topography |
| `avatar-placeholder-146.webp` | `100w22c` | topography |
| `avatar-placeholder-147.webp` | `0g3dslt` | topography |
| `avatar-placeholder-148.webp` | `1hsce85` | topography |
| `avatar-placeholder-149.webp` | `1wcvqea` | topography |
| `avatar-placeholder-150.webp` | `0ncjrpw` | topography |
| `avatar-placeholder-151.webp` | `15a8f42` | topography |
| `avatar-placeholder-152.webp` | `0tnou58` | topography |
| `avatar-placeholder-153.webp` | `14vl4ed` | topography |
| `avatar-placeholder-154.webp` | `1y7niaa` | topography |
| `avatar-placeholder-155.webp` | `08tra51` | topography |
| `avatar-placeholder-156.webp` | `0k3tm9f` | topography |
| `avatar-placeholder-157.webp` | `0oe6906` | topography |
| `avatar-placeholder-158.webp` | `1fnquvr` | topography |
| `avatar-placeholder-159.webp` | `06opom2` | topography |
| `avatar-placeholder-160.webp` | `0f9qmc7` | topography |
| `avatar-placeholder-161.webp` | `1m9uynr` | plasma |
| `avatar-placeholder-162.webp` | `0iwz0tt` | plasma |
| `avatar-placeholder-163.webp` | `0uyweqa` | plasma |
| `avatar-placeholder-164.webp` | `1dp97g8` | plasma |
| `avatar-placeholder-165.webp` | `02xqb11` | plasma |
| `avatar-placeholder-166.webp` | `01c2dkf` | plasma |
| `avatar-placeholder-167.webp` | `09kmraz` | plasma |
| `avatar-placeholder-168.webp` | `10yq5jw` | plasma |
| `avatar-placeholder-169.webp` | `0x9sdd4` | plasma |
| `avatar-placeholder-170.webp` | `1mp2ns9` | plasma |
| `avatar-placeholder-171.webp` | `0tx2a5p` | plasma |
| `avatar-placeholder-172.webp` | `1udgbjt` | plasma |
| `avatar-placeholder-173.webp` | `1td6w20` | plasma |
| `avatar-placeholder-174.webp` | `1htcc0f` | plasma |
| `avatar-placeholder-175.webp` | `1lyb7f5` | plasma |
| `avatar-placeholder-176.webp` | `01dak9p` | plasma |
| `avatar-placeholder-177.webp` | `15mxt9v` | plasma |
| `avatar-placeholder-178.webp` | `0udq0z9` | plasma |
| `avatar-placeholder-179.webp` | `1afw3tp` | plasma |
| `avatar-placeholder-180.webp` | `0dttv02` | plasma |
| `avatar-placeholder-181.webp` | `054wihi` | plasma |
| `avatar-placeholder-182.webp` | `0d8ogg0` | plasma |
| `avatar-placeholder-183.webp` | `0j7xyv7` | plasma |
| `avatar-placeholder-184.webp` | `1haetix` | plasma |
| `avatar-placeholder-185.webp` | `0nzia5a` | plasma |
| `avatar-placeholder-186.webp` | `174x1av` | plasma |
| `avatar-placeholder-187.webp` | `1vefz1p` | plasma |
| `avatar-placeholder-188.webp` | `160p6mu` | plasma |
| `avatar-placeholder-189.webp` | `0q9dbwj` | plasma |
| `avatar-placeholder-190.webp` | `06puokw` | plasma |
| `avatar-placeholder-191.webp` | `16c9oij` | plasma |
| `avatar-placeholder-192.webp` | `139cvgx` | plasma |
| `avatar-placeholder-193.webp` | `1ud3wbk` | plasma |
| `avatar-placeholder-194.webp` | `18t1fe2` | plasma |
| `avatar-placeholder-195.webp` | `0n4wyqr` | plasma |
| `avatar-placeholder-196.webp` | `1vlrska` | plasma |
| `avatar-placeholder-197.webp` | `061luhn` | plasma |
| `avatar-placeholder-198.webp` | `1n19zjg` | plasma |
| `avatar-placeholder-199.webp` | `057pok1` | plasma |
| `avatar-placeholder-200.webp` | `1tp6elm` | plasma |
