// UC-18 (non-ShopperSense product only) end to end, one flow per run:
//   node scripts/uc18.mjs atc | buynow
// Fresh browser context. Expects the server filter to drop cart/checkout events (2004), no Cart / Order
// record in DynamoDB, and no change to any row of the ShopperSense product's analytics report.
// Payment is entered by the tester (manual handoff). Results are written into the tracker tab as it goes.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { appFrame } from './lib.mjs';
import { trackerPage, track } from './tracker.mjs';

const FLOW = process.argv[2] || 'atc';
if (!['atc', 'buynow'].includes(FLOW)) throw new Error('flow must be atc or buynow');
const ID = 'UC-18';
const STORE = 'https://vijay-shoppersense-dev-non-plus.myshopify.com';
const URL1 = STORE + '/products/the-complete-snowboard';
const ANALYTICS = 'https://admin.shopify.com/store/vijay-shoppersense-dev-non-plus/apps/vj-shoppersense-dev/app/products/a2a3e134-7d4a-4336-a1ec-9f2aba7eeba9/analytics';
const CLIENT = '/Users/vijaykumar/Desktop/Workspace/Shoppersense/ss-shopify-client';
const ASSETS = CLIENT + '/extensions/shoppersense-blocks/assets';
const OUT = path.resolve('evidence/uc18');
fs.mkdirSync(OUT, { recursive: true });

const b = await chromium.connectOverCDP('http://localhost:9333');
const main = b.contexts()[0];
const T = await trackerPage(main);
const rk = (ev) => `${ID}|${FLOW}|${ev}`;
const log = [];
const step = (s) => { const l = `[${new Date().toISOString().slice(11, 19)}] ${s}`; log.push(l); console.log(l); };
const upd = (ev, v) => track(T, { results: { [rk(ev)]: v }, open: { id: ID, flow: FLOW } });
const meta = (v) => track(T, { flowMeta: { [`${ID}|${FLOW}`]: v } });

// ---------- DynamoDB lookup (read-only, scripts/check-cart.ts) ----------
const BUNDLE = path.join(CLIENT, '.check-cart.tmp.mjs');
execFileSync('npx', ['esbuild', path.resolve('scripts/check-cart.ts'), '--bundle', '--platform=node', '--format=esm', '--packages=external', `--outfile=${BUNDLE}`, '--log-level=warning'], { cwd: CLIENT });
const dbLookup = (token) => JSON.parse(execFileSync('node', [BUNDLE, token], { cwd: CLIENT }).toString())[token.split('?')[0]];

// ---------- analytics report: every row ----------
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
  const sec = t.slice(t.indexOf('Shopper Intent Summary'), t.indexOf('Top 2') > 0 ? t.indexOf('Top 2') : undefined).split('\n');
  const n = (s) => (s && s !== '—') ? parseFloat(s.replace(/[$,]/g, '')) : 0;
  const rows = {};
  for (let i = 2; i < sec.length - 1; i++) {
    const name = sec[i].trim(), next = sec[i + 1];
    if (name && !name.includes('\t') && next.startsWith('\t')) {
      const c = next.split('\t').map(s => s.trim()).filter(Boolean);
      rows[name] = { visitors: n(c[0]), atc: n(c[1]), checkout: n(c[2]), conv: n(c[3]), revenue: n(c[4]) };
    }
  }
  return rows;
}
const total = (rows, k) => Object.values(rows).reduce((s, r) => s + r[k], 0);
const diffRows = (a, b) => Object.keys({ ...a, ...b }).flatMap(name => ['visitors', 'atc', 'checkout', 'conv', 'revenue']
  .filter(k => (a[name]?.[k] ?? 0) !== (b[name]?.[k] ?? 0)).map(k => `${name}.${k} ${a[name]?.[k] ?? 0}→${b[name]?.[k] ?? 0}`));

