// Procedural PBR texture lab.
//
// Every surface in the game is painted here at load time: albedo, a normal map
// derived from a height field, and a packed roughness/metalness map. Nothing is
// downloaded, so there are no missing textures and no pop-in — and each
// material tiles seamlessly because the noise is periodic.

import * as THREE from 'three';

// ------------------------------------------------------------------ noise
function hash2(x, y, seed) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Value noise with an integer period, so the result wraps cleanly. */
function noise(x, y, period, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const w = (n, p) => ((n % p) + p) % p;
  const x0 = w(xi, period), x1 = w(xi + 1, period);
  const y0 = w(yi, period), y1 = w(yi + 1, period);
  const a = hash2(x0, y0, seed), b = hash2(x1, y0, seed);
  const c = hash2(x0, y1, seed), d = hash2(x1, y1, seed);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

function fbm(x, y, period, seed, octaves = 4, gain = 0.5) {
  let sum = 0, amp = 1, freq = 1, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise(x * freq, y * freq, period * freq, seed + i * 71);
    norm += amp;
    amp *= gain;
    freq *= 2;
  }
  return sum / norm;
}

/** Ridged noise — good for veins, cracks and fibres. */
function turbulence(x, y, period, seed, octaves = 4) {
  let sum = 0, amp = 1, freq = 1, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * Math.abs(noise(x * freq, y * freq, period * freq, seed + i * 131) - 0.5) * 2;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const mix = (a, b, t) => a + (b - a) * t;

function hexToRgb(hex) {
  return [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
}

// -------------------------------------------------------------- painters
//
// A painter fills three parallel buffers for one material:
//   rgb    — albedo, 0..255 per channel
//   height — 0..1, converted into the normal map afterwards
//   rough  — 0..1 roughness
//   metal  — 0..1 metalness
// `S` is the texture resolution; `p` the noise period (kept proportional so
// the look is resolution independent).

const PAINTERS = {
  concrete(ctx) {
    const { S, p, rgb, height, rough, metal } = ctx;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = y * S + x;
        const u = (x / S) * p, v = (y / S) * p;
        const n = fbm(u * 1.4, v * 1.4, p, 11, 5);
        const speck = noise(u * 26, v * 26, p * 26, 23) > 0.86 ? 1 : 0;
        const crack = turbulence(u * 0.8, v * 0.8, p, 77, 3);
        const dark = crack < 0.08 ? 0.55 : 1;
        const g = (104 + n * 40 - speck * 24) * dark;
        rgb[i * 3] = g * 1.0; rgb[i * 3 + 1] = g * 1.0; rgb[i * 3 + 2] = g * 1.02;
        height[i] = n * 0.6 + (crack < 0.08 ? -0.35 : 0) + speck * 0.15;
        rough[i] = clamp01(0.82 + n * 0.14 - speck * 0.1);
        metal[i] = 0;
      }
    }
  },

  sandstone(ctx) {
    const { S, p, rgb, height, rough, metal } = ctx;
    const base = hexToRgb(0xa98d64);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = y * S + x;
        const u = (x / S) * p, v = (y / S) * p;
        const band = Math.sin(v * 2.4 + fbm(u, v * 0.4, p, 5, 3) * 5) * 0.5 + 0.5;
        const n = fbm(u * 2.0, v * 2.0, p, 31, 5);
        const pit = noise(u * 30, v * 30, p * 30, 41) > 0.91 ? 1 : 0;
        const t = 0.72 + n * 0.34 + band * 0.12 - pit * 0.22;
        rgb[i * 3] = base[0] * t;
        rgb[i * 3 + 1] = base[1] * (t * 0.99);
        rgb[i * 3 + 2] = base[2] * (t * 0.95);
        height[i] = n * 0.5 + band * 0.2 - pit * 0.5;
        rough[i] = clamp01(0.86 + n * 0.1);
        metal[i] = 0;
      }
    }
  },

  plaster(ctx) {
    const { S, p, rgb, height, rough, metal } = ctx;
    const base = hexToRgb(0xb6b1a6);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = y * S + x;
        const u = (x / S) * p, v = (y / S) * p;
        const n = fbm(u * 2.6, v * 2.6, p, 61, 4);
        const trowel = fbm(u * 0.8, v * 0.8, p, 91, 2);
        const t = 0.86 + n * 0.16 + trowel * 0.08;
        rgb[i * 3] = base[0] * t; rgb[i * 3 + 1] = base[1] * t; rgb[i * 3 + 2] = base[2] * t;
        height[i] = n * 0.28 + trowel * 0.4;
        rough[i] = clamp01(0.78 + n * 0.1);
        metal[i] = 0;
      }
    }
  },

  plywood(ctx) {
    const { S, p, rgb, height, rough, metal } = ctx;
    const base = hexToRgb(0xc9a26a);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = y * S + x;
        const u = (x / S) * p, v = (y / S) * p;
        const grain = turbulence(u * 1.2, v * 9, p, 17, 4);
        const t = 0.8 + grain * 0.3;
        rgb[i * 3] = base[0] * t; rgb[i * 3 + 1] = base[1] * t * 0.97; rgb[i * 3 + 2] = base[2] * t * 0.9;
        height[i] = grain * 0.3;
        rough[i] = 0.84;
        metal[i] = 0;
      }
    }
  },

  brick(ctx) {
    const { S, p, rgb, height, rough, metal } = ctx;
    const rows = 8, cols = 4;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = y * S + x;
        const fy = (y / S) * rows;
        const row = Math.floor(fy);
        const offset = row % 2 ? 0.5 : 0;
        const fx = (x / S) * cols + offset;
        const col = Math.floor(fx);
        const inRowY = fy - row, inColX = fx - col;
        const mortar = inRowY < 0.09 || inRowY > 0.93 || inColX < 0.045 || inColX > 0.965;

        const u = (x / S) * p, v = (y / S) * p;
        const n = fbm(u * 3, v * 3, p, 7, 4);
        const tint = hash2(col, row, 3);

        if (mortar) {
          const g = 118 + n * 26;
          rgb[i * 3] = g; rgb[i * 3 + 1] = g * 0.99; rgb[i * 3 + 2] = g * 0.95;
          height[i] = -0.55 + n * 0.15;
          rough[i] = 0.92;
        } else {
          const r = mix(150, 186, tint) * (0.82 + n * 0.32);
          rgb[i * 3] = r;
          rgb[i * 3 + 1] = r * mix(0.60, 0.68, tint);
          rgb[i * 3 + 2] = r * mix(0.48, 0.56, tint);
          height[i] = 0.5 + n * 0.28;
          rough[i] = clamp01(0.8 + n * 0.14);
        }
        metal[i] = 0;
      }
    }
  },

  stone(ctx) {
    const { S, p, rgb, height, rough, metal } = ctx;
    const rows = 5, cols = 3;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = y * S + x;
        const u = (x / S) * p, v = (y / S) * p;
        const warp = fbm(u * 2, v * 2, p, 13, 3) * 0.06;
        const fy = (y / S + warp) * rows;
        const row = Math.floor(fy);
        const fx = ((x / S) + warp + (row % 2 ? 0.37 : 0)) * cols;
        const col = Math.floor(fx);
        const inY = fy - row, inX = fx - col;
        const joint = inY < 0.06 || inY > 0.95 || inX < 0.03 || inX > 0.975;
        const n = fbm(u * 4, v * 4, p, 29, 5);
        const tint = hash2(col, row, 9);
        const g = mix(126, 168, tint) * (0.84 + n * 0.3);
        if (joint) {
          rgb[i * 3] = g * 0.6; rgb[i * 3 + 1] = g * 0.6; rgb[i * 3 + 2] = g * 0.58;
          height[i] = -0.6;
          rough[i] = 0.94;
        } else {
          rgb[i * 3] = g; rgb[i * 3 + 1] = g * 0.98; rgb[i * 3 + 2] = g * 0.93;
          height[i] = 0.45 + n * 0.35;
          rough[i] = clamp01(0.8 + n * 0.15);
        }
        metal[i] = 0;
      }
    }
  },

  tile(ctx) {
    const { S, p, rgb, height, rough, metal } = ctx;
    const n8 = 6;
    const palette = [0xb3ab9c, 0xaca291, 0xa29988, 0xafa795, 0x9a9182];
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = y * S + x;
        const fx = (x / S) * n8, fy = (y / S) * n8;
        const cx = Math.floor(fx), cy = Math.floor(fy);
        const inX = fx - cx, inY = fy - cy;
        const grout = inX < 0.045 || inX > 0.955 || inY < 0.045 || inY > 0.955;
        const u = (x / S) * p, v = (y / S) * p;
        const n = fbm(u * 5, v * 5, p, 53, 4);
        if (grout) {
          const g = 96 + n * 22;
          rgb[i * 3] = g; rgb[i * 3 + 1] = g * 0.97; rgb[i * 3 + 2] = g * 0.9;
          height[i] = -0.7;
          rough[i] = 0.93;
        } else {
          const c = hexToRgb(palette[(cx * 7 + cy * 3) % palette.length]);
          const t = 0.9 + n * 0.2;
          rgb[i * 3] = c[0] * t; rgb[i * 3 + 1] = c[1] * t; rgb[i * 3 + 2] = c[2] * t;
          height[i] = 0.42 + n * 0.1;
          rough[i] = clamp01(0.42 + n * 0.22);
        }
        metal[i] = 0;
      }
    }
  },

  marble(ctx) {
    const { S, p, rgb, height, rough, metal } = ctx;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = y * S + x;
        const u = (x / S) * p, v = (y / S) * p;
        const t = turbulence(u * 1.1, v * 1.1, p, 3, 5);
        const vein = Math.pow(1 - Math.abs(Math.sin((u + v) * 1.6 + t * 6)), 8);
        const g = 186 - t * 30 - vein * 72;
        rgb[i * 3] = g; rgb[i * 3 + 1] = g * 0.99; rgb[i * 3 + 2] = g * 0.96;
        height[i] = t * 0.12;
        rough[i] = clamp01(0.24 + t * 0.2 + vein * 0.2);
        metal[i] = 0;
      }
    }
  },

  wood(ctx) { woodPainter(ctx, 0xb08248, 6); },
  woodDark(ctx) { woodPainter(ctx, 0x60422a, 5); },

  metal(ctx) {
    const { S, p, rgb, height, rough, metal } = ctx;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = y * S + x;
        const u = (x / S) * p, v = (y / S) * p;
        const brush = noise(u * 60, v * 2, p * 60, 19);
        const n = fbm(u * 3, v * 3, p, 37, 3);
        const panelX = Math.abs(((x / S) * 2) % 1 - 0.5) > 0.487;
        const panelY = Math.abs(((y / S) * 2) % 1 - 0.5) > 0.487;
        const seam = panelX || panelY;
        const g = (122 + brush * 26 + n * 16) * (seam ? 0.62 : 1);
        rgb[i * 3] = g * 0.97; rgb[i * 3 + 1] = g; rgb[i * 3 + 2] = g * 1.05;
        height[i] = seam ? -0.6 : brush * 0.16;
        rough[i] = clamp01(0.38 + brush * 0.22 + n * 0.1);
        metal[i] = seam ? 0.42 : 0.62;
      }
    }
  },

  metalRust(ctx) {
    const { S, p, rgb, height, rough, metal } = ctx;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = y * S + x;
        const u = (x / S) * p, v = (y / S) * p;
        const rustMask = clamp01((fbm(u * 2.2, v * 2.2, p, 67, 5) - 0.42) * 3.2);
        const brush = noise(u * 50, v * 2, p * 50, 19);
        const grain = fbm(u * 12, v * 12, p, 83, 3);
        const baseG = 116 + brush * 22;
        const rr = mix(baseG * 0.96, 132 + grain * 52, rustMask);
        const gg = mix(baseG, 74 + grain * 34, rustMask);
        const bb = mix(baseG * 1.04, 48 + grain * 20, rustMask);
        rgb[i * 3] = rr; rgb[i * 3 + 1] = gg; rgb[i * 3 + 2] = bb;
        height[i] = mix(brush * 0.14, grain * 0.5, rustMask);
        rough[i] = clamp01(mix(0.38, 0.94, rustMask));
        metal[i] = mix(0.9, 0.12, rustMask);
      }
    }
  },

  container(ctx) { containerPainter(ctx, 0x9a4a3a); },
  containerB(ctx) { containerPainter(ctx, 0x2f6d80); },

  crate(ctx) {
    const { S, p, rgb, height, rough, metal } = ctx;
    const base = hexToRgb(0xb98f57);
    const slats = 5;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = y * S + x;
        const u = (x / S) * p, v = (y / S) * p;
        const fy = (y / S) * slats;
        const gap = (fy - Math.floor(fy)) < 0.07;
        const grain = turbulence(u * 1.4, v * 12, p, 43, 4);
        const t = (0.78 + grain * 0.34) * (gap ? 0.45 : 1);
        rgb[i * 3] = base[0] * t; rgb[i * 3 + 1] = base[1] * t * 0.96; rgb[i * 3 + 2] = base[2] * t * 0.88;
        height[i] = gap ? -0.55 : grain * 0.3;
        rough[i] = 0.86;
        metal[i] = 0;
      }
    }
  },

  asphalt(ctx) {
    const { S, p, rgb, height, rough, metal } = ctx;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = y * S + x;
        const u = (x / S) * p, v = (y / S) * p;
        const grit = noise(u * 40, v * 40, p * 40, 71);
        const n = fbm(u * 3, v * 3, p, 97, 4);
        const g = 54 + n * 26 + (grit > 0.8 ? 30 : 0);
        rgb[i * 3] = g; rgb[i * 3 + 1] = g * 1.01; rgb[i * 3 + 2] = g * 1.04;
        height[i] = grit * 0.4 + n * 0.2;
        rough[i] = clamp01(0.9 + n * 0.08);
        metal[i] = 0;
      }
    }
  },

  sand(ctx) {
    const { S, p, rgb, height, rough, metal } = ctx;
    const base = hexToRgb(0xae9a74);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = y * S + x;
        const u = (x / S) * p, v = (y / S) * p;
        const grain = noise(u * 64, v * 64, p * 64, 101);
        const ripple = fbm(u * 2.2, v * 5.5, p, 113, 3);
        const t = 0.84 + ripple * 0.22 + grain * 0.14;
        rgb[i * 3] = base[0] * t; rgb[i * 3 + 1] = base[1] * t * 0.98; rgb[i * 3 + 2] = base[2] * t * 0.92;
        height[i] = ripple * 0.55 + grain * 0.2;
        rough[i] = 0.95;
        metal[i] = 0;
      }
    }
  },

  dirt(ctx) {
    const { S, p, rgb, height, rough, metal } = ctx;
    const base = hexToRgb(0x6d5a44);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = y * S + x;
        const u = (x / S) * p, v = (y / S) * p;
        const n = fbm(u * 3.4, v * 3.4, p, 127, 5);
        const stones = noise(u * 22, v * 22, p * 22, 131) > 0.88 ? 1 : 0;
        const t = 0.78 + n * 0.4 + stones * 0.2;
        rgb[i * 3] = base[0] * t; rgb[i * 3 + 1] = base[1] * t; rgb[i * 3 + 2] = base[2] * t * 0.95;
        height[i] = n * 0.5 + stones * 0.3;
        rough[i] = 0.96;
        metal[i] = 0;
      }
    }
  },

  grass(ctx) {
    const { S, p, rgb, height, rough, metal } = ctx;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = y * S + x;
        const u = (x / S) * p, v = (y / S) * p;
        const clump = fbm(u * 4, v * 4, p, 149, 4);
        const blade = noise(u * 48, v * 48, p * 48, 151);
        const t = 0.7 + clump * 0.5 + blade * 0.18;
        rgb[i * 3] = 78 * t; rgb[i * 3 + 1] = 112 * t; rgb[i * 3 + 2] = 58 * t;
        height[i] = blade * 0.5 + clump * 0.3;
        rough[i] = 0.9;
        metal[i] = 0;
      }
    }
  },

  hedge(ctx) {
    const { S, p, rgb, height, rough, metal } = ctx;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = y * S + x;
        const u = (x / S) * p, v = (y / S) * p;
        const leaf = fbm(u * 14, v * 14, p, 163, 4);
        const clump = fbm(u * 4, v * 4, p, 167, 3);
        const t = 0.55 + leaf * 0.6 + clump * 0.28;
        rgb[i * 3] = 52 * t; rgb[i * 3 + 1] = 88 * t; rgb[i * 3 + 2] = 42 * t;
        height[i] = leaf * 0.8;
        rough[i] = 0.92;
        metal[i] = 0;
      }
    }
  },

  fabric(ctx) {
    const { S, p, rgb, height, rough, metal } = ctx;
    const stripes = 8;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = y * S + x;
        const u = (x / S) * p, v = (y / S) * p;
        const s = Math.floor((x / S) * stripes) % 2;
        const weave = noise(u * 90, v * 90, p * 90, 173);
        const t = 0.86 + weave * 0.24;
        if (s) { rgb[i * 3] = 196 * t; rgb[i * 3 + 1] = 74 * t; rgb[i * 3 + 2] = 58 * t; }
        else { rgb[i * 3] = 226 * t; rgb[i * 3 + 1] = 216 * t; rgb[i * 3 + 2] = 196 * t; }
        height[i] = weave * 0.3;
        rough[i] = 0.95;
        metal[i] = 0;
      }
    }
  },

  gravel(ctx) {
    const { S, p, rgb, height, rough, metal } = ctx;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = y * S + x;
        const u = (x / S) * p, v = (y / S) * p;
        const stone = noise(u * 44, v * 44, p * 44, 311);
        const clump = fbm(u * 6, v * 6, p, 313, 3);
        const t = 0.62 + stone * 0.5 + clump * 0.22;
        rgb[i * 3] = 106 * t; rgb[i * 3 + 1] = 101 * t; rgb[i * 3 + 2] = 93 * t;
        height[i] = stone * 0.85 + clump * 0.2;
        rough[i] = 0.95;
        metal[i] = 0;
      }
    }
  },

  estatebrick(ctx) {
    const { S, p, rgb, height, rough, metal } = ctx;
    const rows = 14, cols = 6;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = y * S + x;
        const fy = (y / S) * rows;
        const row = Math.floor(fy);
        const fx = (x / S) * cols + (row % 2 ? 0.5 : 0);
        const col = Math.floor(fx);
        const inY = fy - row, inX = fx - col;
        const mortar = inY < 0.11 || inY > 0.92 || inX < 0.05 || inX > 0.96;
        const u = (x / S) * p, v = (y / S) * p;
        const n = fbm(u * 5, v * 5, p, 317, 4);
        const tint = hash2(col, row, 19);
        if (mortar) {
          const g = 152 + n * 22;
          rgb[i * 3] = g; rgb[i * 3 + 1] = g * 0.98; rgb[i * 3 + 2] = g * 0.93;
          height[i] = -0.5 + n * 0.1;
          rough[i] = 0.93;
        } else {
          const r = mix(120, 158, tint) * (0.84 + n * 0.3);
          rgb[i * 3] = r;
          rgb[i * 3 + 1] = r * mix(0.52, 0.60, tint);
          rgb[i * 3 + 2] = r * mix(0.44, 0.52, tint);
          height[i] = 0.42 + n * 0.24;
          rough[i] = clamp01(0.82 + n * 0.14);
        }
        metal[i] = 0;
      }
    }
  },

  estatewood(ctx) {
    const { S, p, rgb, height, rough, metal } = ctx;
    const boards = 9;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = y * S + x;
        const u = (x / S) * p, v = (y / S) * p;
        const fx = (x / S) * boards;
        const gap = (fx - Math.floor(fx)) < 0.05;
        const grain = turbulence(u * 14, v * 1.2, p, 331, 4);
        const t = (0.5 + grain * 0.36) * (gap ? 0.42 : 1);
        rgb[i * 3] = 96 * t; rgb[i * 3 + 1] = 70 * t; rgb[i * 3 + 2] = 50 * t;
        height[i] = gap ? -0.6 : grain * 0.34;
        rough[i] = 0.9;
        metal[i] = 0;
      }
    }
  },

  slate(ctx) {
    const { S, p, rgb, height, rough, metal } = ctx;
    const rows = 12, cols = 7;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = y * S + x;
        const fy = (y / S) * rows;
        const row = Math.floor(fy);
        const fx = (x / S) * cols + (row % 2 ? 0.5 : 0);
        const col = Math.floor(fx);
        const inY = fy - row, inX = fx - col;
        const edge = inY < 0.08 || inX < 0.04 || inX > 0.97;
        const u = (x / S) * p, v = (y / S) * p;
        const n = fbm(u * 8, v * 8, p, 337, 4);
        const tint = hash2(col, row, 23);
        const g = mix(52, 78, tint) * (0.82 + n * 0.34);
        rgb[i * 3] = g * 0.94; rgb[i * 3 + 1] = g * 0.98; rgb[i * 3 + 2] = g * 1.1;
        height[i] = edge ? -0.55 : 0.3 + n * 0.2;
        rough[i] = clamp01(0.6 + n * 0.24);
        metal[i] = 0.12;
      }
    }
  },

  hay(ctx) {
    const { S, p, rgb, height, rough, metal } = ctx;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = y * S + x;
        const u = (x / S) * p, v = (y / S) * p;
        const straw = turbulence(u * 3, v * 40, p, 347, 4);
        const t = 0.6 + straw * 0.6;
        rgb[i * 3] = 196 * t; rgb[i * 3 + 1] = 162 * t; rgb[i * 3 + 2] = 78 * t;
        height[i] = straw * 0.8;
        rough[i] = 0.96;
        metal[i] = 0;
      }
    }
  },

  greenframe(ctx) {
    const { S, p, rgb, height, rough, metal } = ctx;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = y * S + x;
        const u = (x / S) * p, v = (y / S) * p;
        const n = fbm(u * 8, v * 8, p, 353, 3);
        const g = 196 + n * 34;
        rgb[i * 3] = g; rgb[i * 3 + 1] = g * 1.0; rgb[i * 3 + 2] = g * 0.96;
        height[i] = n * 0.2;
        rough[i] = 0.5;
        metal[i] = 0.2;
      }
    }
  },

  bark(ctx) {
    const { S, p, rgb, height, rough, metal } = ctx;
    const base = hexToRgb(0x6b5334);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = y * S + x;
        const u = (x / S) * p, v = (y / S) * p;
        const fibre = turbulence(u * 3, v * 22, p, 199, 4);
        const ring = Math.abs(Math.sin(v * 26 + fibre * 3)) ;
        const t = 0.62 + fibre * 0.5 + ring * 0.14;
        rgb[i * 3] = base[0] * t; rgb[i * 3 + 1] = base[1] * t * 0.96; rgb[i * 3 + 2] = base[2] * t * 0.9;
        height[i] = fibre * 0.7;
        rough[i] = 0.94;
        metal[i] = 0;
      }
    }
  },

  foliage(ctx) {
    const { S, p, rgb, height, rough, metal } = ctx;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = y * S + x;
        const u = (x / S) * p, v = (y / S) * p;
        const leaf = fbm(u * 10, v * 10, p, 211, 4);
        const vein = turbulence(u * 3, v * 18, p, 223, 3);
        const t = 0.6 + leaf * 0.55 + vein * 0.2;
        rgb[i * 3] = 74 * t; rgb[i * 3 + 1] = 124 * t; rgb[i * 3 + 2] = 54 * t;
        height[i] = leaf * 0.6 + vein * 0.2;
        rough[i] = 0.86;
        metal[i] = 0;
      }
    }
  },

  targetred(ctx) { targetPainter(ctx, [214, 62, 54]); },
  targetgreen(ctx) { targetPainter(ctx, [66, 190, 118]); },

  trim(ctx) {
    const { S, p, rgb, height, rough, metal } = ctx;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = y * S + x;
        const u = (x / S) * p, v = (y / S) * p;
        const n = fbm(u * 6, v * 6, p, 181, 3);
        const g = 44 + n * 22;
        rgb[i * 3] = g; rgb[i * 3 + 1] = g * 1.02; rgb[i * 3 + 2] = g * 1.08;
        height[i] = n * 0.2;
        rough[i] = clamp01(0.5 + n * 0.2);
        metal[i] = 0.35;
      }
    }
  },
};

