// Demo websites for the preview (showcase.mjs) and promotional screenshots:
// a coffee shop with its admin dashboard, and the docs of an API. Everything is
// inline (no network), and the pages look like real projects, not placeholders.
//   /shop/…   Ember & Oak storefront: home, product, cart, checkout (with problems)
//   /admin    Ember & Oak admin dashboard
//   /docs/…   Relay API docs

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const page = (title, css, body, script = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><style>${css}</style></head>
<body>${body}${script}</body></html>`;

// MARK: Ember & Oak (shop)

const COFFEES = [
  { id: 'ethiopia-guji', region: 'ETHIOPIA', desc: 'A bright, floral cup from smallholders around Hambela.', name: 'Ethiopia Guji', origin: 'Ethiopia', short: 'GUJI', notes: ['Peach', 'Jasmine', 'Bergamot'], roast: 1, price: 16.5, bag: '#2f5d50', label: '#f3e9d8', ink: '#2f5d50', process: 'Washed', altitude: '1,950–2,200 m', varietal: 'Heirloom' },
  { id: 'colombia-huila', region: 'COLOMBIA', desc: 'Grown by the Ortiz family on steep slopes above Pitalito.', name: 'Colombia Huila', origin: 'Colombia', short: 'HUILA', notes: ['Red apple', 'Caramel', 'Cocoa'], roast: 2, price: 14.0, bag: '#b4532a', label: '#fbefe3', ink: '#8c3d1d', process: 'Washed', altitude: '1,700 m', varietal: 'Caturra, Castillo' },
  { id: 'kenya-nyeri', region: 'KENYA', desc: 'Juicy and bold, from the Gatomboya cooperative in Nyeri.', name: 'Kenya Nyeri AA', origin: 'Kenya', short: 'NYERI', notes: ['Blackcurrant', 'Grapefruit', 'Molasses'], roast: 1, price: 18.0, bag: '#6b3a5b', label: '#f6e7ef', ink: '#6b3a5b', process: 'Washed', altitude: '1,800 m', varietal: 'SL28, SL34' },
  { id: 'house-espresso', region: 'BLEND', desc: 'Our everyday espresso: dense, sweet and forgiving.', name: 'Hearth Espresso', origin: 'Brazil · Guatemala', short: 'HEARTH', notes: ['Dark chocolate', 'Hazelnut', 'Brown sugar'], roast: 3, price: 13.5, bag: '#1f1a17', label: '#e9d8b4', ink: '#1f1a17', process: 'Natural & washed', altitude: '1,100–1,600 m', varietal: 'Blend' },
  { id: 'guatemala-antigua', region: 'GUATEMALA', desc: 'Classic and balanced, from volcanic soil near Antigua.', name: 'Guatemala Antigua', origin: 'Guatemala', short: 'ANTIGUA', notes: ['Toffee', 'Orange zest', 'Almond'], roast: 2, price: 15.0, bag: '#c99a3b', label: '#fff8e6', ink: '#7a5a17', process: 'Washed', altitude: '1,500 m', varietal: 'Bourbon' },
  { id: 'decaf-peru', region: 'PERU', desc: 'All the sweetness, none of the caffeine, from Cajamarca.', name: 'Peru Decaf', origin: 'Peru', short: 'DECAF', notes: ['Milk chocolate', 'Plum', 'Honey'], roast: 2, price: 14.5, bag: '#5b6b3a', label: '#f1f3e4', ink: '#45522a', process: 'Swiss Water', altitude: '1,600 m', varietal: 'Typica, Bourbon' },
];

/** A coffee bag (SVG): kraft-style pouch in the product's color with a label. */
function bag(c, size = 180) {
  const id = c.id;
  return `<svg viewBox="0 0 200 250" width="${size}" height="${size * 1.25}" aria-hidden="true">
    <defs><linearGradient id="g-${id}" x1="0" x2="1"><stop offset="0" stop-color="#000" stop-opacity=".18"/><stop offset=".25" stop-color="#fff" stop-opacity=".08"/>
      <stop offset=".6" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".22"/></linearGradient></defs>
    <ellipse cx="100" cy="240" rx="78" ry="7" fill="#000" opacity=".12"/>
    <path d="M38 34 L162 34 L172 232 Q100 242 28 232 Z" fill="${c.bag}"/>
    <path d="M38 34 L162 34 L172 232 Q100 242 28 232 Z" fill="url(#g-${id})"/>
    <rect x="36" y="18" width="128" height="22" rx="3" fill="${c.bag}"/><rect x="36" y="18" width="128" height="22" rx="3" fill="#000" opacity=".18"/>
    <path d="M44 29 H156" stroke="#fff" stroke-opacity=".25" stroke-width="2" stroke-dasharray="4 4"/>
    <rect x="56" y="88" width="88" height="104" rx="6" fill="${c.label}"/>
    <circle cx="100" cy="112" r="11" fill="none" stroke="${c.ink}" stroke-width="2"/>
    <path d="M100 103 C95 108 95 116 100 121 C105 116 105 108 100 103 Z" fill="${c.ink}"/>
    <text x="100" y="72" text-anchor="middle" font-family="Georgia, serif" font-size="9" font-weight="700" letter-spacing="2.4" fill="#fff" opacity=".8">EMBER &amp; OAK</text>
    <text x="100" y="146" text-anchor="middle" font-family="Georgia, serif" font-size="${[15, 15, 15, 15, 15, 13.5, 11.5, 10][Math.min(c.short.length, 7)]}" font-weight="700" letter-spacing="1.2" fill="${c.ink}">${esc(c.short)}</text>
    <text x="100" y="162" text-anchor="middle" font-family="-apple-system, system-ui, sans-serif" font-size="7" letter-spacing="1.6" fill="${c.ink}" opacity=".75">${esc(c.region)}</text>
    <path d="M80 172 H120" stroke="${c.ink}" stroke-opacity=".35"/>
    <text x="100" y="184" text-anchor="middle" font-family="-apple-system, system-ui, sans-serif" font-size="7" letter-spacing="1.4" fill="${c.ink}" opacity=".7">250 G</text>
  </svg>`;
}

const roastDots = n => `<span class="roast" title="Roast level">${[1, 2, 3].map(i => `<i class="${i <= n ? 'on' : ''}"></i>`).join('')}<em>${['Light', 'Medium', 'Dark'][n - 1]}</em></span>`;
const euro = n => `€${n.toFixed(2)}`;

const SHOP_CSS = `
  :root { --bg: #faf6f0; --ink: #2a211b; --muted: #7b6d62; --line: #eadfd2; --accent: #b4532a; --card: #fff; }
  * { box-sizing: border-box; } body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
  a { color: inherit; text-decoration: none; }
  .serif { font-family: "Iowan Old Style", "Palatino Linotype", Georgia, serif; }
  .bar { background: #2a211b; color: #f3e9d8; text-align: center; font-size: 12.5px; padding: 7px; letter-spacing: .3px; }
  nav { display: flex; align-items: center; gap: 32px; padding: 18px 48px; border-bottom: 1px solid var(--line); background: var(--bg); }
  .logo { display: flex; align-items: center; gap: 10px; font-size: 21px; font-weight: 700; letter-spacing: -.2px; }
  .logo svg { width: 28px; height: 28px; }
  nav .links { display: flex; gap: 26px; font-size: 14.5px; color: var(--muted); } nav .links a.on { color: var(--ink); font-weight: 600; }
  nav .right { margin-left: auto; display: flex; gap: 18px; align-items: center; font-size: 14px; color: var(--muted); }
  .cart-btn { display: flex; align-items: center; gap: 8px; padding: 8px 14px; border-radius: 999px; background: var(--ink); color: #fff; font-weight: 600; }
  .cart-btn b { background: var(--accent); border-radius: 999px; padding: 0 7px; font-size: 12px; }
  .wrap { max-width: 1180px; margin: 0 auto; padding: 0 48px; }
  .btn { display: inline-flex; align-items: center; gap: 8px; border: 0; border-radius: 999px; padding: 12px 22px; font: 600 14.5px/1 inherit; cursor: pointer; }
  .btn.primary { background: var(--accent); color: #fff; } .btn.ghost { background: transparent; color: var(--ink); box-shadow: inset 0 0 0 1.5px var(--ink); }
  .hero { display: grid; grid-template-columns: 1.1fr 1fr; gap: 40px; align-items: center; padding: 56px 0 40px; }
  .eyebrow { text-transform: uppercase; letter-spacing: 2px; font-size: 12px; color: var(--accent); font-weight: 700; }
  .hero h1 { font-size: 54px; line-height: 1.05; margin: 14px 0 16px; letter-spacing: -1px; }
  .hero p { font-size: 17px; color: var(--muted); max-width: 470px; margin: 0 0 26px; }
  .hero .bags { position: relative; height: 330px; background: radial-gradient(closest-side, #f0e2cf, transparent); }
  .hero .bags svg { position: absolute; bottom: 0; }
  .perks { display: flex; gap: 28px; margin-top: 30px; color: var(--muted); font-size: 13.5px; } .perks b { color: var(--ink); display: block; font-size: 15px; }
  .section-head { display: flex; align-items: baseline; justify-content: space-between; margin: 26px 0 18px; }
  .section-head h2 { font-size: 30px; margin: 0; }
  .filters { display: flex; gap: 8px; } .chip { padding: 6px 13px; border-radius: 999px; background: #fff; box-shadow: inset 0 0 0 1px var(--line); font-size: 13px; color: var(--muted); }
  .chip.on { background: var(--ink); color: #fff; box-shadow: none; }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 22px; padding-bottom: 60px; }
  .product { background: var(--card); border-radius: 18px; overflow: hidden; box-shadow: 0 1px 0 var(--line), 0 10px 30px -18px rgba(60,40,20,.35); }
  .product .img { height: 230px; display: grid; place-items: center; }
  .product .body { padding: 18px 20px 20px; }
  .product h3 { margin: 0; font-size: 20px; } .product .origin { color: var(--muted); font-size: 13px; margin: 2px 0 10px; }
  .notes { display: flex; gap: 6px; flex-wrap: wrap; } .notes span { font-size: 12px; padding: 3px 9px; border-radius: 999px; background: #f6efe6; color: #6a5547; }
  .row { display: flex; align-items: center; justify-content: space-between; margin-top: 16px; }
  .price { font-size: 19px; font-weight: 700; } .price small { color: var(--muted); font-weight: 400; font-size: 13px; }
  .add { border: 0; border-radius: 999px; padding: 9px 15px; background: var(--ink); color: #fff; font: 600 13px/1 inherit; }
  .roast { display: inline-flex; align-items: center; gap: 3px; font-size: 12px; color: var(--muted); } .roast i { width: 9px; height: 9px; border-radius: 50%; background: #e8dccd; }
  .roast i.on { background: #6b4226; } .roast em { font-style: normal; margin-left: 5px; }
  .crumbs { font-size: 13px; color: var(--muted); padding: 22px 0 0; } .crumbs a { text-decoration: underline; text-underline-offset: 3px; }
  .pdp { display: grid; grid-template-columns: 1fr 1fr; gap: 56px; padding: 26px 0 60px; }
  .pdp .stage { border-radius: 24px; display: grid; place-items: center; height: 560px; }
  .pdp h1 { font-size: 46px; margin: 6px 0 6px; letter-spacing: -.6px; } .pdp .lead { color: var(--muted); font-size: 16.5px; margin: 14px 0 22px; }
  .opt { margin: 20px 0 0; } .opt label { font-size: 12.5px; text-transform: uppercase; letter-spacing: 1.2px; color: var(--muted); font-weight: 700; display: block; margin-bottom: 8px; }
  .seg { display: flex; gap: 8px; } .seg span { padding: 10px 16px; border-radius: 12px; background: #fff; box-shadow: inset 0 0 0 1px var(--line); font-size: 14px; }
  .seg span.on { box-shadow: inset 0 0 0 2px var(--ink); font-weight: 600; }
  .buy { display: flex; gap: 12px; margin-top: 28px; align-items: center; }
  .qty { display: flex; align-items: center; gap: 14px; padding: 10px 16px; border-radius: 999px; background: #fff; box-shadow: inset 0 0 0 1px var(--line); font-weight: 600; }
  .facts { margin-top: 30px; border-top: 1px solid var(--line); display: grid; grid-template-columns: repeat(3, 1fr); }
  .facts div { padding: 14px 0; font-size: 13px; color: var(--muted); } .facts b { display: block; color: var(--ink); font-size: 15px; }
  .two { display: grid; grid-template-columns: 1.5fr 1fr; gap: 40px; padding: 30px 0 60px; align-items: start; }
  .panel { background: #fff; border-radius: 18px; padding: 24px; box-shadow: 0 1px 0 var(--line), 0 10px 30px -20px rgba(60,40,20,.35); }
  .panel h2 { margin: 0 0 16px; font-size: 22px; }
  .line { display: grid; grid-template-columns: 76px 1fr auto auto; gap: 18px; align-items: center; padding: 16px 0; border-top: 1px solid var(--line); }
  .line.compact { grid-template-columns: 64px 1fr auto; gap: 14px; } .line.compact .thumb { width: 64px; height: 64px; }
  .line:first-of-type { border-top: 0; } .line .thumb { width: 76px; height: 76px; border-radius: 14px; display: grid; place-items: center; overflow: hidden; }
  .line h4 { margin: 0; font-size: 16px; } .line p { margin: 2px 0 0; color: var(--muted); font-size: 13px; }
  .sum { display: flex; justify-content: space-between; padding: 7px 0; font-size: 14.5px; color: var(--muted); } .sum b { color: var(--ink); }
  .sum.total { border-top: 1px solid var(--line); margin-top: 8px; padding-top: 14px; font-size: 18px; color: var(--ink); font-weight: 700; }
  .field { display: grid; gap: 6px; margin-bottom: 14px; } .field span { font-size: 12.5px; color: var(--muted); font-weight: 600; }
  .field input { font: inherit; padding: 12px 14px; border-radius: 12px; border: 1px solid var(--line); background: #fffdfa; }
  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; } .cols3 { display: grid; grid-template-columns: 2fr 1fr 1fr; gap: 14px; }
  .ship { display: grid; gap: 10px; } .ship div { display: flex; justify-content: space-between; padding: 14px 16px; border-radius: 12px; box-shadow: inset 0 0 0 1px var(--line); font-size: 14px; }
  .ship div.on { box-shadow: inset 0 0 0 2px var(--accent); background: #fff8f3; }
  .steps { display: flex; gap: 10px; align-items: center; font-size: 13px; color: var(--muted); margin: 26px 0 0; } .steps b { color: var(--ink); }
  footer { border-top: 1px solid var(--line); padding: 26px 48px; color: var(--muted); font-size: 13px; display: flex; justify-content: space-between; }
`;

const LOGO = `<svg viewBox="0 0 32 32"><circle cx="16" cy="16" r="15" fill="#2a211b"/><path d="M16 6 C10 12 10 20 16 26 C22 20 22 12 16 6 Z" fill="#e0a56a"/><path d="M16 9 V23" stroke="#2a211b" stroke-width="1.6"/></svg>`;

function shopChrome(active, body) {
  const links = [['Shop', '/shop'], ['Subscriptions', '#'], ['Brew guides', '#'], ['Wholesale', '#'], ['Our story', '#']];
  return `<div class="bar">Free shipping over €40 · Roasted every Tuesday in Leipzig</div>
  <nav><a class="logo serif" href="/shop">${LOGO}Ember &amp; Oak</a>
    <div class="links">${links.map(([t, h]) => `<a href="${h}" class="${t === active ? 'on' : ''}">${t}</a>`).join('')}</div>
    <div class="right"><span>Search</span><span>Account</span><a class="cart-btn" href="/shop/cart">Cart <b>3</b></a></div></nav>
  ${body}
  <footer><span>© 2026 Ember &amp; Oak Coffee Roasters</span><span>Shipping · Returns · Contact · Imprint</span></footer>`;
}

const tint = c => `background: color-mix(in srgb, ${c.bag} 13%, #fbf7f1)`;

function shopHome() {
  const [a, b, c] = [COFFEES[1], COFFEES[0], COFFEES[3]];
  return page('Ember & Oak — Small-batch coffee roasters', SHOP_CSS, shopChrome('Shop', `<div class="wrap">
    <section class="hero"><div>
      <div class="eyebrow">New harvest · Ethiopia Guji</div>
      <h1 class="serif">Small-batch coffee, roasted every Tuesday.</h1>
      <p>Single origins and blends from farms we know by name. Roasted to order in Leipzig and shipped within 48 hours.</p>
      <a class="btn primary" href="/shop/coffee/ethiopia-guji">Shop the new harvest →</a> &nbsp; <a class="btn ghost" href="#">Start a subscription</a>
      <div class="perks"><div><b>4.9 ★</b>2,340 reviews</div><div><b>48 h</b>roast to door</div><div><b>Direct trade</b>12 partner farms</div></div>
    </div>
    <div class="bags"><div style="position:absolute;left:4%;bottom:0;transform:rotate(-7deg)">${bag(a, 190)}</div>
      <div style="position:absolute;left:31%;bottom:10px;z-index:2">${bag(b, 230)}</div>
      <div style="position:absolute;right:2%;bottom:0;transform:rotate(6deg)">${bag(c, 190)}</div></div>
    </section>
    <div class="section-head"><h2 class="serif">This week’s roasts</h2>
      <div class="filters"><span class="chip on">All</span><span class="chip">Filter</span><span class="chip">Espresso</span><span class="chip">Decaf</span></div></div>
    <div class="grid">${COFFEES.map(c => `<a class="product" href="/shop/coffee/${c.id}">
      <div class="img" style="${tint(c)}">${bag(c, 140)}</div>
      <div class="body"><h3 class="serif">${esc(c.name)}</h3><div class="origin">${esc(c.origin)} · ${esc(c.process)}</div>
        <div class="notes">${c.notes.map(n => `<span>${esc(n)}</span>`).join('')}</div>
        <div class="row"><div><div class="price">${euro(c.price)} <small>/ 250 g</small></div>${roastDots(c.roast)}</div><button class="add">Add to cart</button></div></div></a>`).join('')}
    </div></div>`));
}

function shopProduct(id) {
  const c = COFFEES.find(x => x.id === id) ?? COFFEES[0];
  return page(`${c.name} — Ember & Oak`, SHOP_CSS, shopChrome('Shop', `<div class="wrap">
    <div class="crumbs"><a href="/shop">Shop</a> / Single origin / ${esc(c.name)}</div>
    <section class="pdp"><div class="stage" style="${tint(c)}">${bag(c, 330)}</div>
    <div><div class="eyebrow">${esc(c.origin)} · ${esc(c.process)}</div>
      <h1 class="serif">${esc(c.name)}</h1>${roastDots(c.roast)}
      <p class="lead">${esc(c.desc)} Tastes of ${c.notes.map(n => n.toLowerCase()).join(', ')} — great as pour-over and as espresso.</p>
      <div class="notes">${c.notes.map(n => `<span>${esc(n)}</span>`).join('')}</div>
      <div class="opt"><label>Size</label><div class="seg"><span class="on">250 g · ${euro(c.price)}</span><span>500 g · ${euro(c.price * 1.85)}</span><span>1 kg · ${euro(c.price * 3.4)}</span></div></div>
      <div class="opt"><label>Grind</label><div class="seg"><span class="on">Whole bean</span><span>Filter</span><span>Espresso</span><span>French press</span></div></div>
      <div class="buy"><span class="qty">−&nbsp; 1 &nbsp;+</span><a class="btn primary" href="/shop/cart">Add to cart · ${euro(c.price)}</a></div>
      <div class="facts"><div><b>${esc(c.altitude)}</b>Altitude</div><div><b>${esc(c.varietal)}</b>Varietal</div><div><b>Oct 2026</b>Harvest</div></div>
    </div></section></div>`));
}

const CART = [{ c: COFFEES[0], qty: 1, size: '250 g · Whole bean' }, { c: COFFEES[3], qty: 2, size: '500 g · Espresso' }];
/** Cart lines; `compact` (order summary): the quantity as text instead of the stepper. */
const cartLines = (compact = false) => CART.map(({ c, qty, size }) => `<div class="line${compact ? ' compact' : ''}"><div class="thumb" style="${tint(c)}">${bag(c, 56)}</div>
  <div><h4>${esc(c.name)}</h4><p>${esc(size)}${compact ? ` · Qty ${qty}` : ''}</p></div>${compact ? '' : `<span class="qty">−&nbsp; ${qty} &nbsp;+</span>`}<b>${euro(c.price * qty * (size.startsWith('500') ? 1.85 : 1))}</b></div>`).join('');
const subtotal = () => CART.reduce((n, { c, qty, size }) => n + c.price * qty * (size.startsWith('500') ? 1.85 : 1), 0);

function shopCart() {
  const sub = subtotal();
  return page('Your cart — Ember & Oak', SHOP_CSS, shopChrome('', `<div class="wrap">
    <div class="steps"><b>Cart</b> → Shipping → Payment</div>
    <section class="two"><div class="panel"><h2 class="serif">Your cart</h2>${cartLines()}</div>
    <div class="panel"><h2 class="serif">Summary</h2>
      <div class="sum"><span>Subtotal</span><b>${euro(sub)}</b></div><div class="sum"><span>Shipping</span><b>Free</b></div>
      <div class="sum total"><span>Total</span><span>${euro(sub)}</span></div>
      <a class="btn primary" style="width:100%;justify-content:center;margin-top:18px" href="/shop/checkout">Checkout</a>
      <p style="color:var(--muted);font-size:13px;margin:14px 0 0">Roasted on Tuesday, ships Wednesday.</p></div></section></div>`));
}

function shopCheckout() {
  const sub = subtotal();
  // The checkout has bugs on purpose: a failed stock check and a script error (problem list demo).
  const script = `<script>
    fetch('/api/stock?items=ethiopia-guji,house-espresso').then(r => { if (!r.ok) console.error('Stock check failed:', r.status, r.statusText); });
    setTimeout(() => { document.querySelector('#total').textContent = '€' + cart.total.toFixed(2); });
  </script>`;
  return page('Checkout — Ember & Oak', SHOP_CSS, shopChrome('', `<div class="wrap">
    <div class="steps">Cart → <b>Shipping</b> → Payment</div>
    <section class="two"><div class="panel"><h2 class="serif">Shipping</h2>
      <div class="field"><span>Email</span><input value="mara.lindqvist@example.com"></div>
      <div class="cols"><div class="field"><span>First name</span><input value="Mara"></div><div class="field"><span>Last name</span><input value="Lindqvist"></div></div>
      <div class="field"><span>Street</span><input value="Karl-Liebknecht-Straße 88"></div>
      <div class="cols3"><div class="field"><span>City</span><input value="Leipzig"></div><div class="field"><span>ZIP</span><input value="04275"></div><div class="field"><span>Country</span><input value="Germany"></div></div>
      <h2 class="serif" style="margin-top:10px">Delivery</h2>
      <div class="ship"><div class="on"><span><b>DHL GoGreen</b> · 2–3 days</span><b>Free</b></div><div><span><b>Express</b> · next day</span><b>€6.90</b></div></div>
      <a class="btn primary" style="margin-top:22px" href="#">Continue to payment →</a></div>
    <div class="panel"><h2 class="serif">Order</h2>${cartLines(true)}
      <div class="sum"><span>Subtotal</span><b>${euro(sub)}</b></div><div class="sum"><span>Shipping</span><b>Free</b></div>
      <div class="sum total"><span>Total</span><span id="total">${euro(sub)}</span></div></div></section></div>`), script);
}

// MARK: Ember & Oak admin

const ADMIN_CSS = `
  :root { --bg: #f4f5f7; --ink: #111827; --muted: #6b7280; --line: #e5e7eb; --accent: #b4532a; --green: #15803d; --red: #b91c1c; }
  * { box-sizing: border-box; } body { margin: 0; display: grid; grid-template-columns: 232px 1fr; min-height: 100vh; background: var(--bg); color: var(--ink); font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
  aside { background: #17120f; color: #d6cfc8; padding: 20px 14px; display: flex; flex-direction: column; gap: 4px; }
  aside .logo { display: flex; align-items: center; gap: 10px; color: #fff; font: 700 16px Georgia, serif; padding: 4px 10px 20px; }
  aside .logo svg { width: 26px; height: 26px; } aside .logo small { font: 600 10px -apple-system, system-ui; letter-spacing: 1px; color: #e0a56a; display: block; }
  aside a { display: flex; align-items: center; gap: 10px; padding: 9px 10px; border-radius: 8px; color: inherit; text-decoration: none; }
  aside a.on { background: #2b221c; color: #fff; font-weight: 600; } aside a span.n { margin-left: auto; font-size: 11px; background: #b4532a; color: #fff; border-radius: 999px; padding: 0 7px; }
  aside svg.i { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; opacity: .8; }
  aside .sep { font-size: 11px; text-transform: uppercase; letter-spacing: 1.2px; color: #7d7067; padding: 18px 10px 6px; }
  aside .me { margin-top: auto; display: flex; gap: 10px; align-items: center; padding: 10px; border-top: 1px solid #2b221c; }
  .avatar { width: 30px; height: 30px; border-radius: 50%; background: linear-gradient(135deg, #e0a56a, #b4532a); display: grid; place-items: center; color: #fff; font-weight: 700; font-size: 12px; }
  main { padding: 26px 32px; min-width: 0; }
  header { display: flex; align-items: center; gap: 12px; margin-bottom: 22px; } header h1 { margin: 0; font-size: 24px; letter-spacing: -.3px; }
  header .sub { color: var(--muted); } header .tools { margin-left: auto; display: flex; gap: 8px; }
  .pill { padding: 7px 12px; border-radius: 8px; background: #fff; border: 1px solid var(--line); font-size: 13px; } .pill.dark { background: var(--ink); color: #fff; border-color: var(--ink); }
  .kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; }
  .card { background: #fff; border-radius: 14px; border: 1px solid var(--line); padding: 18px; }
  .kpi .label { color: var(--muted); font-size: 12.5px; font-weight: 600; } .kpi .value { font-size: 27px; font-weight: 700; letter-spacing: -.5px; margin: 4px 0; }
  .delta { font-size: 12.5px; font-weight: 600; } .delta.up { color: var(--green); } .delta.down { color: var(--red); } .delta span { color: var(--muted); font-weight: 400; }
  .kpi svg { width: 100%; height: 34px; margin-top: 8px; }
  .row2 { display: grid; grid-template-columns: 2fr 1fr; gap: 16px; margin-top: 16px; }
  .card h2 { margin: 0; font-size: 15px; } .card .head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
  .legend { display: flex; gap: 14px; font-size: 12px; color: var(--muted); } .legend i { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 5px; }
  .bars div { margin: 0 0 13px; } .bars .t { display: flex; justify-content: space-between; font-size: 13px; margin-bottom: 5px; } .bars .t b { font-weight: 600; }
  .bars .track { height: 8px; border-radius: 4px; background: #f1ece7; } .bars .fill { height: 100%; border-radius: 4px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; } th { text-align: left; color: var(--muted); font-weight: 600; font-size: 12px; padding: 8px 10px; border-bottom: 1px solid var(--line); }
  td { padding: 11px 10px; border-bottom: 1px solid var(--line); } tr:last-child td { border-bottom: 0; }
  .status { font-size: 12px; font-weight: 600; padding: 3px 9px; border-radius: 999px; }
  .s-paid { background: #dcfce7; color: #166534; } .s-shipped { background: #dbeafe; color: #1e40af; } .s-pending { background: #fef3c7; color: #92400e; } .s-refunded { background: #fee2e2; color: #991b1b; }
  .cust { display: flex; align-items: center; gap: 9px; } .cust .avatar { width: 26px; height: 26px; font-size: 11px; }
`;

/** Deterministic pseudo data, so every screenshot looks the same. */
function series(n, seed, base, swing) {
  let x = seed;
  const rnd = () => ((x = (x * 9301 + 49297) % 233280) / 233280);
  return Array.from({ length: n }, (_, i) => base + swing * (Math.sin(i / 3.2) * 0.35 + rnd() * 0.65) + i * swing * 0.02);
}
function linePath(values, w, h, pad = 4) {
  const max = Math.max(...values), min = Math.min(...values);
  return values.map((v, i) => `${i ? 'L' : 'M'}${(pad + (i * (w - 2 * pad)) / (values.length - 1)).toFixed(1)} ${(h - pad - ((v - min) / (max - min || 1)) * (h - 2 * pad)).toFixed(1)}`).join(' ');
}
const spark = (values, color) => `<svg viewBox="0 0 200 34" preserveAspectRatio="none"><path d="${linePath(values, 200, 34)}" fill="none" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>`;

function revenueChart() {
  const w = 720, h = 262, now = series(30, 7, 1800, 1400), prev = series(30, 3, 1500, 1000);
  const all = [...now, ...prev], max = Math.max(...all) * 1.08;
  const pt = (v, i) => [40 + (i * (w - 56)) / 29, h - 26 - (v / max) * (h - 46)];
  const path = vs => vs.map((v, i) => `${i ? 'L' : 'M'}${pt(v, i).map(n => n.toFixed(1)).join(' ')}`).join(' ');
  const grid = [0, 1, 2, 3].map(k => { const y = h - 26 - (k / 3) * (h - 46); return `<line x1="40" x2="${w - 16}" y1="${y}" y2="${y}" stroke="#eef0f3"/><text x="32" y="${y + 4}" text-anchor="end" font-size="11" fill="#9ca3af">€${Math.round((max * k) / 3 / 100) / 10}k</text>`; }).join('');
  const labels = [0, 7, 14, 21, 29].map((i, k) => `<text x="${pt(0, i)[0]}" y="${h - 6}" text-anchor="middle" font-size="11" fill="#9ca3af">${['Sep 13', 'Sep 20', 'Sep 27', 'Oct 4', 'Oct 12'][k]}</text>`).join('');
  const area = `${path(now)} L${pt(0, 29)[0]} ${h - 26} L40 ${h - 26} Z`;
  return `<svg viewBox="0 0 ${w} ${h}" width="100%"><defs><linearGradient id="ar" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#b4532a" stop-opacity=".22"/><stop offset="1" stop-color="#b4532a" stop-opacity="0"/></linearGradient></defs>
    ${grid}<path d="${area}" fill="url(#ar)"/><path d="${path(prev)}" fill="none" stroke="#c7cbd1" stroke-width="2" stroke-dasharray="4 4"/>
    <path d="${path(now)}" fill="none" stroke="#b4532a" stroke-width="2.5"/>${labels}
    <circle cx="${pt(now[29], 29)[0]}" cy="${pt(now[29], 29)[1]}" r="4.5" fill="#fff" stroke="#b4532a" stroke-width="2.5"/></svg>`;
}

const ICON = {
  home: '<path d="M3 10.5 12 3l9 7.5V21H3z"/><path d="M9 21v-7h6v7"/>', box: '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5M12 13v8"/>',
  cart: '<circle cx="9" cy="20" r="1.5"/><circle cx="18" cy="20" r="1.5"/><path d="M2 3h3l2.4 12h11l2-8H6"/>', users: '<circle cx="9" cy="8" r="4"/><path d="M2 21c0-4 3-6 7-6s7 2 7 6M16 4a4 4 0 0 1 0 8M22 21c0-3-1.5-5-4-5.6"/>',
  repeat: '<path d="m17 2 4 4-4 4"/><path d="M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4"/><path d="M21 13v2a3 3 0 0 1-3 3H3"/>', tag: '<path d="M3 3h8l10 10-8 8L3 11z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
  chart: '<path d="M3 3v18h18"/><path d="m7 15 4-4 3 3 5-6"/>', gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
};
const ico = n => `<svg class="i" viewBox="0 0 24 24">${ICON[n]}</svg>`;

function admin() {
  const orders = [
    ['#4821', 'Mara Lindqvist', 'ML', 'Ethiopia Guji, Hearth Espresso ×2', '€66.45', 'Pending', '2 min ago'],
    ['#4820', 'Jonas Brandt', 'JB', 'Monthly subscription · Filter', '€29.00', 'Paid', '18 min ago'],
    ['#4819', 'Aiko Tanaka', 'AT', 'Kenya Nyeri AA ×2', '€36.00', 'Shipped', '1 h ago'],
    ['#4818', 'Lucas Moreau', 'LM', 'Colombia Huila, Peru Decaf', '€28.50', 'Shipped', '3 h ago'],
    ['#4817', 'Sofia Rossi', 'SR', 'Hearth Espresso 1 kg', '€45.90', 'Refunded', '5 h ago'],
  ];
  const top = [['Hearth Espresso', 412, '#1f1a17'], ['Ethiopia Guji', 296, '#2f5d50'], ['Colombia Huila', 241, '#b4532a'], ['Kenya Nyeri AA', 158, '#6b3a5b'], ['Peru Decaf', 97, '#5b6b3a']];
  const kpi = (label, value, delta, up, vals, color) => `<div class="card kpi"><div class="label">${label}</div><div class="value">${value}</div>
    <div class="delta ${up ? 'up' : 'down'}">${up ? '▲' : '▼'} ${delta} <span>vs. last 30 days</span></div>${spark(vals, color)}</div>`;
  return page('Overview — Ember & Oak Admin', ADMIN_CSS, `<aside>
    <div class="logo">${LOGO}<div>Ember &amp; Oak<small>ADMIN</small></div></div>
    <a class="on" href="/admin">${ico('home')}Overview</a><a href="#">${ico('cart')}Orders<span class="n">12</span></a><a href="#">${ico('box')}Products</a>
    <a href="#">${ico('users')}Customers</a><a href="#">${ico('repeat')}Subscriptions</a><a href="#">${ico('tag')}Discounts</a>
    <div class="sep">Insights</div><a href="#">${ico('chart')}Reports</a><a href="#">${ico('gear')}Settings</a>
    <div class="me"><div class="avatar">FN</div><div><div style="color:#fff;font-weight:600">Frida Nowak</div><div style="font-size:12px;color:#8f8278">Head of Roasting</div></div></div>
  </aside><main>
    <header><div><h1>Good morning, Frida</h1><div class="sub">Here’s how the roastery did in the last 30 days.</div></div>
      <div class="tools"><span class="pill">Sep 13 – Oct 12, 2026 ▾</span><span class="pill">Export</span><span class="pill dark">+ New product</span></div></header>
    <div class="kpis">
      ${kpi('Revenue', '€48,920', '12.4%', true, series(20, 11, 10, 6), '#b4532a')}
      ${kpi('Orders', '1,284', '8.1%', true, series(20, 5, 10, 5), '#1f2937')}
      ${kpi('Active subscriptions', '612', '3.6%', true, series(20, 9, 10, 3), '#2f5d50')}
      ${kpi('Avg. order value', '€38.10', '1.9%', false, series(20, 2, 10, 4), '#9ca3af')}
    </div>
    <div class="row2"><div class="card"><div class="head"><h2>Revenue</h2><div class="legend"><span><i style="background:#b4532a"></i>This period</span><span><i style="background:#c7cbd1"></i>Previous period</span></div></div>${revenueChart()}</div>
      <div class="card"><div class="head"><h2>Top coffees</h2><span style="color:var(--muted);font-size:12px">bags sold</span></div>
        <div class="bars">${top.map(([n, v, c]) => `<div><div class="t"><b>${n}</b><span>${v}</span></div><div class="track"><div class="fill" style="width:${(v / 412) * 100}%;background:${c}"></div></div></div>`).join('')}</div></div></div>
    <div class="card" style="margin-top:16px"><div class="head"><h2>Recent orders</h2><span class="pill">View all</span></div>
      <table><tr><th>Order</th><th>Customer</th><th>Items</th><th>Total</th><th>Status</th><th>Placed</th></tr>
      ${orders.map(([id, name, ini, items, total, st, when]) => `<tr><td><b>${id}</b></td><td><div class="cust"><div class="avatar">${ini}</div>${name}</div></td><td>${items}</td><td><b>${total}</b></td><td><span class="status s-${st.toLowerCase()}">${st}</span></td><td style="color:var(--muted)">${when}</td></tr>`).join('')}
      </table></div>
  </main>`);
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
  if (p.startsWith('/shop/coffee/')) return res.end(shopProduct(p.split('/').pop()));
  if (p === '/shop/cart') return res.end(shopCart());
  if (p === '/shop/checkout') return res.end(shopCheckout());
  if (p.startsWith('/admin')) return res.end(admin());
  if (p.startsWith('/docs')) return res.end(docs());
  res.statusCode = 404;
  res.end(page('Not found', SHOP_CSS, '<p style="padding:40px">Not found</p>'));
}