// ---------- fresh shopper context ----------
const ctx = await b.newContext({ viewport: { width: 1400, height: 1000 } });
await ctx.addCookies((await main.cookies(STORE)).filter(c => c.name === '_shopify_essential')); // storefront unlock only
await ctx.route(/cdn\.shopify\.com\/extensions\/.*\/assets\/([^/?]+)/, async (route) => { // ENV-02 fallback
  const name = decodeURIComponent(new URL(route.request().url()).pathname.split('/').pop());
  const file = path.join(ASSETS, name);
  try {
    const r = await route.fetch();
    if (r.status() !== 404 || !fs.existsSync(file)) return route.fulfill({ response: r });
  } catch { if (!fs.existsSync(file)) return route.abort(); }
  step(`ENV-02: served ${name} from local repo`);
  return route.fulfill({ status: 200, contentType: name.endsWith('.css') ? 'text/css' : 'application/javascript', body: fs.readFileSync(file) });
});

const events = [];
const watch = (u) => /apps\/buywhy|api\/pixels/.test(u);
ctx.on('request', r => {
  if (!watch(r.url()) || r.method() !== 'POST') return;
  let d = {}; try { d = JSON.parse(r.postData()); } catch {}
  const a = d.analytics || {};
  const e = { type: a.eventType, endpoint: new URL(r.url()).host + new URL(r.url()).pathname, product: a.product?.id ?? a.data?.productId, intent: a.data?.intent ?? null,
    session: a.sessionId, cart: a.data?.cartToken, ctaType: a.data?.ctaType, lineItems: a.data?.lineItems?.map(i => `${i.productId}:${i.intent}`), req: r };
  events.push(e);
  step(`REQ ${e.endpoint} ${e.type} product=${e.product} intent=${e.intent} session=${e.session}${e.ctaType ? ' ctaType=' + e.ctaType : ''}${e.lineItems ? ' lineItems=' + e.lineItems : ''}`);
});
ctx.on('requestfailed', r => { const e = events.find(x => x.req === r); if (e) { e.failed = r.failure()?.errorText; step(`FAILED ${e.type} ${e.failed}`); } });
ctx.on('response', async r => {
  if (!watch(r.url()) || r.request().method() !== 'POST') return;
  const e = events.find(x => x.req === r.request()); let t = '';
  try { t = await r.text(); } catch {}
  let code; try { code = JSON.parse(t).code; } catch {}
  if (e) { e.status = r.status(); e.code = code; }
  step(`RESP ${r.status()} ${e?.type} code=${code} ${t.slice(0, 100)}`);
});
const waitFor = async (pred, ms) => { const end = Date.now() + ms; while (Date.now() < end) { const e = events.find(x => pred(x) && (x.code !== undefined || x.failed)); if (e) return e; await new Promise(r => setTimeout(r, 500)); } return events.find(pred); };
const fmt = (e) => e ? `${e.type}${e.ctaType ? ' (' + e.ctaType + ')' : ''} → ${e.code !== undefined ? 'code ' + e.code : e.failed ? 'request failed: ' + e.failed : 'response not captured'} (${e.endpoint}; product ${e.product}; session ${e.session})` : 'no event sent';

