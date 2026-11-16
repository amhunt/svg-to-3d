import type { StainedGlassLayout } from "./layout.js";

/** mulberry32: small, fast, and the same numbers on every machine. */
const random = (seed: number) => {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const n1 = (n: number) => String(Math.round(n * 10) / 10);

/**
 * A design with no model behind it: long curved cuts across the
 * background, colored corners, a flat band and each letter cut into bands.
 * It's written in the same form a model is asked for, so it goes straight
 * into `buildStainedGlass` — use it as the first thing on screen, as the
 * fallback when a model's reply won't do, or as an example to edit.
 *
 * The same layout and `seed` always give the same design.
 */
export function starterStainedGlass(
  layout: StainedGlassLayout,
  options: { seed?: number } = {},
): string {
  const rand = random(options.seed ?? 1);
  const between = (lo: number, hi: number) => lo + (hi - lo) * rand();
  const { width: W, height: H } = layout.size;
  const glass = layout.palette.slice(1);
  const letterColor = glass[0];
  const bandColor = glass[1 % glass.length];
  const backgroundColor = glass[2 % glass.length];
  const accents = glass.length > 3 ? glass.slice(3) : [bandColor];
  const cut = (d: string) => `<path fill="none" stroke="#000" d="${d}"/>`;

  // Background: one color, a few accent areas, then sweeping cuts.
  const background: string[] = [
    `<rect x="0" y="0" width="${n1(W)}" height="${n1(H)}" fill="${backgroundColor}"/>`,
  ];
  if (glass.length > 3) {
    // A wide wedge of each extra color, fanned from alternating edges
    accents.forEach((color, i) => {
      const x = between(0.1, 0.8) * W;
      const span = between(0.18, 0.32) * W;
      const lean = between(-0.15, 0.15) * W;
      const fromTop = i % 2 === 0;
      const y0 = fromTop ? 0 : H;
      const y1 = fromTop ? H : 0;
      background.push(
        `<path fill="${color}" d="M${n1(x)} ${n1(y0)} L${n1(x + span)} ${n1(y0)} L${n1(x + span / 2 + lean)} ${n1(y1)} Z"/>`,
      );
    });
  }
  const corner = Math.min(W, H) * 0.42;
  const accent = glass.length > 3 ? accents[0] : bandColor;
  if (glass.length > 1) {
    for (const [cx, cy, sx, sy] of [
      [0, 0, 1, 1],
      [W, 0, -1, 1],
      [W, H, -1, -1],
      [0, H, 1, -1],
    ]) {
      const a = corner * between(0.55, 1);
      const c = corner * between(0.55, 1);
      background.push(
        `<path fill="${accent}" d="M${n1(cx)} ${n1(cy)} L${n1(cx + sx * a)} ${n1(cy)} L${n1(cx)} ${n1(cy + sy * c)} Z"/>`,
      );
    }
  }
  const total = Math.max(2, layout.targets.cuts);
  const across = Math.max(1, Math.round(total * 0.45));
  const over = W * 0.04;
  for (let i = 0; i < across; i++) {
    // Left edge to right edge, drifting
    const y0 = between(0.08, 0.92) * H;
    const y1 = between(0.08, 0.92) * H;
    background.push(
      cut(
        `M${n1(-over)} ${n1(y0)} C${n1(W * 0.3)} ${n1(between(-0.1, 1.1) * H)} ${n1(W * 0.7)} ${n1(between(-0.1, 1.1) * H)} ${n1(W + over)} ${n1(y1)}`,
      ),
    );
  }
  for (let i = 0; i < total - across; i++) {
    // Top edge to bottom edge, spread along the width so they don't bunch
    const slot = W / (total - across);
    const x0 = slot * (i + between(0.15, 0.85));
    const x1 = x0 + between(-0.6, 0.6) * slot;
    const bow = between(-0.5, 0.5) * slot;
    background.push(
      cut(
        `M${n1(x0)} ${n1(-over)} C${n1(x0 + bow)} ${n1(H * 0.33)} ${n1(x1 - bow)} ${n1(H * 0.67)} ${n1(x1)} ${n1(H + over)}`,
      ),
    );
  }

  const band: string[] = [];
  const letters: string[] = [];
  const b = layout.band;
  if (b) {
    const rect = (fill: string) =>
      `<rect x="${n1(b.x - 2)}" y="${n1(b.y - 2)}" width="${n1(b.width + 4)}" height="${n1(b.height + 4)}" fill="${fill}"/>`;
    band.push(rect(bandColor));
    letters.push(rect(letterColor));
    // Each letter cut into level bands, a little off true, and only as far
    // as halfway to its neighbours
    const reach = layout.leadWidth * 0.45;
    const segments = layout.targets.perLetter;
    for (const letter of layout.letters) {
      for (let k = 1; k < segments; k++) {
        const y =
          letter.box.y +
          letter.box.height * (k / segments + between(-0.07, 0.07));
        const tilt = letter.box.height * between(-0.05, 0.05);
        letters.push(
          cut(
            `M${n1(letter.box.x - reach)} ${n1(y - tilt)} L${n1(letter.box.x + letter.box.width + reach)} ${n1(y + tilt)}`,
          ),
        );
      }
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n1(W)} ${n1(H)}"><g id="background">${background.join("")}</g><g id="band">${band.join("")}</g><g id="letters">${letters.join("")}</g></svg>`;
}
