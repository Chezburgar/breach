// Player banners, drawn procedurally to canvas.
//
// The built-in set is generated from recipes in shared/cosmetics.js. If image
// files are listed in /assets/banners/manifest.json they are loaded and take
// precedence, so real artwork can be dropped in without touching this code.

import { BANNERS, RARITY_COLORS, bannerById } from '/shared/cosmetics.js';

const imageCache = new Map();
export const customBanners = [];

/** Load any drop-in banner artwork. Safe to call before the menu appears. */
export async function loadBannerManifest() {
  try {
    const res = await fetch('/assets/banners/manifest.json', { cache: 'no-cache' });
    if (!res.ok) return [];
    const data = await res.json();
    const list = Array.isArray(data) ? data : data.banners || [];
    for (const entry of list) {
      if (!entry || !entry.file) continue;
      const def = {
        id: entry.id || `img_${entry.file}`,
        name: entry.name || entry.file.replace(/\.[a-z0-9]+$/i, ''),
        rarity: entry.rarity || 'epic',
        image: `/assets/banners/${entry.file}`,
      };
      customBanners.push(def);
      const img = new Image();
      img.src = def.image;
      imageCache.set(def.id, img);
    }
  } catch {
    // No manifest is the normal case — the procedural set covers everything.
  }
  return customBanners;
}

export function allBanners() {
  return [...customBanners, ...BANNERS];
}

export function findBanner(id) {
  return customBanners.find((b) => b.id === id) || bannerById(id);
}

