type Palette = {
  bg: string;
  ink: string;
  muted: string;
  card: string;
  line: string;
  accent: string;
  accentInk: string;
  wash: string;
};

function pickPalette(brief: string): Palette {
  const text = brief.toLowerCase();
  if (/(farm|agri|prawn|shrimp|iot|sensor|aqua|ocean|monitor)/.test(text)) {
    return {
      bg: '#eef6f4',
      ink: '#10231f',
      muted: '#4d6a64',
      card: '#ffffff',
      line: '#cfe3dd',
      accent: '#0f766e',
      accentInk: '#ffffff',
      wash: '#d7efe9',
    };
  }
  if (/(coffee|cafe|roast|bean)/.test(text)) {
    return {
      bg: '#f6f1ea',
      ink: '#2a1b12',
      muted: '#7a6354',
      card: '#fffaf4',
      line: '#ead9c8',
      accent: '#8b4513',
      accentInk: '#fff',
      wash: '#f0e0cf',
    };
  }
  if (/(health|clinic|care|wellness|hospital)/.test(text)) {
    return {
      bg: '#f3f7fb',
      ink: '#132033',
      muted: '#5b6b7c',
      card: '#ffffff',
      line: '#d5e0ea',
      accent: '#2563eb',
      accentInk: '#fff',
      wash: '#dbeafe',
    };
  }
  if (/(finance|bank|pay|invoice|billing)/.test(text)) {
    return {
      bg: '#f4f6f4',
      ink: '#14201a',
      muted: '#5b6b62',
      card: '#ffffff',
      line: '#d7ddd8',
      accent: '#166534',
      accentInk: '#fff',
      wash: '#dcfce7',
    };
  }
  return {
    bg: '#f6f4ef',
    ink: '#161411',
    muted: '#6b655c',
    card: '#ffffff',
    line: '#e6e1d6',
    accent: '#c45c26',
    accentInk: '#fff',
    wash: '#f3e4d6',
  };
}

function titleFromBrief(brief: string): string {
  const line = brief.split('\n').map((part) => part.trim()).find(Boolean) ?? 'New product';
  return line.replace(/[.?!].*$/, '').slice(0, 72);
}

function brandFromTitle(title: string): string {
  const words = title
    .replace(/^(a|an|the)\s+/i, '')
    .split(/\s+/)
    .filter((word) => word.length > 2 && !/^(for|with|using|from|simple|landing|page|business)$/i.test(word));
  return (words[0] || 'Studio').replace(/[^a-z0-9]+/gi, '');
}

function featureIdeas(brief: string): Array<{ title: string; body: string }> {
  const text = brief.toLowerCase();
  const features: Array<{ title: string; body: string }> = [];
  if (/(iot|sensor|monitor)/.test(text)) {
    features.push({
      title: 'Live pond telemetry',
      body: 'Dissolved oxygen, temperature, and pH on one board — with alerts before stock is at risk.',
    });
  }
  if (/(ai|predict|forecast)/.test(text)) {
    features.push({
      title: 'Forecast, not just charts',
      body: 'Models flag stress windows so you treat water quality hours earlier.',
    });
  }
  if (/(farm|prawn|shrimp|aqua)/.test(text)) {
    features.push({
      title: 'Built for farm crews',
      body: 'Phone-first checks at the pond edge. No desktop required for the morning walk.',
    });
  }
  if (features.length < 3) {
    features.push(
      { title: 'See it in one glance', body: 'The first screen answers status, next action, and risk.' },
      { title: 'Act without a ticket', body: 'Primary buttons change state immediately — no dead ends.' },
      { title: 'Handoff-ready', body: 'Copy and layout are specific enough to build from.' },
    );
  }
  return features.slice(0, 3);
}