/** Concentric scoring rings for the range targets. */
function targetPainter(ctx, accent) {
  const { S, rgb, height, rough, metal } = ctx;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = y * S + x;
      const dx = (x / S - 0.5) * 2, dy = (y / S - 0.5) * 2;
      const d = Math.hypot(dx, dy);
      const ring = Math.floor(d * 6);
      const onLine = Math.abs(d * 6 - ring - 0.5) > 0.44;
      let c;
      if (d < 0.14) c = accent;
      else if (onLine) c = [24, 26, 30];
      else if (ring % 2) c = [236, 233, 226];
      else c = [206, 202, 194];
      rgb[i * 3] = c[0]; rgb[i * 3 + 1] = c[1]; rgb[i * 3 + 2] = c[2];
      height[i] = onLine ? -0.2 : 0;
      rough[i] = 0.8;
      metal[i] = 0;
    }
  }
}

function woodPainter(ctx, hex, planks) {
  const { S, p, rgb, height, rough, metal } = ctx;
  const base = hexToRgb(hex);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = y * S + x;
      const u = (x / S) * p, v = (y / S) * p;
      const fy = (y / S) * planks;
      const plank = Math.floor(fy);
      const inY = fy - plank;
      const gap = inY < 0.035 || inY > 0.972;
      const shift = hash2(plank, 0, 5) * 10;
      const grain = turbulence((u + shift) * 1.1, v * 16, p, 23, 5);
      const knot = noise(u * 3 + shift, v * 3, p * 3, 27) > 0.93 ? 0.55 : 1;
      const tone = mix(0.88, 1.1, hash2(plank, 1, 7));
      const t = (0.74 + grain * 0.42) * tone * knot * (gap ? 0.4 : 1);
      rgb[i * 3] = base[0] * t;
      rgb[i * 3 + 1] = base[1] * t * 0.97;
      rgb[i * 3 + 2] = base[2] * t * 0.9;
      height[i] = gap ? -0.6 : grain * 0.34;
      rough[i] = clamp01(0.72 + grain * 0.2);
      metal[i] = 0;
    }
  }
}