// ----------------------------------------------------------- patterns
function paintPattern(ctx, w, h, def) {
  const [bg, c1, c2] = def.colors;
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  ctx.save();
  switch (def.pattern) {
    case 'diagonal': {
      const g = ctx.createLinearGradient(0, 0, w, h);
      g.addColorStop(0, c1); g.addColorStop(1, bg);
      ctx.fillStyle = g;
      ctx.globalAlpha = 0.85;
      ctx.beginPath();
      ctx.moveTo(0, h); ctx.lineTo(w * 0.62, 0); ctx.lineTo(w, 0); ctx.lineTo(w, h);
      ctx.closePath(); ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = c2; ctx.lineWidth = h * 0.035;
      ctx.beginPath(); ctx.moveTo(w * 0.1, h); ctx.lineTo(w * 0.72, 0); ctx.stroke();
      break;
    }
    case 'chevron': {
      ctx.fillStyle = c1;
      for (let i = -1; i < 7; i++) {
        const x = i * (w / 5.2);
        ctx.beginPath();
        ctx.moveTo(x, h); ctx.lineTo(x + w / 10, h);
        ctx.lineTo(x + w / 10 + h * 0.5, 0); ctx.lineTo(x + h * 0.5, 0);
        ctx.closePath(); ctx.fill();
      }
      ctx.fillStyle = c2; ctx.globalAlpha = 0.35;
      ctx.fillRect(0, h * 0.72, w, h * 0.06);
      break;
    }
    case 'hazard': {
      ctx.fillStyle = c1;
      for (let i = -2; i < 14; i++) {
        ctx.beginPath();
        const x = i * (w / 9);
        ctx.moveTo(x, h); ctx.lineTo(x + w / 18, h);
        ctx.lineTo(x + w / 18 + h, 0); ctx.lineTo(x + h, 0);
        ctx.closePath(); ctx.fill();
      }
      ctx.fillStyle = c2; ctx.globalAlpha = 0.4;
      ctx.fillRect(0, 0, w, h * 0.14);
      ctx.fillRect(0, h * 0.86, w, h * 0.14);
      break;
    }
    case 'grid': {
      ctx.strokeStyle = c1; ctx.globalAlpha = 0.55; ctx.lineWidth = 1.4;
      const step = h / 5;
      for (let x = 0; x <= w; x += step) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
      for (let y = 0; y <= h; y += step) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
      ctx.globalAlpha = 1;
      const g = ctx.createRadialGradient(w * 0.5, h * 0.5, 0, w * 0.5, h * 0.5, w * 0.5);
      g.addColorStop(0, c2 + 'cc'); g.addColorStop(1, 'transparent');
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
      break;
    }
    case 'camo': {
      const blobs = 26;
      for (let i = 0; i < blobs; i++) {
        const t = i / blobs;
        ctx.fillStyle = i % 3 === 0 ? c1 : (i % 3 === 1 ? c2 : bg);
        ctx.globalAlpha = 0.85;
        const x = ((i * 97) % 100) / 100 * w;
        const y = ((i * 53) % 100) / 100 * h;
        const r = h * (0.16 + (i % 4) * 0.07);
        ctx.beginPath();
        for (let a = 0; a < 7; a++) {
          const ang = (a / 7) * Math.PI * 2;
          const rr = r * (0.7 + ((i * a * 31) % 10) / 22);
          const px = x + Math.cos(ang) * rr * 1.6, py = y + Math.sin(ang) * rr;
          a === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
        }
        ctx.closePath(); ctx.fill();
        void t;
      }
      break;
    }
    case 'rays': {
      ctx.translate(w * 0.5, h * 1.1);
      for (let i = 0; i < 18; i++) {
        ctx.fillStyle = i % 2 ? c1 : c2;
        ctx.globalAlpha = i % 2 ? 0.55 : 0.28;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        const a0 = (i / 18) * Math.PI * 2, a1 = ((i + 1) / 18) * Math.PI * 2;
        ctx.lineTo(Math.cos(a0) * w, Math.sin(a0) * w);
        ctx.lineTo(Math.cos(a1) * w, Math.sin(a1) * w);
        ctx.closePath(); ctx.fill();
      }
      break;
    }
    case 'splitv': {
      ctx.fillStyle = c1;
      ctx.beginPath();
      ctx.moveTo(0, 0); ctx.lineTo(w * 0.46, 0); ctx.lineTo(w * 0.34, h); ctx.lineTo(0, h);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = c2;
      ctx.beginPath();
      ctx.moveTo(w * 0.48, 0); ctx.lineTo(w * 0.54, 0); ctx.lineTo(w * 0.42, h); ctx.lineTo(w * 0.36, h);
      ctx.closePath(); ctx.fill();
      break;
    }
    case 'circuit': {
      ctx.strokeStyle = c1; ctx.lineWidth = 1.8; ctx.globalAlpha = 0.75;
      for (let i = 0; i < 22; i++) {
        let x = ((i * 37) % 100) / 100 * w;
        let y = ((i * 71) % 100) / 100 * h;
        ctx.beginPath(); ctx.moveTo(x, y);
        for (let s = 0; s < 4; s++) {
          if ((i + s) % 2) x += h * 0.22; else y += h * 0.22 * ((s % 2) ? -1 : 1);
          ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.fillStyle = c2;
        ctx.beginPath(); ctx.arc(x, y, 2.6, 0, 7); ctx.fill();
      }
      break;
    }
    case 'topo': {
      ctx.strokeStyle = c1; ctx.lineWidth = 1.5; ctx.globalAlpha = 0.6;
      for (let i = 0; i < 9; i++) {
        ctx.beginPath();
        for (let x = 0; x <= w; x += 6) {
          const y = h * 0.5
            + Math.sin(x * 0.021 + i * 0.9) * h * (0.1 + i * 0.035)
            + Math.sin(x * 0.008 + i) * h * 0.12;
          x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      break;
    }
    case 'stripes': {
      for (let i = 0; i < 9; i++) {
        ctx.fillStyle = i % 2 ? c1 : c2;
        ctx.globalAlpha = i % 2 ? 0.9 : 0.28;
        ctx.fillRect(0, (i / 9) * h, w, h / 9 * 0.62);
      }
      break;
    }
    case 'hex': {
      ctx.strokeStyle = c1; ctx.lineWidth = 1.6; ctx.globalAlpha = 0.7;
      const r = h * 0.17;
      for (let row = -1; row < 6; row++) {
        for (let col = -1; col < 18; col++) {
          const x = col * r * 1.72 + (row % 2 ? r * 0.86 : 0);
          const y = row * r * 1.5;
          ctx.beginPath();
          for (let a = 0; a < 6; a++) {
            const ang = (a / 6) * Math.PI * 2 + Math.PI / 6;
            const px = x + Math.cos(ang) * r, py = y + Math.sin(ang) * r;
            a === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
          }
          ctx.closePath(); ctx.stroke();
        }
      }
      break;
    }
    default: { // smoke
      for (let i = 0; i < 16; i++) {
        const x = ((i * 61) % 100) / 100 * w;
        const y = ((i * 29) % 100) / 100 * h;
        const r = h * (0.3 + (i % 5) * 0.14);
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, (i % 2 ? c1 : c2) + '55');
        g.addColorStop(1, 'transparent');
        ctx.fillStyle = g;
        ctx.fillRect(x - r, y - r, r * 2, r * 2);
      }
      break;
    }
  }
  ctx.restore();
}

// ------------------------------------------------------------ emblems
function paintEmblem(ctx, w, h, def) {
  const size = h * 0.62;
  const cx = w * 0.155, cy = h * 0.5;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(size / 100, size / 100);
  ctx.fillStyle = def.colors[2];
  ctx.strokeStyle = def.colors[2];
  ctx.lineWidth = 7;
  ctx.lineJoin = 'round';
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur = 8;

  const path = (pts, close = true) => {
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
    if (close) ctx.closePath();
  };

  switch (def.emblem) {
    case 'skull':
      ctx.beginPath(); ctx.arc(0, -12, 34, Math.PI, 0); ctx.rect(-34, -12, 68, 30); ctx.fill();
      ctx.fillStyle = def.colors[0];
      ctx.beginPath(); ctx.arc(-14, -8, 9, 0, 7); ctx.arc(14, -8, 9, 0, 7); ctx.fill();
      ctx.fillStyle = def.colors[2];
      path([[-16, 18], [16, 18], [12, 42], [-12, 42]]); ctx.fill();
      break;
    case 'crosshair':
      ctx.beginPath(); ctx.arc(0, 0, 34, 0, 7); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, -48); ctx.lineTo(0, -16); ctx.moveTo(0, 16); ctx.lineTo(0, 48);
      ctx.moveTo(-48, 0); ctx.lineTo(-16, 0); ctx.moveTo(16, 0); ctx.lineTo(48, 0);
      ctx.stroke();
      ctx.beginPath(); ctx.arc(0, 0, 5, 0, 7); ctx.fill();
      break;
    case 'wolf':
      path([[-36, 6], [-24, -34], [-8, -16], [8, -16], [24, -34], [36, 6], [0, 44]]); ctx.fill();
      ctx.fillStyle = def.colors[0];
      path([[-17, -2], [-6, 2], [-17, 10]]); ctx.fill();
      path([[17, -2], [6, 2], [17, 10]]); ctx.fill();
      break;
    case 'eagle':
      path([[0, -34], [40, -6], [20, -2], [46, 22], [8, 10], [0, 40], [-8, 10], [-46, 22], [-20, -2], [-40, -6]]);
      ctx.fill();
      break;
    case 'triangle':
      path([[0, -40], [42, 34], [-42, 34]]); ctx.stroke();
      ctx.beginPath(); ctx.rect(-5, -12, 10, 26); ctx.fill();
      ctx.beginPath(); ctx.arc(0, 24, 6, 0, 7); ctx.fill();
      break;
    case 'bolt':
      path([[8, -44], [-24, 6], [-2, 6], [-10, 44], [24, -8], [2, -8]]); ctx.fill();
      break;
    case 'anchor':
      ctx.beginPath(); ctx.arc(0, -28, 11, 0, 7); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, -18); ctx.lineTo(0, 38); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(-24, -6); ctx.lineTo(24, -6); ctx.stroke();
      ctx.beginPath(); ctx.arc(0, 8, 32, 0.35, Math.PI - 0.35); ctx.stroke();
      break;
    case 'star':
      ctx.beginPath();
      for (let i = 0; i < 10; i++) {
        const r = i % 2 ? 18 : 44;
        const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
        const px = Math.cos(a) * r, py = Math.sin(a) * r;
        i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
      }
      ctx.closePath(); ctx.fill();
      break;
    case 'flame':
      ctx.beginPath();
      ctx.moveTo(0, 44);
      ctx.bezierCurveTo(-38, 22, -22, -10, -6, -44);
      ctx.bezierCurveTo(-2, -18, 14, -22, 12, -34);
      ctx.bezierCurveTo(34, -8, 32, 22, 0, 44);
      ctx.fill();
      break;
    case 'shield':
      ctx.beginPath();
      ctx.moveTo(0, -42); ctx.lineTo(38, -26); ctx.lineTo(32, 16);
      ctx.lineTo(0, 44); ctx.lineTo(-32, 16); ctx.lineTo(-38, -26);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = def.colors[0];
      path([[0, -22], [18, -14], [15, 8], [0, 24], [-15, 8], [-18, -14]]); ctx.fill();
      break;
    case 'snake':
      ctx.beginPath();
      ctx.moveTo(-38, 28);
      ctx.bezierCurveTo(-6, 34, -34, -6, -2, -6);
      ctx.bezierCurveTo(30, -6, 8, -40, 38, -34);
      ctx.stroke();
      ctx.beginPath(); ctx.arc(38, -34, 8, 0, 7); ctx.fill();
      break;
    default: // hexmark
      ctx.beginPath();
      for (let a = 0; a < 6; a++) {
        const ang = (a / 6) * Math.PI * 2 + Math.PI / 6;
        const px = Math.cos(ang) * 40, py = Math.sin(ang) * 40;
        a === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
      }
      ctx.closePath(); ctx.stroke();
      ctx.beginPath();
      for (let a = 0; a < 6; a++) {
        const ang = (a / 6) * Math.PI * 2 + Math.PI / 6;
        const px = Math.cos(ang) * 18, py = Math.sin(ang) * 18;
        a === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
      }
      ctx.closePath(); ctx.fill();
      break;
  }
  ctx.restore();
}

