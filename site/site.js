const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;

document.querySelectorAll('[data-copy]').forEach((button) => {
  const label = button.querySelector('span');
  let timer;
  button.addEventListener('click', async () => {
    await navigator.clipboard.writeText(document.getElementById(button.dataset.copy).textContent.trim());
    button.classList.add('done');
    label.textContent = 'Copied';
    clearTimeout(timer);
    timer = setTimeout(() => {
      button.classList.remove('done');
      label.textContent = 'Copy';
    }, 1800);
  });
});

const NS = 'http://www.w3.org/2000/svg';
const wire = (svg, d, pulse, delay) => {
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', d);
  svg.append(path);
  if (!pulse) return;
  const dot = path.cloneNode();
  dot.classList.add('pulse');
  dot.style.animationDelay = `${delay}s`;
  svg.append(dot);
};

const drawFlow = (flow) => {
  const svg = flow.querySelector('.flow-wires');
  const hub = flow.querySelector('[data-hub]').getBoundingClientRect();
  const box = flow.getBoundingClientRect();
  const at = (r) => ({ l: r.left - box.left, r: r.right - box.left, t: r.top - box.top, b: r.bottom - box.top, x: r.left - box.left + r.width / 2, y: r.top - box.top + r.height / 2 });
  const h = at(hub);
  svg.replaceChildren();
  const apps = [...flow.querySelectorAll('[data-from]')].map((el) => at(el.getBoundingClientRect()));
  const sessions = [...flow.querySelectorAll('[data-to]')].map((el) => at(el.getBoundingClientRect()));
  const stacked = apps[0].b < h.t && apps[0].r > h.l;
  if (stacked) {
    const appsBottom = Math.max(...apps.map((a) => a.b));
    const sessionsTop = Math.min(...sessions.map((s) => s.t));
    const folder = at(flow.querySelector('[data-folder]').getBoundingClientRect());
    wire(svg, `M${h.x} ${appsBottom} V${h.t}`, true, 0);
    wire(svg, `M${h.x} ${folder.b} V${sessionsTop}`, true, 1.2);
    return;
  }
  const curve = (x1, y1, x2, y2) => {
    const mx = (x1 + x2) / 2;
    return `M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`;
  };
  apps.forEach((a, i) => wire(svg, curve(a.r, a.y, h.l, h.y), i % 2 === 0, i * 0.45));
  sessions.forEach((s, i) => wire(svg, curve(h.r, h.y, s.l, s.y), i % 2 === 1, 0.6 + i * 0.5));
};

document.querySelectorAll('[data-flow]').forEach((flow) => {
  const draw = () => drawFlow(flow);
  new ResizeObserver(draw).observe(flow);
  document.fonts.ready.then(draw);
});

document.querySelectorAll('[data-app]').forEach((chip, _, chips) => {
  chip.addEventListener('click', () => {
    chips.forEach((other) => other.setAttribute('aria-pressed', String(other === chip)));
    document.querySelectorAll('#own-prompt [data-slot]').forEach((slot) => {
      slot.textContent = chip.dataset[slot.dataset.slot];
      if (!calm) slot.animate([{ opacity: 0, transform: 'translateY(0.3em)' }, { opacity: 1, transform: 'none' }], { duration: 200, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' });
    });
  });
});

const seen = (el, fn, margin = '0px 0px -12% 0px') => {
  new IntersectionObserver(([entry], observer) => {
    if (!entry.isIntersecting) return;
    observer.disconnect();
    fn();
  }, { rootMargin: margin }).observe(el);
};

if (!calm) {
  document.querySelectorAll('.flow, .trio > *, .bento > *, .voice > *, .size, .own-grid > *, .term, .you-do').forEach((el) => {
    el.dataset.rise = '';
    seen(el, () => el.classList.add('in'));
  });
}

const size = document.querySelector('.size');
if (size && !calm) {
  size.classList.add('reveal');
  seen(size, () => size.classList.add('in'));
}

const pipe = document.querySelector('[data-pipe]');
if (pipe) {
  const steps = [...pipe.children].slice(0, 4);
  if (calm) steps.forEach((step) => step.setAttribute('data-on', ''));
  else seen(pipe, () => steps.forEach((step, i) => setTimeout(() => step.setAttribute('data-on', ''), 250 + i * 450)));
}

const cells = document.querySelector('[data-cells]');
if (cells) {
  const W = 2167;
  const H = 737;
  const r = 20;
  const dx = Math.sqrt(3) * r;
  const dy = 1.5 * r;
  const glyph = new Path2D(document.querySelector('#wordmark path').getAttribute('d'));
  const ctx = document.createElement('canvas').getContext('2d');
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `${-r} ${-r} ${W + 2 * r} ${H + 2 * r}`);
  svg.setAttribute('aria-hidden', 'true');
  const corners = [...Array(6)].map((_, k) => {
    const a = (Math.PI / 3) * k + Math.PI / 6;
    return [Math.cos(a) * r * 0.9, Math.sin(a) * r * 0.9];
  });
  const list = [];
  for (let row = 0; row * dy <= H + r; row++) {
    for (let col = 0; col * dx <= W + dx; col++) {
      const x = col * dx + (row % 2 ? dx / 2 : 0);
      const y = row * dy;
      if (!ctx.isPointInPath(glyph, x, y)) continue;
      const hex = document.createElementNS(NS, 'polygon');
      hex.setAttribute('points', corners.map(([cx, cy]) => `${(x + cx).toFixed(1)},${(y + cy).toFixed(1)}`).join(' '));
      svg.append(hex);
      list.push({ hex, x, y });
    }
  }
  cells.append(svg);
  const light = (hex) => {
    hex.classList.add('lit');
    requestAnimationFrame(() => requestAnimationFrame(() => hex.classList.remove('lit')));
  };
  if (!calm) {
    seen(cells, () => list.forEach(({ hex, x }) => setTimeout(() => light(hex), x * 0.45)), '0px 0px -25% 0px');
    if (matchMedia('(hover: hover)').matches) {
      cells.addEventListener('pointermove', (event) => {
        const box = svg.getBoundingClientRect();
        const scale = (W + 2 * r) / box.width;
        const px = (event.clientX - box.left) * scale - r;
        const py = (event.clientY - box.top) * scale - r;
        for (const { hex, x, y } of list) if ((x - px) ** 2 + (y - py) ** 2 < (r * 3.2) ** 2) light(hex);
      });
    }
  }
}