export function starterPrototypeHtml(title: string, brief: string): string {
  const safeTitle = escapeHtml(title || titleFromBrief(brief));
  const safeBrief = escapeHtml(brief || 'Describe the product in Studio.');
  const brand = escapeHtml(brandFromTitle(title || titleFromBrief(brief)));
  const palette = pickPalette(brief);
  const features = featureIdeas(brief);
  const isFarm = /(farm|agri|prawn|shrimp|iot|sensor|aqua|monitor)/i.test(brief);
  const snapshot = isFarm
    ? `<strong>Live snapshot</strong>
          <div class="stat"><span>Pond A — dissolved O₂</span><span class="ok">6.4 mg/L</span></div>
          <div class="stat"><span>Temperature</span><span>28.1°C</span></div>
          <div class="stat"><span>pH</span><span>7.8</span></div>
          <div class="stat"><span>Risk window</span><span class="ok">Clear for 6h</span></div>`
    : `<strong>Today</strong>
          <div class="stat"><span>Active users</span><span class="ok">128</span></div>
          <div class="stat"><span>Conversion</span><span>4.2%</span></div>
          <div class="stat"><span>Open tasks</span><span>6</span></div>
          <div class="stat"><span>Health</span><span class="ok">On track</span></div>`;
  const productCopy = isFarm
    ? {
        h1: 'One board for the farm',
        lead: 'Walk the morning route from your phone. Alerts land before you lose a crop, not after.',
        cards: [
          ['Ponds', 'Each pond has a status, last reading, and the next recommended action.', 'Connect a pond'],
          ['Alerts', 'Thresholds you set. Quiet hours you control. No page of unread noise.', ''],
          ['History', 'Week-over-week water quality so you can show buyers a clean record.', ''],
        ],
      }
    : {
        h1: 'The product, clickable',
        lead: 'This is a first-cut flow from your brief — not a generic checkout shell.',
        cards: [
          ['Overview', 'What the user sees first and why they should stay.', 'Continue'],
          ['Work', 'The core action of the product, with a visible result.', ''],
          ['Proof', 'A concrete outcome they can take to a teammate.', ''],
        ],
      };

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${safeTitle}</title>
  <style>
    :root {
      color-scheme: light;
      --bg:${palette.bg}; --ink:${palette.ink}; --muted:${palette.muted};
      --card:${palette.card}; --line:${palette.line}; --accent:${palette.accent};
      --accent-ink:${palette.accentInk}; --wash:${palette.wash};
    }
    * { box-sizing: border-box; }
    body { margin: 0; font: 16px/1.5 ui-sans-serif, system-ui, sans-serif; background: var(--bg); color: var(--ink); }
    a { color: inherit; }
    header {
      display:flex; justify-content:space-between; align-items:center; gap:16px;
      padding:14px 22px; border-bottom:1px solid var(--line); background:color-mix(in srgb, var(--card) 92%, transparent);
      position:sticky; top:0; backdrop-filter: blur(10px); z-index:2;
    }
    .brand { display:flex; align-items:center; gap:10px; font-weight:700; letter-spacing:-.02em; }
    .mark { width:28px; height:28px; border-radius:8px; background:var(--accent); color:var(--accent-ink); display:grid; place-items:center; font-size:13px; }
    nav { display:flex; gap:8px; flex-wrap:wrap; }
    button, a.btn {
      appearance:none; border:1px solid var(--line); background:var(--card); border-radius:999px;
      padding:8px 14px; cursor:pointer; color:inherit; text-decoration:none; font:inherit;
    }
    button.primary, a.btn.primary { background:var(--accent); color:var(--accent-ink); border-color:var(--accent); }
    button.ghost { background:transparent; }
    main { max-width:1080px; margin:0 auto; padding:28px 22px 96px; }
    .screen { display:none; }
    .screen.active { display:block; animation: in .28s ease; }
    @keyframes in { from { opacity:0; transform:translateY(8px);} to { opacity:1; transform:none;} }
    .hero { display:grid; grid-template-columns:1.15fr .85fr; gap:28px; align-items:center; }
    @media (max-width:800px) { .hero { grid-template-columns:1fr; } }
    .eyebrow { color:var(--accent); font-size:12px; font-weight:700; letter-spacing:.12em; text-transform:uppercase; }
    h1 { font-size:clamp(32px, 5vw, 56px); letter-spacing:-.04em; line-height:1.05; margin:10px 0 14px; }
    p.lead { color:var(--muted); font-size:18px; max-width:38rem; }
    .actions { display:flex; gap:10px; flex-wrap:wrap; margin-top:22px; }
    .panel {
      background:linear-gradient(180deg, var(--card), var(--wash));
      border:1px solid var(--line); border-radius:24px; padding:18px; min-height:280px;
      box-shadow:0 20px 50px rgba(16,35,31,.06);
    }
    .stat { display:flex; justify-content:space-between; padding:10px 0; border-bottom:1px solid var(--line); font-size:14px; }
    .stat:last-child { border-bottom:0; }
    .ok { color:var(--accent); font-weight:600; }
    .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:16px; margin-top:36px; }
    .card { background:var(--card); border:1px solid var(--line); border-radius:16px; padding:18px; }
    h2 { letter-spacing:-.03em; }
    form { display:grid; gap:12px; max-width:420px; }
    label { font-size:13px; color:var(--muted); }
    input, textarea, select {
      width:100%; padding:10px 12px; border-radius:10px; border:1px solid var(--line);
      font:inherit; background:var(--card); color:var(--ink);
    }
    .toast { position:fixed; bottom:20px; right:20px; background:var(--ink); color:#fff; padding:10px 14px; border-radius:10px; opacity:0; transform:translateY(8px); transition:.2s; }
    .toast.show { opacity:1; transform:none; }
    footer { margin-top:48px; color:var(--muted); font-size:13px; }
  </style>
</head>
<body>
  <header>
    <div class="brand"><span class="mark">${brand.slice(0, 1).toUpperCase()}</span>${brand}</div>
    <nav>
      <button data-go="home">Home</button>
      <button data-go="product">Product</button>
      <button data-go="signup">Get started</button>
    </nav>
  </header>
  <main>
    <section id="home" class="screen active">
      <div class="hero">
        <div>
          <div class="eyebrow">Prototype</div>
          <h1>${safeTitle}</h1>
          <p class="lead">${safeBrief}</p>
          <div class="actions">
            <button class="primary" data-go="product">See how it works</button>
            <button class="ghost" data-go="signup">Request a walkthrough</button>
          </div>
        </div>
        <aside class="panel" aria-label="Live snapshot">
          ${snapshot}
        </aside>
      </div>
      <div class="grid">
        ${features.map((feature) => `<article class="card"><h3>${escapeHtml(feature.title)}</h3><p>${escapeHtml(feature.body)}</p></article>`).join('\n        ')}
      </div>
    </section>
    <section id="product" class="screen">
      <div class="eyebrow">Product</div>
      <h1>${escapeHtml(productCopy.h1)}</h1>
      <p class="lead">${escapeHtml(productCopy.lead)}</p>
      <div class="grid">
        ${productCopy.cards.map(([heading, body, cta]) => `<article class="card">
          <h3>${escapeHtml(heading)}</h3>
          <p>${escapeHtml(body)}</p>
          ${cta ? `<p><button class="primary" data-go="signup">${escapeHtml(cta)}</button></p>` : ''}
        </article>`).join('\n        ')}
      </div>
    </section>
    <section id="signup" class="screen">
      <div class="eyebrow">Get started</div>
      <h1>Book a farm walkthrough</h1>
      <p class="lead">Tell us how many ponds you run. We will send a working dashboard sketch for your layout.</p>
      <form id="lead">
        <div>
          <label for="name">Farm name</label>
          <input id="name" name="name" required placeholder="Coastal Prawn Co." />
        </div>
        <div>
          <label for="ponds">Number of ponds</label>
          <input id="ponds" name="ponds" type="number" min="1" value="8" />
        </div>
        <div>
          <label for="note">What should we monitor first?</label>
          <textarea id="note" name="note" rows="3" placeholder="Dissolved oxygen on the far ponds overnight."></textarea>
        </div>
        <button class="primary" type="submit">Send request</button>
      </form>
    </section>
    <footer>Draft generated from your Studio brief. Run the design swarm to replace copy, layout, and brand.</footer>
  </main>
  <div class="toast" id="toast">Request sent — we will follow up with a pond map.</div>
  <script>
    const screens = [...document.querySelectorAll('.screen')];
    const toast = document.getElementById('toast');
    function show(id) {
      screens.forEach((s) => s.classList.toggle('active', s.id === id));
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
    document.querySelectorAll('[data-go]').forEach((el) => {
      el.addEventListener('click', () => show(el.getAttribute('data-go')));
    });
    document.getElementById('lead').addEventListener('submit', (event) => {
      event.preventDefault();
      toast.classList.add('show');
      setTimeout(() => toast.classList.remove('show'), 2200);
    });
  </script>
</body>
</html>
`;
}

export function starterNotes(title: string, brief: string): string {
  return `# ${title}

## Brief

${brief}

## Screens

- Home — hero, live snapshot, three benefits
- Product — ponds, alerts, history
- Get started — working lead form

## Interaction contract

- Every header control changes screen
- Primary CTAs never dead-end
- Form submit shows a toast

## Tokens

Generated from the brief. Replace with brand tokens during the swarm.
`;
}

export function starterHandoff(title: string): string {
  return `# Handoff — ${title}

Implement this prototype in the real product:

- Keep the three-screen information architecture.
- Recreate the live snapshot as a real telemetry card.
- Wire the lead form to the actual intake path.
- Do not ship the generated farm numbers as production data.
`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
