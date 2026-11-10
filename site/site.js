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
    setTimeout(() => hex.classList.remove('lit'), 80);
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

// Telegram widgets: each frame runs the widget's own code. The page stands in for Telegram and hex, which answers a request at once and changes the state after.
const widgetFrames = document.querySelectorAll('iframe[data-widget]');
if (widgetFrames.length) {
  const palette = {
    light: { bg: '#ffffff', text: '#000000', hint: '#8e8e93', link: '#1f7ae0', button: '#1f7ae0', 'button-text': '#ffffff', 'secondary-bg': '#efeff4', 'section-separator': '#e5e5ea' },
    dark: { bg: '#212030', text: '#ffffff', hint: '#8d8b9e', link: '#8fb5ff', button: '#8774e1', 'button-text': '#ffffff', 'secondary-bg': '#2d2b40', 'section-separator': '#363449' },
  };
  const lines = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];
  const won = (b, p) => lines.some((l) => l.every((i) => b[i] === p));
  const takes = (b, p) => lines.map((l) => l.filter((i) => b[i] === '.')).find((open, n) => open.length === 1 && lines[n].filter((i) => b[i] === p).length === 2)?.[0];
  const bots = {
    tasks: {
      state: { u: 'Today', i: [['Renew the passport', 'Home · due Friday', 0], ['Pick the launch photo', 'launch', 0], ['Approve the deploy', 'ramen', 1], ['Answer the landlord', 'Home', 0]] },
      answer(s, q) { s.i[+q.slice(2)][2] ^= 1; },
    },
    usage: {
      state: { r: 'Mon 9am', p: 58, h: 41, a: 'Updated 9:41', t: 3, n: ['General', 'ramen', 'dev'], d: [[5, 3, 4], [6, 2, 7], [3, 5, 6], [4, 2, 3], [0, 0, 0], [0, 0, 0], [0, 0, 0]] },
      answer(s) { s.d[3] = s.d[3].map((v) => v + (Math.random() * 2 | 0)); s.p = Math.min(s.p + 1, 96); s.h += 1; s.a = 'Updated just now'; },
    },
    game: {
      state: { b: '....X...O', s: [3, 4, 2] },
      answer(s, q) {
        const b = s.b.split('');
        if (q === 'n') { s.b = '.........'; return; }
        b[+q.slice(2)] = 'X';
        const open = () => b.map((v, i) => (v === '.' ? i : -1)).filter((i) => i >= 0);
        if (won(b, 'X')) s.s[0]++;
        else if (!open().length) s.s[2]++;
        else {
          const pick = takes(b, 'O') ?? takes(b, 'X') ?? [4, 0, 2, 6, 8, 1, 3, 5, 7].find((i) => b[i] === '.');
          b[pick] = 'O';
          if (won(b, 'O')) s.s[1]++;
          else if (!open().length) s.s[2]++;
        }
        s.b = b.join('');
      },
    },
  };
  const dark = matchMedia('(prefers-color-scheme: dark)');
  const stub = (name, scheme) => `<script>
var H={},n=0,W=window.TelegramWidget={profile:1,colorScheme:'${scheme}',chatData:${JSON.stringify(JSON.stringify(bots[name].state))},publicData:null,
onEvent:function(t,f){(H[t]=H[t]||[]).push(f)},offEvent:function(){},ready:function(){},
request:function(q){var id=++n;parent.postMessage({w:'${name}',id:id,q:q},'*');return new Promise(function(ok){addEventListener('message',function m(e){if(e.data.id!==id)return;removeEventListener('message',m);ok({result:e.data.r})})})}};
addEventListener('message',function(e){if(e.data.s===undefined)return;W.chatData=e.data.s;(H.chatDataChanged||[]).forEach(function(f){f.call(W)})});
addEventListener('DOMContentLoaded',function(){new ResizeObserver(function(){parent.postMessage({w:'${name}',h:Math.ceil(document.documentElement.getBoundingClientRect().height)},'*')}).observe(document.documentElement)});
<\/script>`;
  const load = () => {
    const scheme = dark.matches ? 'dark' : 'light';
    const vars = Object.entries(palette[scheme]).map(([k, v]) => `--tg-theme-${k}-color:${v}`).join(';');
    widgetFrames.forEach((frame) => {
      const name = frame.dataset.widget;
      frame.srcdoc = `<!doctype html><html style="color-scheme:${scheme};${vars};--tg-content-safe-area-inset-bottom:0px;color:var(--tg-theme-text-color);font:16px/1.35 system-ui,-apple-system,sans-serif"><head><meta charset="utf-8">${stub(name, scheme)}</head><body>${document.getElementById(`widget-${name}`).innerHTML}</body></html>`;
    });
  };
  addEventListener('message', (event) => {
    const { w, id, q, h } = event.data ?? {};
    const frame = [...widgetFrames].find((f) => f.dataset.widget === w && f.contentWindow === event.source);
    if (!frame) return;
    if (h) { frame.style.height = `${h}px`; return; }
    const bot = bots[w];
    frame.contentWindow.postMessage({ id, r: null }, '*');
    bot.answer(bot.state, q);
    setTimeout(() => frame.contentWindow.postMessage({ s: JSON.stringify(bot.state) }, '*'), w === 'game' ? 520 : 320);
  });
  dark.addEventListener('change', load);
  load();
}
