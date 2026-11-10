const calm = matchMedia('(prefers-reduced-motion: reduce)');

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
