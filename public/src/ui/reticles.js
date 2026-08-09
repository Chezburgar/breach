// Crosshairs and optic reticles.
//
// Hip-fire crosshairs open and close with the real cone of fire, so the
// crosshair is an honest readout of accuracy rather than decoration. Each optic
// gets its own reticle drawn to match the sight it belongs to.

const RETICLE_BY_CLASS = {
  'Assault Rifle': 'lines',
  SMG: 'lines',
  LMG: 'heavy',
  'Marksman Rifle': 'thin',
  Shotgun: 'circle',
  Sidearm: 'small',
};

function line(ctx, x1, y1, x2, y2) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

/**
 * Draw the hip-fire crosshair.
 * @param {HTMLCanvasElement} canvas
 * @param {{spreadPx:number, cls:string, hitFlash:number, hidden:boolean,
 *          color:string, dot:boolean}} o
 */
export function drawCrosshair(canvas, o) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const size = 256;
  if (canvas.width !== size * dpr) {
    canvas.width = canvas.height = size * dpr;
    canvas.style.width = canvas.style.height = `${size}px`;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);
  if (o.hidden) return;

  const c = size / 2;
  const style = RETICLE_BY_CLASS[o.cls] || 'lines';
  const gap = Math.max(3, o.spreadPx);
  const col = o.color || '#eaf2ff';

  ctx.lineCap = 'butt';
  ctx.strokeStyle = 'rgba(0,0,0,0.66)';
  ctx.fillStyle = 'rgba(0,0,0,0.66)';

  const drawSet = (pass) => {
    const outline = pass === 0;
    ctx.strokeStyle = outline ? 'rgba(0,0,0,0.7)' : col;
    ctx.fillStyle = outline ? 'rgba(0,0,0,0.7)' : col;

    if (style === 'circle') {
      const w = outline ? 4.4 : 2.2;
      ctx.lineWidth = w;
      for (let i = 0; i < 4; i++) {
        const a0 = i * (Math.PI / 2) + 0.32;
        const a1 = (i + 1) * (Math.PI / 2) - 0.32;
        ctx.beginPath();
        ctx.arc(c, c, gap + 6, a0, a1);
        ctx.stroke();
      }
    } else {
      const len = style === 'heavy' ? 11 : (style === 'thin' ? 8 : (style === 'small' ? 6 : 9));
      const w = (style === 'heavy' ? 3.4 : (style === 'thin' ? 1.6 : 2.4)) + (outline ? 2 : 0);
      ctx.lineWidth = w;
      line(ctx, c, c - gap, c, c - gap - len);
      line(ctx, c, c + gap, c, c + gap + len);
      line(ctx, c - gap, c, c - gap - len, c);
      line(ctx, c + gap, c, c + gap + len, c);
    }

    if (o.dot !== false && style !== 'circle') {
      const r = outline ? 2.2 : 1.2;
      ctx.beginPath();
      ctx.arc(c, c, r, 0, 7);
      ctx.fill();
    }
  };

  drawSet(0);
  drawSet(1);

  // Kill confirmation flash.
  if (o.hitFlash > 0) {
    ctx.strokeStyle = o.hitFlash > 0.6 ? '#ff4d5e' : '#ffffff';
    ctx.lineWidth = 2.4;
    const r = 10 + (1 - o.hitFlash) * 10;
    for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      line(ctx, c + sx * r, c + sy * r, c + sx * (r + 7), c + sy * (r + 7));
    }
  }
}

/**
 * Draw a 1x optic reticle (red dot, holo, reflex). Magnified optics are drawn
 * by `drawScopeOverlay` instead, since they need the full-screen mask.
 */
export function drawOpticReticle(canvas, scopeId, opts = {}) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const size = 256;
  if (canvas.width !== size * dpr) {
    canvas.width = canvas.height = size * dpr;
    canvas.style.width = canvas.style.height = `${size}px`;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);

  const c = size / 2;
  const tint = opts.tint || '#ff3b30';
  ctx.save();
  ctx.shadowColor = tint;
  ctx.shadowBlur = 10;
  ctx.strokeStyle = tint;
  ctx.fillStyle = tint;

  switch (scopeId) {
    case 'dot':
    case 'reddot':
      ctx.beginPath(); ctx.arc(c, c, 2.1, 0, 7); ctx.fill();
      ctx.globalAlpha = 0.35;
      ctx.beginPath(); ctx.arc(c, c, 4.6, 0, 7); ctx.fill();
      break;

    case 'holo':
      ctx.lineWidth = 1.6;
      ctx.globalAlpha = 0.9;
      ctx.beginPath(); ctx.arc(c, c, 16, 0, 7); ctx.stroke();
      for (let i = 0; i < 4; i++) {
        const a = i * (Math.PI / 2);
        line(ctx, c + Math.cos(a) * 13, c + Math.sin(a) * 13, c + Math.cos(a) * 19, c + Math.sin(a) * 19);
      }
      ctx.beginPath(); ctx.arc(c, c, 1.9, 0, 7); ctx.fill();
      break;

    case 'chevron':
    case 'reflex':
      ctx.lineWidth = 2.0;
      ctx.beginPath();
      ctx.moveTo(c - 7, c + 5);
      ctx.lineTo(c, c - 4);
      ctx.lineTo(c + 7, c + 5);
      ctx.stroke();
      ctx.beginPath(); ctx.arc(c, c + 9, 1.3, 0, 7); ctx.fill();
      break;

    default:
      break;
  }
  ctx.restore();
}