try {
  step('Baseline analytics (all rows of the ShopperSense product report)');
  await track(T, { open: { id: ID, flow: FLOW }, flowMeta: { [`${ID}|${FLOW}`]: { date: new Date().toISOString().slice(0, 10) } } });
  for (const ev of ['pv', 'atc', 'co', 'pu']) await upd(ev, { status: 'not_run', code: '', notes: '⏳ Automation running…' });
  const before = await report('before');
  step('before ' + JSON.stringify(before));
  await upd('pv', { before: String(total(before, 'visitors')) });
  await upd('atc', { before: String(total(before, 'atc')) });
  await upd('co', { before: String(total(before, 'checkout')) });
  await upd('pu', { before: String(total(before, 'revenue')) });

  // ---------- page view ----------
  const P = await ctx.newPage();
  step('Open ' + URL1);
  await P.goto(URL1, { waitUntil: 'load' });
  if (P.url().includes('/password')) throw new Error('Storefront is password protected');
  await P.waitForTimeout(6000);
  const session = await P.evaluate(() => sessionStorage.getItem('buywhy_session_id') || (document.cookie.match(/buywhy_session_id=([^;]+)/) || [])[1] || '');
  await P.screenshot({ path: `${OUT}/${FLOW}-pdp.png` });
  const pv = await waitFor(e => e.type === 'intent-tab-click', 12000);
  await meta({ session });
  await upd('pv', { code: String(pv?.code ?? ''), notes: `⏳ ${fmt(pv)}` });

  // ---------- add to cart / buy now ----------
  let cartToken = '';
  if (FLOW === 'atc') {
    step('Click Add to cart');
    await P.locator('form[action*="/cart/add"] button[type="submit"]:visible, form[action*="/cart/add"] [name="add"]:visible').first().click();
    const atc = await waitFor(e => e.type === 'cta-click', 20000);
    await P.waitForTimeout(3000);
    const cart = await P.evaluate(async () => (await (await fetch('/cart.js')).json()));
    cartToken = cart.token.split('?')[0];
    step(`cart ${cartToken} items=${cart.items.map(i => i.product_id).join(',')}`);
    await meta({ cart: cartToken });
    const rec = dbLookup(cartToken);
    step('db after ATC ' + JSON.stringify(rec));
    await upd('atc', { code: String(atc?.code ?? ''), notes: `⏳ ${fmt(atc)}. Cart record after ATC: ${rec.cart ? 'CREATED' : 'none'}.` });
    step('Go to /checkout');
    await P.goto(STORE + '/checkout', { waitUntil: 'load' });
  } else {
    step('Click Buy it now');
    const btn = P.locator('.shopify-payment-button__button--unbranded:visible, .shopify-payment-button button:visible').first();
    await btn.waitFor({ timeout: 20000 });
    await Promise.all([P.waitForURL(/checkouts?\//, { timeout: 45000 }).catch(() => {}), btn.click()]);
    const atc = await waitFor(e => e.type === 'cta-click', 15000);
    cartToken = (P.url().match(/checkouts\/cn\/([^/?]+)/) || [])[1] || (await ctx.cookies(STORE)).find(c => c.name === 'buywhy_buynow_checkout_token')?.value || atc?.cart || '';
    await meta({ cart: cartToken });
    const rec = cartToken ? dbLookup(cartToken) : { cart: null };
    step('db after Buy now ' + JSON.stringify(rec));
    await upd('atc', { code: String(atc?.code ?? ''), notes: `⏳ ${fmt(atc)}. Cart record after Buy now: ${rec.cart ? 'CREATED' : 'none'}.` });
  }

  // ---------- checkout ----------
  await P.waitForTimeout(10000);
  const co = await waitFor(e => e.type === 'checkout_page', 20000);
  await P.screenshot({ path: `${OUT}/${FLOW}-checkout.png`, fullPage: true });
  await upd('co', { code: String(co?.code ?? ''), notes: `⏳ ${fmt(co)}${co?.lineItems ? '; lineItems ' + co.lineItems.join(',') : ''}` });

  // ---------- address, then manual payment ----------
  step('Fill checkout form');
  const fillIf = async (sel, val) => { const l = P.locator(sel).first(); if (await l.count() && await l.isVisible()) await l.fill(val); };
  await fillIf('input[name="email"], input#email', 'test.buyer@example.com');
  const country = P.locator('select[name="countryCode"]').first();
  if (await country.count()) await country.selectOption('US').catch(() => {});
  await P.waitForTimeout(1000);
  await fillIf('input[name="firstName"]', 'Test');
  await fillIf('input[name="lastName"]', 'Buyer');
  await fillIf('input[name="address1"]', '123 Main Street');
  await P.keyboard.press('Escape');
  await fillIf('input[name="city"]', 'New York');
  const zone = P.locator('select[name="zone"]').first();
  if (await zone.count()) await zone.selectOption('NY').catch(() => {});
  await fillIf('input[name="postalCode"]', '10001');
  await fillIf('input[name="phone"]', '2125550123');
  await P.waitForTimeout(3000);
  await P.bringToFront();
  step('HANDOFF: waiting for the tester to enter card details and click Pay now (up to 20 min)');
  await upd('pu', { notes: '⏳ Waiting for the tester to enter the card and click Pay now in the checkout window.' });
  await P.waitForURL(/thank[-_]you|orders\//, { timeout: 20 * 60000 }).catch(() => {});
  await P.waitForTimeout(5000);
  await P.screenshot({ path: `${OUT}/${FLOW}-thank-you.png`, fullPage: true });
  const conf = await P.evaluate(() => (document.body.innerText.match(/Confirmation\s*#?\s*([A-Z0-9]{6,})/i) || [])[1] || '');
  step(`final url ${P.url().slice(0, 120)} confirmation=${conf}`);
  await meta({ order: conf });
  await upd('pu', { notes: conf ? `⏳ Order #${conf} placed. Waiting for the orders/create webhook, then checking DynamoDB and analytics.` : '❌ Payment did not reach the thank-you page.' });

  // ---------- after: wait for the webhook, then DB + analytics ----------
  await new Promise(r => setTimeout(r, 60000));
  const rec = dbLookup(cartToken);
  step('db after order ' + JSON.stringify(rec));
  const after = await report('after');
  step('after ' + JSON.stringify(after));
  const changes = diffRows(before, after);
  step('analytics changes: ' + (changes.join(', ') || 'none'));
  const unchanged = changes.length === 0;
  const chg = (k) => changes.filter(c => c.includes('.' + k + ' ')).join(', ') || 'no row changed';

  // ---------- verdicts ----------
  const dropped = (e) => e?.code === 2004;
  const pvRecorded = pv?.code === 3001;
  await upd('pv', { after: String(total(after, 'visitors')), status: pvRecorded || chg('visitors') !== 'no row changed' ? 'fail' : 'pass',
    notes: pvRecorded ? `❌ KNOWN GAP (TC-02): ${fmt(pv)}, so the page view is still recorded. Analytics visitors: ${chg('visitors')}.`
                      : `✅ ${fmt(pv)}. Analytics visitors: ${chg('visitors')}.` });
  const atcEv = events.find(e => e.type === 'cta-click');
  const atcOk = (dropped(atcEv) || (FLOW === 'buynow' && atcEv && atcEv.code === undefined)) && !rec.cart && chg('atc') === 'no row changed';
  await upd('atc', { after: String(total(after, 'atc')), status: atcOk ? 'pass' : 'fail',
    notes: `${atcOk ? '✅' : '❌'} ${fmt(atcEv)}. Cart record: ${rec.cart ? 'CREATED ' + JSON.stringify(rec.cart) : 'none'}. Analytics ATC: ${chg('atc')}.${FLOW === 'buynow' && atcEv?.code === undefined ? ' Response not captured (page navigated to checkout); the drop is confirmed by the missing Cart record.' : ''}` });
  const coOk = dropped(co) && chg('checkout') === 'no row changed';
  await upd('co', { after: String(total(after, 'checkout')), status: coOk ? 'pass' : 'fail',
    notes: `${coOk ? '✅' : '❌'} ${fmt(co)}. Analytics checkout: ${chg('checkout')}.` });
  const puOk = !!conf && !rec.cart && rec.orders.length === 0 && chg('conv') === 'no row changed' && chg('revenue') === 'no row changed';
  await upd('pu', { code: 'webhook', after: String(total(after, 'revenue')), status: puOk ? 'pass' : 'fail',
    notes: `${puOk ? '✅' : '❌'} Order #${conf || '—'}. Cart record: ${rec.cart ? 'present' : 'none'}; Order records for cart ${cartToken}: ${rec.orders.length ? JSON.stringify(rec.orders) : 'none'} (webhook skipped). Analytics conversions/revenue: ${chg('conv') === 'no row changed' && chg('revenue') === 'no row changed' ? 'no row changed' : chg('conv') + '; ' + chg('revenue')}. Order/customer tags not checked by automation.` });
  await track(T, { checks: { [`${ID}|1`]: unchanged } });
} catch (e) {
  step('ERROR ' + e.message.split('\n')[0]);
  for (const [i, p] of ctx.pages().entries()) await p.screenshot({ path: `${OUT}/${FLOW}-error-${i}.png`, fullPage: true }).catch(() => {});
  const s = JSON.parse(await T.evaluate(() => localStorage.getItem('ss-analytics-test-tracker-v1')));
  for (const ev of ['pv', 'atc', 'co', 'pu']) {
    const r = s.results[rk(ev)];
    if (r?.notes?.startsWith('⏳')) await upd(ev, { status: 'blocked', notes: `Automation stopped: ${e.message.split('\n')[0]}. Last: ${r.notes.slice(2)}` });
  }
}
fs.rmSync(BUNDLE, { force: true });
fs.writeFileSync(`${OUT}/${FLOW}-log.txt`, log.join('\n') + '\n');
await ctx.close();
process.exit(0);