function containerPainter(ctx, hex) {
  const { S, p, rgb, height, rough, metal } = ctx;
  const base = hexToRgb(hex);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = y * S + x;
      const u = (x / S) * p, v = (y / S) * p;
      const rib = Math.sin((x / S) * Math.PI * 2 * 14);
      const wear = clamp01((fbm(u * 2.6, v * 2.6, p, 191, 5) - 0.5) * 3);
      const scratch = noise(u * 34, v * 4, p * 34, 193);
      const t = 0.78 + rib * 0.14 + scratch * 0.1;
      rgb[i * 3] = mix(base[0] * t, 122 + scratch * 40, wear);
      rgb[i * 3 + 1] = mix(base[1] * t, 70 + scratch * 26, wear);
      rgb[i * 3 + 2] = mix(base[2] * t, 50 + scratch * 18, wear);
      height[i] = rib * 0.45;
      rough[i] = clamp01(mix(0.52, 0.92, wear));
      metal[i] = mix(0.75, 0.15, wear);
    }
  }
}

// ------------------------------------------------------------- assembly
function toTexture(data, S, srgb, aniso, renderer) {
  const tex = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = aniso;
  tex.needsUpdate = true;
  void renderer;
  return tex;
}

/** Sobel the height field into a tangent-space normal map. */
function heightToNormal(height, S, strength) {
  const out = new Uint8Array(S * S * 4);
  const at = (x, y) => height[((y + S) % S) * S + ((x + S) % S)];
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = (at(x - 1, y) - at(x + 1, y)) * strength;
      const dy = (at(x, y - 1) - at(x, y + 1)) * strength;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * S + x) * 4;
      out[i] = ((dx / len) * 0.5 + 0.5) * 255;
      out[i + 1] = ((dy / len) * 0.5 + 0.5) * 255;
      out[i + 2] = ((1 / len) * 0.5 + 0.5) * 255;
      out[i + 3] = 255;
    }
  }
  return out;
}

