// UC-01 (direct / organic shopper) end to end, one flow per run:
//   node scripts/uc01.mjs atc     (Add to cart button)
//   node scripts/uc01.mjs buynow  (Buy it now button)
// Fresh browser context per run. Writes each step's result into the tracker tab (127.0.0.1:4400) as it goes.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { appFrame } from './lib.mjs';
import { trackerPage, track } from './tracker.mjs';

const FLOW = process.argv[2] || 'atc';
if (!['atc', 'buynow'].includes(FLOW)) throw new Error('flow must be atc or buynow');
const ID = 'UC-01';
const STORE = 'https://vijay-shoppersense-dev-non-plus.myshopify.com';
const URL1 = STORE + '/products/the-royal-sherwani-set';
const PRODUCT_ID = '10071543513371';
const PRICE = 5000;
const ROW = 'Current PDP';
const ANALYTICS = 'https://admin.shopify.com/store/vijay-shoppersense-dev-non-plus/apps/vj-shoppersense-dev/app/products/a2a3e134-7d4a-4336-a1ec-9f2aba7eeba9/analytics';
const ASSETS = '/Users/vijaykumar/Desktop/Workspace/Shoppersense/ss-shopify-client/extensions/shoppersense-blocks/assets';
const OUT = path.resolve('evidence/uc01');
fs.mkdirSync(OUT, { recursive: true });

const b = await chromium.connectOverCDP('http://localhost:9333');
const main = b.contexts()[0];
const T = await trackerPage(main);
const rk = (ev) => `${ID}|${FLOW}|${ev}`;
const log = [];
const step = (s) => { const l = `[${new Date().toISOString().slice(11, 19)}] ${s}`; log.push(l); console.log(l); };
const upd = (ev, v) => track(T, { results: { [rk(ev)]: v }, open: { id: ID, flow: FLOW } });
const meta = (v) => track(T, { flowMeta: { [`${ID}|${FLOW}`]: v } });

// ---------- analytics report ----------
async function report(tag) {
  const p = main.pages().find(p => p.url().startsWith('https://admin.shopify.com') && p.url().includes('/analytics'))
    || main.pages().find(p => p.url().startsWith('https://admin.shopify.com') && !p.url().includes('/customizer'));
  await p.goto(ANALYTICS, { waitUntil: 'load' });
  const f = await appFrame(p, 'text=/view report/i', 60000);
  await p.waitForTimeout(3000);
  await f.getByText(/view report/i).first().click();
  await p.waitForTimeout(8000);
  await p.screenshot({ path: `${OUT}/${FLOW}-analytics-${tag}.png` });
  const t = await f.evaluate(() => document.body.innerText);
  const i = t.indexOf('\n' + ROW + '\n');
  if (i < 0) return { visitors: 0, atc: 0, checkout: 0, conv: 0, revenue: 0, missing: true };
  const cells = t.slice(i + ROW.length + 2).split('\n').find(l => l.trim()).split('\t').map(s => s.trim()).filter(Boolean);
  const n = (s) => (s && s !== '—') ? parseFloat(s.replace(/[$,]/g, '')) : 0;
  return { visitors: n(cells[0]), atc: n(cells[1]), checkout: n(cells[2]), conv: n(cells[3]), revenue: n(cells[4]) };
}

// ---------- fresh shopper context ----------
const ctx = await b.newContext({ viewport: { width: 1400, height: 1000 } });
// Storefront unlock only: copy _shopify_essential from the logged-in profile (no cart / buywhy_* cookies).
await ctx.addCookies((await main.cookies(STORE)).filter(c => c.name === '_shopify_essential'));
// ENV-02 fallback: serve theme extension assets from the repo only when the dev CDN 404s.
await ctx.route(/cdn\.shopify\.com\/extensions\/.*\/assets\/([^/?]+)/, async (route) => {
  const name = decodeURIComponent(new URL(route.request().url()).pathname.split('/').pop());
  const file = path.join(ASSETS, name);
  try {
    const r = await route.fetch();
    if (r.status() !== 404 || !fs.existsSync(file)) return route.fulfill({ response: r });
  } catch { if (!fs.existsSync(file)) return route.abort(); }
  step(`ENV-02: served ${name} from local repo`);
  return route.fulfill({ status: 200, contentType: name.endsWith('.css') ? 'text/css' : 'application/javascript', body: fs.readFileSync(file) });
});