/**
 * Render a banner into a canvas.
 * @param {HTMLCanvasElement} canvas
 * @param {string|object} banner  id or definition
 * @param {{name?:string, level?:number, team?:number}} opts
 */
export function drawBanner(canvas, banner, opts = {}) {
  const def = typeof banner === 'string' ? findBanner(banner) : banner;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const cssW = canvas.clientWidth || canvas.width || 440;
  const cssH = Math.round(cssW / 3.44);
  if (canvas.width !== Math.round(cssW * dpr)) {
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
  }
  canvas.style.height = `${cssH}px`;

  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const img = def.image ? imageCache.get(def.id) : null;
  if (img && img.complete && img.naturalWidth) {
    // Cover-fit the supplied artwork.
    const scale = Math.max(w / img.naturalWidth, h / img.naturalHeight);
    const dw = img.naturalWidth * scale, dh = img.naturalHeight * scale;
    ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
  } else {
    paintPattern(ctx, w, h, def);
    paintEmblem(ctx, w, h, def);
  }

  // Legibility scrim under the text side.
  const scrim = ctx.createLinearGradient(w * 0.2, 0, w, 0);
  scrim.addColorStop(0, 'rgba(6,8,12,0)');
  scrim.addColorStop(0.55, 'rgba(6,8,12,0.62)');
  scrim.addColorStop(1, 'rgba(6,8,12,0.82)');
  ctx.fillStyle = scrim;
  ctx.fillRect(0, 0, w, h);

  if (opts.name) {
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    ctx.fillStyle = '#f2f5fa';
    ctx.shadowColor = 'rgba(0,0,0,0.8)';
    ctx.shadowBlur = h * 0.09;

    // Shrink long callsigns so they never run into the emblem.
    const rightPad = h * 0.14;
    const available = w - rightPad - h * 0.95;
    let size = h * 0.36;
    ctx.font = `700 ${size}px Rajdhani, "Segoe UI", sans-serif`;
    let measured = ctx.measureText(opts.name).width;
    if (measured > available) {
      size = Math.max(h * 0.18, size * (available / measured));
      ctx.font = `700 ${size}px Rajdhani, "Segoe UI", sans-serif`;
    }
    ctx.fillText(opts.name, w - rightPad, h * 0.42);
    ctx.shadowBlur = 0;

    if (opts.level != null) {
      ctx.font = `600 ${h * 0.17}px Rajdhani, "Segoe UI", sans-serif`;
      ctx.fillStyle = 'rgba(210,220,235,0.72)';
      ctx.fillText(`LEVEL ${opts.level}`, w - h * 0.14, h * 0.74);
    }
  }

  // Rarity edge.
  const rc = RARITY_COLORS[def.rarity] || RARITY_COLORS.common;
  ctx.fillStyle = rc;
  ctx.fillRect(0, h - Math.max(2, h * 0.035), w, Math.max(2, h * 0.035));
  if (opts.team === 0 || opts.team === 1) {
    ctx.fillStyle = opts.team === 0 ? '#ff6a3d' : '#39b7ff';
    ctx.fillRect(0, 0, Math.max(3, h * 0.045), h);
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, w - 1, h - 1);

  return canvas;
}

/** Convenience: a fresh canvas element with the banner already drawn. */
export function bannerCanvas(banner, widthPx, opts = {}) {
  const c = document.createElement('canvas');
  c.style.width = `${widthPx}px`;
  c.width = widthPx;
  c.height = Math.round(widthPx / 3.44);
  drawBanner(c, banner, opts);
  return c;
}