// How many metres one tile of each material covers, and how strong its relief is.
const MATERIAL_SETUP = {
  concrete:   { scale: 2.6, relief: 5,  },
  sandstone:  { scale: 3.0, relief: 7 },
  plaster:    { scale: 3.2, relief: 3 },
  plywood:    { scale: 2.4, relief: 3 },
  brick:      { scale: 2.2, relief: 10 },
  stone:      { scale: 3.4, relief: 10 },
  tile:       { scale: 3.0, relief: 8 },
  marble:     { scale: 3.6, relief: 2 },
  wood:       { scale: 2.4, relief: 5 },
  woodDark:   { scale: 2.4, relief: 5 },
  metal:      { scale: 2.0, relief: 5 },
  metalRust:  { scale: 2.6, relief: 6 },
  container:  { scale: 3.0, relief: 6 },
  containerB: { scale: 3.0, relief: 6 },
  crate:      { scale: 1.2, relief: 6 },
  asphalt:    { scale: 3.0, relief: 4 },
  sand:       { scale: 4.0, relief: 5 },
  dirt:       { scale: 3.6, relief: 5 },
  grass:      { scale: 2.4, relief: 4 },
  hedge:      { scale: 1.4, relief: 8 },
  fabric:     { scale: 1.6, relief: 3 },
  trim:       { scale: 1.8, relief: 3 },
  gravel:     { scale: 2.2, relief: 6 },
  estatebrick:{ scale: 2.6, relief: 9 },
  estatewood: { scale: 2.2, relief: 6 },
  slate:      { scale: 2.4, relief: 7 },
  hay:        { scale: 1.4, relief: 7 },
  greenframe: { scale: 2.0, relief: 2 },
  bark:       { scale: 1.0, relief: 8 },
  foliage:    { scale: 1.2, relief: 6 },
  targetred:  { scale: 1.0, relief: 2 },
  targetgreen:{ scale: 1.0, relief: 2 },
};