const events = []; // { type, url, product, intent, session, cart, lineItems, code, body }
const watch = (u) => /apps\/buywhy|api\/pixels/.test(u);
ctx.on('request', r => {
  if (!watch(r.url()) || r.method() !== 'POST') return;
  let d = {}; try { d = JSON.parse(r.postData()); } catch {}
  const a = d.analytics || {};
  const e = { type: a.eventType, endpoint: new URL(r.url()).pathname, product: a.product?.id ?? a.data?.productId, intent: a.data?.intent ?? null,
    source: a.data?.source ?? a.data?.utmSource ?? null, session: a.sessionId, cart: a.data?.cartToken, ctaType: a.data?.ctaType,
    lineItems: a.data?.lineItems?.map(i => `${i.productId}:${i.intent}`), req: r };
  events.push(e);
  step(`REQ ${e.endpoint} ${e.type} product=${e.product} intent=${e.intent} session=${e.session}${e.ctaType ? ' ctaType=' + e.ctaType : ''}${e.lineItems ? ' lineItems=' + e.lineItems : ''}`);
});
ctx.on('response', async r => {
  if (!watch(r.url()) || r.request().method() !== 'POST') return;
  const e = events.find(x => x.req === r.request()); let t = '';
  try { t = await r.text(); } catch {}
  let code; try { code = JSON.parse(t).code; } catch {}
  if (e) { e.status = r.status(); e.code = code; e.body = t.slice(0, 160); }
  step(`RESP ${r.status()} ${e?.type} code=${code} ${t.slice(0, 100)}`);
});
const waitFor = async (pred, ms) => { const end = Date.now() + ms; while (Date.now() < end) { const e = events.find(x => pred(x) && x.code !== undefined); if (e) return e; await new Promise(r => setTimeout(r, 500)); } return events.find(pred); };
const fmt = (e) => e ? `${e.type} → HTTP ${e.status ?? '?'} code ${e.code ?? '?'} (${e.endpoint}; product ${e.product}; intent ${e.intent ?? 'none'}; session ${e.session})` : 'no event captured';

