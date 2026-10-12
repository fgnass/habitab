// Demo websites for the preview (showcase.mjs) and promotional screenshots:
// a juice shop and the docs of an API. Everything is inline (no network), and
// the pages look like real projects, not placeholders.
//   /shop/…   Juice Shop storefront: home, product, cart, checkout (with problems)
//   /docs/…   Relay API docs

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const page = (title, css, body, script = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><style>${css}</style></head>
<body>${body}${script}</body></html>`;

// MARK: Juice Shop

const JUICES = [
  { id: 'blood-orange', name: 'Blood Orange', tag: 'Cold-pressed', desc: 'Sicilian blood oranges, pressed the morning we deliver.', price: 4.9, juice: '#d7301f', bg: '#fde8e4', fruit: 'orange' },
  { id: 'orange', name: 'Orange', tag: 'Cold-pressed', desc: 'The classic. Valencia oranges, nothing else.', price: 3.9, juice: '#f28c28', bg: '#fdeedc', fruit: 'orange' },
  { id: 'carrot-ginger', name: 'Carrot & Ginger', tag: 'Cold-pressed', desc: 'Sweet carrots with a kick of fresh ginger.', price: 4.5, juice: '#e8762b', bg: '#fdebdd', fruit: 'carrot' },
  { id: 'mango-passion', name: 'Mango & Passion Fruit', tag: 'Smoothie', desc: 'Thick, sweet and sour. Alphonso mango, passion fruit, a squeeze of lime.', price: 5.2, juice: '#f5b82e', bg: '#fdf3d8', fruit: 'mango' },
  { id: 'apple-celery', name: 'Apple & Celery', tag: 'Cold-pressed', desc: 'Green apples, celery, cucumber and lemon.', price: 4.5, juice: '#8dbe3c', bg: '#eef5de', fruit: 'apple' },
  { id: 'pink-grapefruit', name: 'Pink Grapefruit', tag: 'Cold-pressed', desc: 'Bitter, sweet, very pink.', price: 4.9, juice: '#ef6a8a', bg: '#fde6ec', fruit: 'grapefruit' },
  { id: 'beetroot-apple', name: 'Beetroot & Apple', tag: 'Cold-pressed', desc: 'Earthy beetroot, sweetened with apple.', price: 4.5, juice: '#9b1b4b', bg: '#f6e2ea', fruit: 'beet' },
  { id: 'ginger-shot', name: 'Ginger Shot', tag: 'Shot · 60 ml', desc: 'Ginger, lemon, turmeric, black pepper. Not for the faint of heart.', price: 2.9, juice: '#f2c94c', bg: '#fdf5d9', fruit: 'lemon' },
];

/** A juice bottle (SVG): flat, in the juice's color, with a white label. */
function bottle(j, size = 180) {
  const label = j.name.length > 14 ? j.name.split(' & ') : [j.name];
  return `<svg viewBox="0 0 120 200" width="${size * 0.6}" height="${size}" aria-hidden="true">
    <rect x="44" y="6" width="32" height="18" rx="3" fill="#2b2b2b"/>
    <path d="M40 24 H80 V40 Q92 50 92 70 V178 Q92 194 76 194 H44 Q28 194 28 178 V70 Q28 50 40 40 Z" fill="${j.juice}"/>
    <path d="M40 24 H80 V40 Q92 50 92 70 V178 Q92 194 76 194 H44 Q28 194 28 178 V70 Q28 50 40 40 Z" fill="#fff" opacity=".12"/>
    <rect x="34" y="52" width="6" height="110" rx="3" fill="#fff" opacity=".35"/>
    <rect x="28" y="88" width="64" height="58" fill="#fff"/>
    ${label.map((t, i) => `<text x="60" y="${label.length === 1 ? 118 : 110 + i * 18}" text-anchor="middle" font-family="-apple-system, system-ui, sans-serif" font-size="${t.length > 9 ? 9 : 11}" font-weight="700" fill="#1a1a1a">${esc(t)}</text>`).join('')}
    <text x="60" y="${label.length === 1 ? 134 : 140}" text-anchor="middle" font-family="-apple-system, system-ui, sans-serif" font-size="6.5" letter-spacing="1.2" fill="#777">JUICE SHOP</text>
  </svg>`;
}

const euro = n => `€${n.toFixed(2)}`;

const SHOP_CSS = `
  :root { --ink: #1a1a1a; --muted: #6b6b6b; --line: #e6e6e6; --orange: #f28c28; --orange-dark: #d9731a; }
  * { box-sizing: border-box; } body { margin: 0; background: #fff; color: var(--ink); font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
  a { color: inherit; text-decoration: none; }
  .promo { background: var(--ink); color: #fff; text-align: center; font-size: 13px; padding: 7px; }
  header { background: linear-gradient(100deg, #ffd9a8 0%, #ffb866 55%, #ff9f52 100%); color: var(--ink); }
  nav { max-width: 1180px; margin: 0 auto; display: flex; align-items: center; gap: 36px; padding: 0 32px; height: 68px; }
  .logo { display: flex; align-items: center; gap: 10px; font-size: 22px; font-weight: 800; letter-spacing: -.5px; }
  .logo svg { width: 30px; height: 30px; }
  nav .links { display: flex; gap: 24px; font-size: 15px; font-weight: 500; } nav .links a.on { text-decoration: underline; text-underline-offset: 6px; text-decoration-thickness: 2px; }
  nav .right { margin-left: auto; display: flex; gap: 20px; align-items: center; font-size: 14px; font-weight: 500; }
  .cart-btn { display: flex; align-items: center; gap: 8px; padding: 9px 14px; background: var(--ink); color: #fff; font-weight: 600; border-radius: 4px; }
  .cart-btn b { background: #fff; color: var(--ink); border-radius: 999px; padding: 0 7px; font-size: 12px; }
  .wrap { max-width: 1180px; margin: 0 auto; padding: 0 32px; }
  .btn { display: inline-flex; align-items: center; gap: 8px; border: 0; border-radius: 4px; padding: 13px 22px; font: 600 15px/1 inherit; cursor: pointer; }
  .btn.primary { background: var(--orange); color: var(--ink); } .btn.dark { background: var(--ink); color: #fff; } .btn.ghost { background: #fff; color: var(--ink); box-shadow: inset 0 0 0 1.5px var(--ink); }
  .hero { display: grid; grid-template-columns: 1fr 1fr; gap: 32px; align-items: center; margin: 28px 0 44px; background: #fdeedc; border-radius: 8px; padding: 40px 48px; }
  .hero h1 { font-size: 48px; line-height: 1.05; margin: 0 0 14px; letter-spacing: -1px; font-weight: 800; }
  .hero p { font-size: 17px; color: #4a4a4a; max-width: 440px; margin: 0 0 24px; }
  .hero .bottles { display: flex; justify-content: center; align-items: flex-end; gap: 18px; }
  .usp { display: flex; gap: 32px; margin: 0 0 32px; font-size: 14px; color: var(--muted); } .usp b { color: var(--ink); }
  .section-head { display: flex; align-items: baseline; justify-content: space-between; margin: 0 0 18px; }
  .section-head h2 { font-size: 26px; margin: 0; font-weight: 800; letter-spacing: -.4px; }
  .filters { display: flex; gap: 6px; } .chip { padding: 6px 12px; border: 1px solid var(--line); border-radius: 4px; font-size: 13px; color: var(--muted); }
  .chip.on { background: var(--ink); color: #fff; border-color: var(--ink); }
  .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 20px; padding-bottom: 56px; }
  .product { border: 1px solid var(--line); border-radius: 8px; overflow: hidden; display: flex; flex-direction: column; }
  .product .img { height: 220px; display: grid; place-items: center; }
  .product .body { padding: 14px 16px 16px; display: flex; flex-direction: column; gap: 4px; flex: 1; }
  .product h3 { margin: 0; font-size: 17px; } .product .tag { color: var(--muted); font-size: 13px; }
  .row { display: flex; align-items: center; justify-content: space-between; margin-top: auto; padding-top: 12px; }
  .price { font-size: 17px; font-weight: 700; } .price small { color: var(--muted); font-weight: 400; font-size: 13px; }
  .add { border: 0; border-radius: 4px; padding: 9px 14px; background: var(--orange); color: var(--ink); font: 600 13px/1 inherit; }
  .crumbs { font-size: 13px; color: var(--muted); padding: 22px 0 0; } .crumbs a { text-decoration: underline; text-underline-offset: 3px; }
  .pdp { display: grid; grid-template-columns: 1fr 1fr; gap: 48px; padding: 24px 0 60px; }
  .pdp .stage { border-radius: 8px; display: grid; place-items: center; height: 520px; }
  .pdp h1 { font-size: 40px; margin: 6px 0 8px; letter-spacing: -.6px; font-weight: 800; } .pdp .lead { color: #4a4a4a; font-size: 16.5px; margin: 10px 0 22px; }
  .pdp .tag { color: var(--muted); font-size: 14px; }
  .opt { margin: 18px 0 0; } .opt label { font-size: 13px; color: var(--muted); font-weight: 600; display: block; margin-bottom: 8px; }
  .seg { display: flex; gap: 8px; } .seg span { padding: 10px 16px; border: 1px solid var(--line); border-radius: 4px; font-size: 14px; }
  .seg span.on { border-color: var(--ink); box-shadow: inset 0 0 0 1px var(--ink); font-weight: 600; }
  .buy { display: flex; gap: 12px; margin-top: 26px; align-items: center; }
  .qty { display: flex; align-items: center; gap: 14px; padding: 11px 16px; border: 1px solid var(--line); border-radius: 4px; font-weight: 600; }
  .facts { margin-top: 28px; border-top: 1px solid var(--line); display: grid; grid-template-columns: repeat(3, 1fr); }
  .facts div { padding: 14px 0; font-size: 13px; color: var(--muted); } .facts b { display: block; color: var(--ink); font-size: 15px; }
  .two { display: grid; grid-template-columns: 1.5fr 1fr; gap: 32px; padding: 28px 0 60px; align-items: start; }
  .panel { border: 1px solid var(--line); border-radius: 8px; padding: 24px; }
  .panel h2 { margin: 0 0 16px; font-size: 22px; font-weight: 800; letter-spacing: -.3px; }
  .line { display: grid; grid-template-columns: 76px 1fr auto auto; gap: 18px; align-items: center; padding: 16px 0; border-top: 1px solid var(--line); }
  .line.compact { grid-template-columns: 64px 1fr auto; gap: 14px; } .line.compact .thumb { width: 64px; height: 64px; }
  .line:first-of-type { border-top: 0; } .line .thumb { width: 76px; height: 76px; border-radius: 6px; display: grid; place-items: center; overflow: hidden; }
  .line h4 { margin: 0; font-size: 16px; } .line p { margin: 2px 0 0; color: var(--muted); font-size: 13px; }
  .sum { display: flex; justify-content: space-between; padding: 7px 0; font-size: 14.5px; color: var(--muted); } .sum b { color: var(--ink); }
  .sum.total { border-top: 1px solid var(--line); margin-top: 8px; padding-top: 14px; font-size: 18px; color: var(--ink); font-weight: 700; }
  .field { display: grid; gap: 6px; margin-bottom: 14px; } .field span { font-size: 13px; color: var(--muted); font-weight: 600; }
  .field input { font: inherit; padding: 12px 14px; border-radius: 4px; border: 1px solid #cfcfcf; background: #fff; }
  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; } .cols3 { display: grid; grid-template-columns: 2fr 1fr 1fr; gap: 14px; }
  .ship { display: grid; gap: 10px; } .ship div { display: flex; justify-content: space-between; padding: 14px 16px; border-radius: 4px; border: 1px solid var(--line); font-size: 14px; }
  .ship div.on { border-color: var(--ink); box-shadow: inset 0 0 0 1px var(--ink); }
  .steps { display: flex; gap: 10px; align-items: center; font-size: 13px; color: var(--muted); margin: 26px 0 0; } .steps b { color: var(--ink); }
  footer { border-top: 1px solid var(--line); margin-top: 20px; padding: 26px 32px; color: var(--muted); font-size: 13px; display: flex; justify-content: space-between; max-width: 1180px; margin-left: auto; margin-right: auto; }
`;

const LOGO = `<svg viewBox="0 0 32 32"><circle cx="16" cy="16" r="15" fill="#1a1a1a"/><circle cx="16" cy="16" r="11" fill="#f28c28"/><path d="M16 5 V27 M5 16 H27 M8.2 8.2 L23.8 23.8 M23.8 8.2 L8.2 23.8" stroke="#1a1a1a" stroke-width="1.5"/><circle cx="16" cy="16" r="2.4" fill="#1a1a1a"/></svg>`;

function shopChrome(active, body) {
  const links = [['Juices', '/shop'], ['Shots', '#'], ['Bundles', '#'], ['Subscriptions', '#'], ['About', '#']];
  return `<div class="promo">Free delivery in Hamburg from €20 · Pressed every morning</div>
  <header><nav><a class="logo" href="/shop">${LOGO}Juice Shop</a>
    <div class="links">${links.map(([t, h]) => `<a href="${h}" class="${t === active ? 'on' : ''}">${t}</a>`).join('')}</div>
    <div class="right"><span>Search</span><span>Account</span><a class="cart-btn" href="/shop/cart">Cart <b>3</b></a></div></nav></header>
  ${body}
  <footer><span>© 2026 Juice Shop GmbH, Hamburg</span><span>Delivery · Returns · Contact · Imprint</span></footer>`;
}

const tint = j => `background: ${j.bg}`;

function shopHome() {
  const [a, b, c] = [JUICES[2], JUICES[0], JUICES[4]];
  return page('Juice Shop — Fresh juice, delivered', SHOP_CSS, shopChrome('Juices', `<div class="wrap">
    <section class="hero"><div>
      <h1>Fresh juice. Pressed today, at your door tomorrow.</h1>
      <p>Cold-pressed from whole fruit and vegetables, no sugar, no concentrate. Order by 6 pm for next-morning delivery.</p>
      <a class="btn dark" href="/shop/juice/blood-orange">Shop juices</a> &nbsp; <a class="btn ghost" href="#">Build a bundle</a>
    </div>
    <div class="bottles">${bottle(a, 200)}${bottle(b, 250)}${bottle(c, 200)}</div>
    </section>
    <div class="usp"><span><b>Next-morning delivery</b> in Hamburg</span><span><b>Bottle deposit</b> €0.25, returned on pickup</span><span><b>Best before</b> 4 days, unpasteurised</span></div>
    <div class="section-head"><h2>All juices</h2>
      <div class="filters"><span class="chip on">All</span><span class="chip">Cold-pressed</span><span class="chip">Smoothies</span><span class="chip">Shots</span></div></div>
    <div class="grid">${JUICES.map(j => `<a class="product" href="/shop/juice/${j.id}">
      <div class="img" style="${tint(j)}">${bottle(j, 170)}</div>
      <div class="body"><h3>${esc(j.name)}</h3><div class="tag">${esc(j.tag)}</div>
        <div class="row"><div class="price">${euro(j.price)} <small>/ ${j.id === 'ginger-shot' ? '60 ml' : '250 ml'}</small></div><button class="add">Add</button></div></div></a>`).join('')}
    </div></div>`));
}

function shopProduct(id) {
  const j = JUICES.find(x => x.id === id) ?? JUICES[0];
  return page(`${j.name} — Juice Shop`, SHOP_CSS, shopChrome('Juices', `<div class="wrap">
    <div class="crumbs"><a href="/shop">Juices</a> / ${esc(j.name)}</div>
    <section class="pdp"><div class="stage" style="${tint(j)}">${bottle(j, 400)}</div>
    <div><div class="tag">${esc(j.tag)}</div>
      <h1>${esc(j.name)}</h1>
      <div class="price" style="font-size:22px">${euro(j.price)} <small>/ 250 ml · incl. VAT, plus €0.25 deposit</small></div>
      <p class="lead">${esc(j.desc)}</p>
      <div class="opt"><label>Size</label><div class="seg"><span class="on">250 ml · ${euro(j.price)}</span><span>500 ml · ${euro(j.price * 1.8)}</span><span>1 l · ${euro(j.price * 3.2)}</span></div></div>
      <div class="opt"><label>Delivery</label><div class="seg"><span class="on">Once</span><span>Every week · −10 %</span></div></div>
      <div class="buy"><span class="qty">−&nbsp; 1 &nbsp;+</span><a class="btn primary" href="/shop/cart">Add to cart · ${euro(j.price)}</a></div>
      <div class="facts"><div><b>Tomorrow</b>Delivery</div><div><b>4 days</b>Best before</div><div><b>Returnable</b>Glass bottle</div></div>
    </div></section></div>`));
}

const CART = [{ j: JUICES[0], qty: 2, size: '500 ml' }, { j: JUICES[2], qty: 1, size: '250 ml' }];
/** Cart lines; `compact` (order summary): the quantity as text instead of the stepper. */
const cartLines = (compact = false) => CART.map(({ j, qty, size }) => `<div class="line${compact ? ' compact' : ''}"><div class="thumb" style="${tint(j)}">${bottle(j, 60)}</div>
  <div><h4>${esc(j.name)}</h4><p>${esc(size)}${compact ? ` · Qty ${qty}` : ''}</p></div>${compact ? '' : `<span class="qty">−&nbsp; ${qty} &nbsp;+</span>`}<b>${euro(j.price * qty * (size.startsWith('500') ? 1.8 : 1))}</b></div>`).join('');
const subtotal = () => CART.reduce((n, { j, qty, size }) => n + j.price * qty * (size.startsWith('500') ? 1.8 : 1), 0);

function shopCart() {
  const sub = subtotal();
  return page('Your cart — Juice Shop', SHOP_CSS, shopChrome('', `<div class="wrap">
    <div class="steps"><b>Cart</b> → Delivery → Payment</div>
    <section class="two"><div class="panel"><h2>Your cart</h2>${cartLines()}</div>
    <div class="panel"><h2>Summary</h2>
      <div class="sum"><span>Subtotal</span><b>${euro(sub)}</b></div><div class="sum"><span>Deposit (3 bottles)</span><b>€0.75</b></div><div class="sum"><span>Delivery</span><b>Free</b></div>
      <div class="sum total"><span>Total</span><span>${euro(sub + 0.75)}</span></div>
      <a class="btn primary" style="width:100%;justify-content:center;margin-top:18px" href="/shop/checkout">Checkout</a>
      <p style="color:var(--muted);font-size:13px;margin:14px 0 0">Order by 6 pm for delivery tomorrow morning.</p></div></section></div>`));
}

function shopCheckout() {
  const sub = subtotal();
  // The checkout has bugs on purpose: a failed stock check and a script error (problem list demo).
  const script = `<script>
    fetch('/api/stock?items=blood-orange,carrot-ginger').then(r => { if (!r.ok) console.error('Stock check failed:', r.status, r.statusText); });
    setTimeout(() => { document.querySelector('#total').textContent = '€' + cart.total.toFixed(2); });
  </script>`;
  return page('Checkout — Juice Shop', SHOP_CSS, shopChrome('', `<div class="wrap">
    <div class="steps">Cart → <b>Delivery</b> → Payment</div>
    <section class="two"><div class="panel"><h2>Delivery address</h2>
      <div class="field"><span>Email</span><input value="mara.lindqvist@example.com"></div>
      <div class="cols"><div class="field"><span>First name</span><input value="Mara"></div><div class="field"><span>Last name</span><input value="Lindqvist"></div></div>
      <div class="field"><span>Street</span><input value="Schanzenstraße 34"></div>
      <div class="cols3"><div class="field"><span>City</span><input value="Hamburg"></div><div class="field"><span>ZIP</span><input value="20357"></div><div class="field"><span>Country</span><input value="Germany"></div></div>
      <h2 style="margin-top:10px">Delivery slot</h2>
      <div class="ship"><div class="on"><span><b>Tomorrow</b> · 6–9 am</span><b>Free</b></div><div><span><b>Tomorrow</b> · 9–12 am</span><b>Free</b></div><div><span><b>Today</b> · by courier within 2 h</span><b>€4.90</b></div></div>
      <a class="btn primary" style="margin-top:22px" href="#">Continue to payment →</a></div>
    <div class="panel"><h2>Order</h2>${cartLines(true)}
      <div class="sum"><span>Subtotal</span><b>${euro(sub)}</b></div><div class="sum"><span>Deposit (3 bottles)</span><b>€0.75</b></div><div class="sum"><span>Delivery</span><b>Free</b></div>
      <div class="sum total"><span>Total</span><span id="total">${euro(sub + 0.75)}</span></div></div></section></div>`), script);
}

// MARK: Relay API docs

const DOCS_CSS = `
  :root { --ink: #0f172a; --muted: #64748b; --line: #e2e8f0; --accent: #4f46e5; --soft: #eef2ff; }
  * { box-sizing: border-box; } body { margin: 0; color: var(--ink); background: #fff; font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
  .top { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 24px; padding: 0 28px; height: 60px; border-bottom: 1px solid var(--line); background: rgba(255,255,255,.92); backdrop-filter: blur(8px); }
  .brand { display: flex; align-items: center; gap: 10px; font-weight: 700; font-size: 17px; } .brand svg { width: 28px; height: 28px; }
  .brand span { font-weight: 500; color: var(--muted); padding-left: 10px; border-left: 1px solid var(--line); }
  .search { flex: 1; max-width: 420px; display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; border-radius: 10px; background: #f8fafc; border: 1px solid var(--line); color: #94a3b8; font-size: 14px; }
  .search kbd { font: 12px ui-monospace, Menlo, monospace; padding: 1px 6px; border-radius: 5px; border: 1px solid var(--line); background: #fff; color: var(--muted); }
  .top .links { margin-left: auto; display: flex; gap: 22px; font-size: 14px; color: var(--muted); align-items: center; }
  .top .links b { color: var(--ink); } .ver { padding: 4px 9px; border-radius: 7px; background: var(--soft); color: var(--accent); font-weight: 600; font-size: 12.5px; }
  .dash { padding: 7px 14px; border-radius: 9px; background: var(--ink); color: #fff; font-weight: 600; }
  .layout { display: grid; grid-template-columns: 240px minmax(0, 1fr) 480px; }
  nav { padding: 24px 20px; border-right: 1px solid var(--line); font-size: 14px; min-height: calc(100vh - 60px); }
  nav h5 { margin: 18px 0 6px; font-size: 11.5px; text-transform: uppercase; letter-spacing: 1.1px; color: #94a3b8; } nav h5:first-child { margin-top: 0; }
  nav a { display: flex; align-items: center; gap: 8px; padding: 5px 10px; border-radius: 7px; color: #334155; text-decoration: none; }
  nav a.on { background: var(--soft); color: var(--accent); font-weight: 600; }
  .m { font: 700 10px ui-monospace, Menlo, monospace; padding: 1px 5px; border-radius: 4px; }
  .m.post { background: #dcfce7; color: #15803d; } .m.get { background: #dbeafe; color: #1d4ed8; } .m.del { background: #fee2e2; color: #b91c1c; }
  article { padding: 32px 44px 60px; min-width: 0; }
  .crumb { font-size: 13px; color: var(--accent); font-weight: 600; } article h1 { font-size: 34px; letter-spacing: -.6px; margin: 6px 0 10px; line-height: 1.15; }
  article .lead { font-size: 16.5px; color: #475569; margin: 0 0 22px; }
  .endpoint { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-radius: 10px; background: #f8fafc; border: 1px solid var(--line); font: 14px ui-monospace, Menlo, monospace; }
  .endpoint .m { font-size: 11.5px; padding: 3px 7px; }
  article h2 { font-size: 19px; margin: 30px 0 10px; } .param { padding: 13px 0; border-top: 1px solid var(--line); }
  .param .n { font: 600 14px ui-monospace, Menlo, monospace; } .param .t { color: var(--muted); font-size: 13px; margin-left: 8px; } .param .req { color: #db2777; font-size: 12px; font-weight: 600; margin-left: 8px; }
  .param p { margin: 4px 0 0; color: #475569; font-size: 14px; } code { font: 13px ui-monospace, Menlo, monospace; background: #f1f5f9; padding: 1px 5px; border-radius: 5px; }
  .note { margin-top: 22px; display: flex; gap: 12px; padding: 14px 16px; border-radius: 12px; background: #fffbeb; border: 1px solid #fde68a; color: #78350f; font-size: 14px; }
  .code { padding: 32px 28px; background: #f8fafc; border-left: 1px solid var(--line); }
  .block { border-radius: 14px; overflow: hidden; background: #0b1020; color: #e2e8f0; box-shadow: 0 12px 30px -16px rgba(15,23,42,.5); margin-bottom: 18px; }
  .block .tabs { display: flex; gap: 2px; padding: 8px 10px 0; background: #121933; font-size: 12.5px; }
  .block .tabs span { padding: 7px 12px; border-radius: 8px 8px 0 0; color: #94a3b8; } .block .tabs span.on { background: #0b1020; color: #fff; }
  .block .tabs .copy { margin-left: auto; } pre { margin: 0; padding: 16px 18px; font: 12px/1.65 ui-monospace, SFMono-Regular, Menlo, monospace; overflow: hidden; }
  .k { color: #c084fc; } .s { color: #86efac; } .f { color: #7dd3fc; } .c { color: #64748b; } .n { color: #fda4af; } .p { color: #fcd34d; }
  .block .status { display: flex; justify-content: space-between; padding: 9px 16px; background: #121933; font-size: 12.5px; color: #94a3b8; } .block .status b { color: #86efac; }
`;

const RELAY_LOGO = `<svg viewBox="0 0 32 32"><rect width="32" height="32" rx="9" fill="#4f46e5"/><path d="M9 21 L16 10 L23 21" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><circle cx="16" cy="21" r="2.6" fill="#a5b4fc"/></svg>`;

function docs() {
  const nav = [
    ['Get started', [['Introduction'], ['Quickstart'], ['Authentication'], ['Rate limits']]],
    ['Messages', [['Send a message', 'post', true], ['Get a message', 'get'], ['List messages', 'get'], ['Cancel a message', 'del']]],
    ['Webhooks', [['Events'], ['Verify signatures'], ['Retries']]],
    ['SDKs', [['Node.js'], ['Python'], ['Go']]],
  ];
  const params = [
    ['to', 'string', true, 'Recipient in E.164 format (<code>+4917612345678</code>) or a channel id such as <code>wa:4917612345678</code>.'],
    ['channel', 'enum', true, 'One of <code>sms</code>, <code>whatsapp</code>, <code>email</code>. Relay falls back along <code>fallback</code> when delivery fails.'],
    ['template', 'string', false, 'Id of an approved template. Required for WhatsApp messages outside the 24-hour window.'],
    ['variables', 'object', false, 'Values for the template’s placeholders, for example <code>{"name": "Mara"}</code>.'],
    ['send_at', 'timestamp', false, 'Schedules the message. Up to 30 days ahead; omitted means now.'],
  ];
  return page('Send a message — Relay API Docs', DOCS_CSS, `<div class="top">
    <div class="brand">${RELAY_LOGO}Relay<span>Docs</span></div>
    <div class="search">Search the docs… <kbd>⌘K</kbd></div>
    <div class="links"><b>Guides</b><span>API reference</span><span>Changelog</span><span class="ver">v2.4</span><span class="dash">Dashboard</span></div></div>
  <div class="layout"><nav>${nav.map(([h, items]) => `<h5>${h}</h5>${items.map(([t, m, on]) => `<a href="#" class="${on ? 'on' : ''}">${m ? `<span class="m ${m}">${m === 'del' ? 'DEL' : m.toUpperCase()}</span>` : ''}${t}</a>`).join('')}`).join('')}</nav>
  <article><div class="crumb">Messages</div><h1>Send a message</h1>
    <p class="lead">Sends one message over SMS, WhatsApp or email. Relay picks the route, retries on failure and reports every status change to your webhook.</p>
    <div class="endpoint"><span class="m post">POST</span>https://api.relay.dev/v2/messages</div>
    <h2>Body parameters</h2>${params.map(([n, t, req, d]) => `<div class="param"><span class="n">${n}</span><span class="t">${t}</span>${req ? '<span class="req">required</span>' : ''}<p>${d}</p></div>`).join('')}
    <div class="note"><b>Idempotency</b><span>Send an <code>Idempotency-Key</code> header to retry safely: the same key never sends a message twice within 24 hours.</span></div>
  </article>
  <div class="code"><div class="block"><div class="tabs"><span>cURL</span><span class="on">Node.js</span><span>Python</span><span class="copy">Copy</span></div>
<pre><span class="k">import</span> Relay <span class="k">from</span> <span class="s">'@relay/node'</span>;

<span class="k">const</span> relay <span class="k">=</span> <span class="k">new</span> <span class="f">Relay</span>(process.env.<span class="p">RELAY_KEY</span>);

<span class="k">const</span> message <span class="k">=</span> <span class="k">await</span> relay.messages.<span class="f">send</span>({
  to: <span class="s">'+4917612345678'</span>,
  channel: <span class="s">'whatsapp'</span>,
  template: <span class="s">'order_shipped'</span>,
  variables: { name: <span class="s">'Mara'</span>, order: <span class="s">'#4821'</span> },
  fallback: [<span class="s">'sms'</span>],
});

console.<span class="f">log</span>(message.status); <span class="c">// "queued"</span></pre></div>
  <div class="block"><div class="tabs"><span class="on">Response</span></div>
<pre>{
  <span class="p">"id"</span>: <span class="s">"msg_01JA7Q3V9KX2"</span>,
  <span class="p">"status"</span>: <span class="s">"queued"</span>,
  <span class="p">"channel"</span>: <span class="s">"whatsapp"</span>,
  <span class="p">"to"</span>: <span class="s">"+4917612345678"</span>,
  <span class="p">"segments"</span>: <span class="n">1</span>,
  <span class="p">"price_eur"</span>: <span class="n">0.0412</span>,
  <span class="p">"created_at"</span>: <span class="s">"2026-10-12T08:14:03Z"</span>
}</pre><div class="status"><span><b>●</b> 202 Accepted</span><span>48 ms</span></div></div></div>
  </div>`);
}

// MARK: Server

/** Request handler for the demo sites. */
export function demoSite(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (p.startsWith('/api/')) {
    res.statusCode = 503;
    res.setHeader('content-type', 'application/json');
    return res.end('{"error":"inventory service unavailable"}');
  }
  res.setHeader('content-type', 'text/html; charset=utf-8');
  if (p === '/' || p === '/shop') return res.end(shopHome());
  if (p.startsWith('/shop/juice/')) return res.end(shopProduct(p.split('/').pop()));
  if (p === '/shop/cart') return res.end(shopCart());
  if (p === '/shop/checkout') return res.end(shopCheckout());
  if (p.startsWith('/docs')) return res.end(docs());
  res.statusCode = 404;
  res.end(page('Not found', SHOP_CSS, '<p style="padding:40px">Not found</p>'));
}