// Materials that reuse another's paint job.
const ALIASES = {
  roofwood: 'wood',
  flagcloth: 'fabric',
  plank: 'wood',
};

// Materials that are not textured at all.
const SPECIALS = {
  glass: () => new THREE.MeshPhysicalMaterial({
    color: 0xbcd4dd, metalness: 0, roughness: 0.05,
    transmission: 0.9, thickness: 0.05, ior: 1.45,
    transparent: true, opacity: 0.34, side: THREE.DoubleSide,
    // Written to the depth buffer: without it, overlapping panes reorder as
    // the camera moves and the windows flicker.
    depthWrite: true, envMapIntensity: 1.8,
  }),
  water: () => new THREE.MeshPhysicalMaterial({
    color: 0x2f6f7c, metalness: 0.05, roughness: 0.04,
    transmission: 0.55, thickness: 0.7, ior: 1.33,
    transparent: true, opacity: 0.85, envMapIntensity: 2.0,
  }),
  waterjet: () => new THREE.MeshPhysicalMaterial({
    color: 0xd8eef5, roughness: 0.08, transmission: 0.75,
    transparent: true, opacity: 0.45, depthWrite: false,
  }),
  lampglass: () => new THREE.MeshStandardMaterial({
    color: 0xfff2d8, emissive: 0xffd9a0, emissiveIntensity: 2.6, roughness: 0.28,
  }),
};