const summary = {};
try {
  // ---------- baseline ----------
  step('Baseline analytics');
  await track(T, { open: { id: ID, flow: FLOW }, flowMeta: { [`${ID}|${FLOW}`]: { date: new Date().toISOString().slice(0, 10) } } });
  for (const ev of ['pv', 'atc', 'co', 'pu']) await upd(ev, { status: 'not_run', notes: '⏳ Automation running…' });
  const before = await report('before');
  step('before ' + JSON.stringify(before));
  const bef = { pv: before.visitors, atc: before.atc, co: before.checkout, pu: before.revenue };
  for (const ev of Object.keys(bef)) await upd(ev, { before: String(bef[ev]) });

  // ---------- page view ----------
  const P = await ctx.newPage();
  step('Open ' + URL1);
  await P.goto(URL1, { waitUntil: 'load' });
  if (P.url().includes('/password')) {
    if (!process.env.STORE_PASSWORD) throw new Error('Storefront is password protected; set STORE_PASSWORD');
    await P.fill('input[type="password"]', process.env.STORE_PASSWORD);
    await Promise.all([P.waitForNavigation({ waitUntil: 'load' }).catch(() => {}), P.press('input[type="password"]', 'Enter')]);
    events.length = 0;
    await P.goto(URL1, { waitUntil: 'load' });
  }
  await P.waitForTimeout(6000);
  const st = await P.evaluate(() => ({ tracker: !!window.BuyWhyAnalytics, ss: sessionStorage.getItem('buywhy_session_id'),
    cookie: (document.cookie.match(/buywhy_session_id=([^;]+)/) || [])[1] || null, url: location.href,
    pd: localStorage.getItem('buywhy_product_data') }));
  step('page state ' + JSON.stringify(st));
  const session = st.ss || st.cookie;
  await P.screenshot({ path: `${OUT}/${FLOW}-pdp.png` });
  const pv = await waitFor(e => e.type === 'intent-tab-click', 15000);
  summary.pv = pv;
  await meta({ session: session || '' });
  await upd('pv', { code: String(pv?.code ?? ''), notes: `⏳ ${fmt(pv)}. Waiting for analytics.` });
  await track(T, { checks: { [`${ID}|0`]: !!session } });

  // ---------- add to cart / buy now ----------
  let checkoutPage = P;
  if (FLOW === 'atc') {
    step('Click Add to cart');
    await P.locator('form[action*="/cart/add"] button[type="submit"]:visible, form[action*="/cart/add"] [name="add"]:visible').first().click();
    const atc = await waitFor(e => e.type === 'cta-click', 20000);
    summary.atc = atc;
    await P.waitForTimeout(3000);
    const cart = await P.evaluate(async () => (await (await fetch('/cart.js')).json()));
    const line = cart.items.find(i => String(i.product_id) === PRODUCT_ID);
    summary.cart = cart.token.split('?')[0]; summary.lineSession = line?.properties?._buywhy_session_id;
    step(`cart ${summary.cart} line props=${JSON.stringify(line?.properties)}`);
    await meta({ cart: summary.cart });
    await track(T, { checks: { [`${ID}|1`]: !!summary.lineSession } });
    await upd('atc', { code: String(atc?.code ?? ''), notes: `⏳ ${fmt(atc)}. Cart line _buywhy_session_id=${summary.lineSession ?? 'MISSING'}. Waiting for analytics.` });
    step('Go to /checkout');
    await P.goto(STORE + '/checkout', { waitUntil: 'load' });
  } else {
    step('Click Buy it now');
    const btn = P.locator('.shopify-payment-button__button--unbranded:visible, .shopify-payment-button button:visible').first();
    await btn.waitFor({ timeout: 20000 });
    await Promise.all([P.waitForURL(/checkouts?\//, { timeout: 45000 }).catch(() => {}), btn.click()]);
    const atc = await waitFor(e => e.type === 'cta-click' || e.ctaType === 'buy-now', 15000);
    summary.atc = atc;
    const tok = (await ctx.cookies(STORE)).find(c => c.name === 'buywhy_buynow_checkout_token')?.value;
    summary.cart = tok || atc?.cart || '';
    await meta({ cart: summary.cart });
    await upd('atc', { code: String(atc?.code ?? ''), notes: `⏳ ${fmt(atc)}. Waiting for analytics.` });
  }

  // ---------- checkout ----------
  await checkoutPage.waitForTimeout(10000);
  const co = await waitFor(e => e.type === 'checkout_page', 20000);
  summary.co = co;
  await checkoutPage.screenshot({ path: `${OUT}/${FLOW}-checkout.png`, fullPage: true });
  const sameSession = !!session && [summary.atc, co].every(e => !e || e.session === session);
  await track(T, { checks: { [`${ID}|2`]: sameSession } });
  await upd('co', { code: String(co?.code ?? ''), notes: `⏳ ${fmt(co)}${co?.lineItems ? '; lineItems ' + co.lineItems.join(',') : ''}. Waiting for analytics.` });

  // ---------- pay ----------
  const B = checkoutPage;
  step('Fill checkout form');
  const fillIf = async (sel, val) => { const l = B.locator(sel).first(); if (await l.count() && await l.isVisible()) { await l.fill(val); return true; } return false; };
  await fillIf('input[name="email"], input#email', 'test.buyer@example.com');
  const country = B.locator('select[name="countryCode"]').first();
  if (await country.count()) await country.selectOption('US').catch(() => {});
  await B.waitForTimeout(1000);
  await fillIf('input[name="firstName"]', 'Test');
  await fillIf('input[name="lastName"]', 'Buyer');
  await fillIf('input[name="address1"]', '123 Main Street');
  await B.keyboard.press('Escape');
  await fillIf('input[name="city"]', 'New York');
  const zone = B.locator('select[name="zone"]').first();
  if (await zone.count()) await zone.selectOption('NY').catch(() => {});
  await fillIf('input[name="postalCode"]', '10001');
  await fillIf('input[name="phone"]', '2125550123');
  await B.waitForTimeout(5000);
  await B.screenshot({ path: `${OUT}/${FLOW}-before-pay.png`, fullPage: true });
  // Manual handoff: the tester enters the card (Bogus Gateway: 1 / 12/27 / 123) and clicks Pay now.
  await B.bringToFront();
  step('HANDOFF: waiting for the tester to enter card details and click Pay now (up to 20 min)');
  await upd('pu', { notes: '⏳ Waiting for the tester to enter the card and click Pay now in the checkout window.' });
  await B.waitForURL(/thank[-_]you|orders\//, { timeout: 20 * 60000 }).catch(() => {});
  await B.waitForTimeout(8000);
  await B.screenshot({ path: `${OUT}/${FLOW}-thank-you.png`, fullPage: true });
  const conf = await B.evaluate(() => (document.body.innerText.match(/Confirmation\s*#?\s*([A-Z0-9]{6,})/i) || document.body.innerText.match(/Order\s*#\s*([A-Z0-9-]+)/i) || [])[1] || '');
  summary.order = conf;
  step(`final url ${B.url().slice(0, 120)} confirmation=${conf}`);
  await meta({ order: conf });
  await upd('pu', { notes: conf ? `⏳ Order placed, confirmation #${conf}. Waiting for orders/create webhook + analytics.` : `❌ Payment did not reach the thank-you page (${B.url().slice(0, 80)}). See evidence/uc01/${FLOW}-thank-you.png` });

  // ---------- analytics after (poll; the backend can lag) ----------
  let after;
  for (let i = 0; i < 6; i++) {
    await new Promise(r => setTimeout(r, i ? 30000 : 15000));
    after = await report('after');
    step(`after#${i + 1} ` + JSON.stringify(after));
    const done = after.visitors > before.visitors && after.atc > before.atc && after.checkout > before.checkout && (!conf || after.revenue > before.revenue);
    if (done) break;
  }
  summary.before = before; summary.after = after;

  // ---------- verdicts ----------
  const okCode = (e) => e?.code === 3001;
  const organic = (e) => !e || !e.intent || e.intent === 'default';
  const d = (k) => Math.round((after[k] - before[k]) * 100) / 100;
  const verdict = (ok, txt) => ({ status: ok ? 'pass' : 'fail', notes: (ok ? '✅ ' : '❌ ') + txt });
  await upd('pv', { after: String(after.visitors), ...verdict(okCode(pv) && organic(pv) && d('visitors') >= 1, `${fmt(pv)}. Visitors ${before.visitors} → ${after.visitors} under ${ROW}.`) });
  await upd('atc', { after: String(after.atc), ...verdict((okCode(summary.atc) || (FLOW === 'buynow' && summary.atc && summary.atc.code === undefined)) && organic(summary.atc) && d('atc') >= 1,
    `${fmt(summary.atc)}${FLOW === 'buynow' && summary.atc?.code === undefined ? ' (response not captured: page navigated to checkout before it returned; recording confirmed by the ATC delta)' : ''}. ATC ${before.atc} → ${after.atc} under ${ROW}.${FLOW === 'atc' ? ' Cart line _buywhy_session_id=' + (summary.lineSession ?? 'not attached (by design: tracker only attaches it when the product has a stored intent)') + '.' : ''}`) });
  await upd('co', { after: String(after.checkout), ...verdict(okCode(co) && d('checkout') >= 1, `${fmt(co)}${co?.lineItems ? '; lineItems ' + co.lineItems.join(',') : ''}. Checkout ${before.checkout} → ${after.checkout} under ${ROW}.`) });
  await upd('pu', { code: 'webhook', after: String(after.revenue), ...verdict(!!conf && d('conv') >= 1 && d('revenue') >= PRICE,
    `Order #${conf || '—'}. Conversions ${before.conv} → ${after.conv}, revenue $${before.revenue} → $${after.revenue} under ${ROW}. Order tags not checked by automation.`) });
} catch (e) {
  step('ERROR ' + e.message.split('\n')[0]);
  for (const [i, p] of ctx.pages().entries()) await p.screenshot({ path: `${OUT}/${FLOW}-error-${i}.png`, fullPage: true }).catch(() => {});
  for (const ev of ['pv', 'atc', 'co', 'pu']) {
    const s = JSON.parse(await T.evaluate(() => localStorage.getItem('ss-analytics-test-tracker-v1'))).results[rk(ev)];
    if (s?.notes?.startsWith('⏳')) await upd(ev, { status: 'blocked', notes: `Automation stopped: ${e.message.split('\n')[0]}. Last: ${s.notes.slice(2)}` });
  }
}
fs.writeFileSync(`${OUT}/${FLOW}-log.txt`, log.join('\n') + '\n');
await ctx.close();
process.exit(0);