/**
 * Full-screen scope mask plus reticle for magnified optics. Everything outside
 * the ocular circle is blacked out, and the lens edge gets a soft shadow.
 */
export function drawScopeOverlay(canvas, o) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.round(window.innerWidth * dpr);
  const h = Math.round(window.innerHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (!o.visible) return;

  const cx = w / 2 + (o.offsetX || 0) * dpr;
  const cy = h / 2 + (o.offsetY || 0) * dpr;
  const r = o.radius * dpr;
  const alpha = o.blend ?? 1;

  // Blackout outside the ocular.
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  ctx.rect(0, 0, w, h);
  ctx.arc(cx, cy, r, 0, Math.PI * 2, true);
  ctx.fillStyle = '#000';
  ctx.fill();

  // Soft lens shadow just inside the rim.
  const grad = ctx.createRadialGradient(cx, cy, r * 0.7, cx, cy, r);
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(0.82, 'rgba(0,0,0,0.35)');
  grad.addColorStop(1, 'rgba(0,0,0,0.95)');
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, 7);
  ctx.fillStyle = grad;
  ctx.fill();

  // Rim highlight.
  ctx.beginPath();
  ctx.arc(cx, cy, r - 1, 0, 7);
  ctx.strokeStyle = 'rgba(160,175,190,0.28)';
  ctx.lineWidth = 2 * dpr;
  ctx.stroke();
  ctx.restore();

  // --- reticle ---
  ctx.save();
  ctx.translate(cx, cy);
  ctx.globalAlpha = alpha;
  const tint = o.tint || '#ff5540';
  const S = r;                       // reticle scales with the ocular
  ctx.strokeStyle = 'rgba(12,12,14,0.92)';
  ctx.fillStyle = 'rgba(12,12,14,0.92)';

  const reticle = (col) => {
    ctx.strokeStyle = col;
    ctx.fillStyle = col;
    switch (o.reticle) {
      case 'x15': {
        // German post: heavy posts left, right and below, fine cross centre.
        ctx.lineWidth = 0.045 * S;
        line(ctx, -S, 0, -0.16 * S, 0);
        line(ctx, S, 0, 0.16 * S, 0);
        line(ctx, 0, S, 0, 0.16 * S);
        ctx.lineWidth = 0.008 * S;
        line(ctx, -0.16 * S, 0, 0.16 * S, 0);
        line(ctx, 0, -0.5 * S, 0, 0.16 * S);
        break;
      }
      case 'x2': {
        ctx.lineWidth = 0.012 * S;
        line(ctx, -S, 0, -0.06 * S, 0);
        line(ctx, S, 0, 0.06 * S, 0);
        line(ctx, 0, -S, 0, -0.06 * S);
        line(ctx, 0, S, 0, 0.06 * S);
        ctx.lineWidth = 0.01 * S;
        for (let i = 1; i <= 4; i++) {
          const y = i * 0.13 * S;
          line(ctx, -0.05 * S, y, 0.05 * S, y);
        }
        ctx.beginPath(); ctx.arc(0, 0, 0.012 * S, 0, 7); ctx.fill();
        break;
      }
      case 'x25':
      case 'x3': {
        const fine = o.reticle === 'x3' ? 0.007 : 0.009;
        ctx.lineWidth = fine * S;
        line(ctx, -S, 0, S, 0);
        line(ctx, 0, -S, 0, S);
        // Mil dots along the vertical and horizontal.
        for (let i = 1; i <= 5; i++) {
          const d = i * 0.135 * S;
          for (const [x, y] of [[d, 0], [-d, 0], [0, d], [0, -d]]) {
            ctx.beginPath();
            ctx.arc(x, y, 0.011 * S, 0, 7);
            ctx.fill();
          }
        }
        ctx.lineWidth = 0.03 * S;
        line(ctx, -S, 0, -0.62 * S, 0);
        line(ctx, S, 0, 0.62 * S, 0);
        line(ctx, 0, S, 0, 0.62 * S);
        break;
      }
      default: {
        ctx.lineWidth = 0.012 * S;
        line(ctx, -0.35 * S, 0, -0.05 * S, 0);
        line(ctx, 0.35 * S, 0, 0.05 * S, 0);
        line(ctx, 0, -0.35 * S, 0, -0.05 * S);
        line(ctx, 0, 0.35 * S, 0, 0.05 * S);
        break;
      }
    }
  };

  // Dark pass for contrast, then the tinted pass on top.
  ctx.save();
  ctx.translate(1.5, 1.5);
  reticle('rgba(8,8,10,0.75)');
  ctx.restore();
  ctx.shadowColor = tint;
  ctx.shadowBlur = 6;
  reticle(tint);
  ctx.restore();
}

export function reticleStyleFor(cls) {
  return RETICLE_BY_CLASS[cls] || 'lines';
}