export class TextureLab {
  constructor(renderer, { size = 256 } = {}) {
    this.renderer = renderer;
    this.size = size;
    this.aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    this.cache = new Map();
    this.materials = new Map();
  }

  /** Names of every material this lab can paint. */
  static kinds() { return Object.keys(PAINTERS); }

  bake(kind) {
    if (this.cache.has(kind)) return this.cache.get(kind);
    const painter = PAINTERS[kind] || PAINTERS.concrete;
    const setup = MATERIAL_SETUP[kind] || MATERIAL_SETUP.concrete;
    const S = this.size;
    const p = Math.max(4, Math.round(S / 32));

    const rgb = new Float32Array(S * S * 3);
    const height = new Float32Array(S * S);
    const rough = new Float32Array(S * S);
    const metal = new Float32Array(S * S);
    painter({ S, p, rgb, height, rough, metal });

    const albedo = new Uint8Array(S * S * 4);
    const orm = new Uint8Array(S * S * 4);
    for (let i = 0; i < S * S; i++) {
      albedo[i * 4] = clamp01(rgb[i * 3] / 255) * 255;
      albedo[i * 4 + 1] = clamp01(rgb[i * 3 + 1] / 255) * 255;
      albedo[i * 4 + 2] = clamp01(rgb[i * 3 + 2] / 255) * 255;
      albedo[i * 4 + 3] = 255;
      orm[i * 4] = 255;                       // ambient occlusion, unused
      orm[i * 4 + 1] = clamp01(rough[i]) * 255;
      orm[i * 4 + 2] = clamp01(metal[i]) * 255;
      orm[i * 4 + 3] = 255;
    }

    const result = {
      map: toTexture(albedo, S, true, this.aniso, this.renderer),
      normalMap: toTexture(heightToNormal(height, S, setup.relief), S, false, this.aniso, this.renderer),
      ormMap: toTexture(orm, S, false, this.aniso, this.renderer),
      scale: setup.scale,
    };
    this.cache.set(kind, result);
    return result;
  }

  /**
   * A MeshStandardMaterial for the given map material key. UVs are generated in
   * world units, so `repeat` here converts metres into texture tiles.
   */
  material(kind) {
    if (this.materials.has(kind)) return this.materials.get(kind);
    const resolved = ALIASES[kind] || kind;

    let mat;
    if (SPECIALS[resolved]) {
      mat = SPECIALS[resolved]();
      mat.userData.uvScale = 1;
    } else {
      const baked = this.bake(PAINTERS[resolved] ? resolved : 'concrete');
      const rep = 1 / baked.scale;
      const clone = (t) => {
        const c = t.clone();
        c.needsUpdate = true;
        c.repeat.set(rep, rep);
        c.wrapS = c.wrapT = THREE.RepeatWrapping;
        return c;
      };
      mat = new THREE.MeshStandardMaterial({
        map: clone(baked.map),
        normalMap: clone(baked.normalMap),
        roughnessMap: clone(baked.ormMap),
        metalnessMap: clone(baked.ormMap),
        roughness: 1,
        metalness: 1,
        normalScale: new THREE.Vector2(1, 1),
        // Scene environment intensity is kept low for exposure reasons, so
        // materials lean on the environment a little harder to compensate —
        // without this, anything metallic renders almost black.
        envMapIntensity: 2.4,
      });
      // World-space UVs mean `repeat` has already been folded into the vertex
      // data; keep the texture repeat at 1 and scale UVs instead.
      mat.userData.uvScale = rep;
      mat.map.repeat.set(1, 1);
      mat.normalMap.repeat.set(1, 1);
      mat.roughnessMap.repeat.set(1, 1);
      mat.metalnessMap.repeat.set(1, 1);
    }
    mat.name = kind;
    this.materials.set(kind, mat);
    return mat;
  }

  dispose() {
    for (const set of this.cache.values()) {
      set.map.dispose(); set.normalMap.dispose(); set.ormMap.dispose();
    }
    for (const m of this.materials.values()) m.dispose();
    this.cache.clear();
    this.materials.clear();
  }
}

export { fbm, noise, turbulence, hash2 };
