// UC-20 (mixed cart: ShopperSense + non-ShopperSense product) end to end, Add to cart flow:
//   node scripts/uc20.mjs
// Fresh browser context. Sherwani via the intent PDP link → Add to cart, then Snowboard in the same tab →
// Add to cart, then checkout with both. Address is filled by the script; card + Pay now are done by the
// tester (manual handoff). Verifies response codes, DynamoDB records, the payloads forwarded to the analytics
// backend (logs/aws-payloads.jsonl) and the analytics report. Results are written into the tracker tab.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { appFrame } from './lib.mjs';
import { trackerPage, track } from './tracker.mjs';

const ID = 'UC-20', FLOW = 'atc';
const STORE = 'https://vijay-shoppersense-dev-non-plus.myshopify.com';
const STORE_PASSWORD = process.env.STORE_PASSWORD || '';
const SS_ID = '10071543513371', NONSS_ID = '10071511433499', INTENT = 'Plateau Breakthrough';
const URL1 = STORE + '/products/the-royal-sherwani-set?view=shopper-intent&ss_trace_id=013cbda3-3909-40da-a131-e89d81deaf9d';
const URL2 = STORE + '/products/the-complete-snowboard';
const ANALYTICS = 'https://admin.shopify.com/store/vijay-shoppersense-dev-non-plus/apps/vj-shoppersense-dev/app/products/a2a3e134-7d4a-4336-a1ec-9f2aba7eeba9/analytics';
const CLIENT = '/Users/vijaykumar/Desktop/Workspace/Shoppersense/ss-shopify-client';
const PAYLOADS = CLIENT + '/logs/aws-payloads.jsonl';
const OUT = path.resolve('evidence/uc20');
fs.mkdirSync(OUT, { recursive: true });

const b = await chromium.connectOverCDP('http://localhost:9333');
const main = b.contexts()[0];
const T = await trackerPage(main);
const rk = (ev) => `${ID}|${FLOW}|${ev}`;
const log = [];
const step = (s) => { const l = `[${new Date().toISOString().slice(11, 19)}] ${s}`; log.push(l); console.log(l); };
const upd = (ev, v) => track(T, { results: { [rk(ev)]: v }, open: { id: ID, flow: FLOW } });
const meta = (v) => track(T, { flowMeta: { [`${ID}|${FLOW}`]: v } });

// ---------- DynamoDB lookup (read-only, scripts/check-uc20.ts) ----------
const BUNDLE = path.join(CLIENT, '.check-uc20.tmp.mjs');
execFileSync('npx', ['esbuild', path.resolve('scripts/check-uc20.ts'), '--bundle', '--platform=node', '--format=esm', '--packages=external', `--outfile=${BUNDLE}`, '--log-level=warning'], { cwd: CLIENT });
const db = (token) => JSON.parse(execFileSync('node', [BUNDLE, token], { cwd: CLIENT }).toString());

// ---------- payloads forwarded to the analytics backend during this run ----------
const payloadStart = fs.existsSync(PAYLOADS) ? fs.readFileSync(PAYLOADS, 'utf8').split('\n').length - 1 : 0;
const forwarded = (pred) => (fs.existsSync(PAYLOADS) ? fs.readFileSync(PAYLOADS, 'utf8').split('\n').slice(payloadStart) : [])
  .filter(Boolean).map(l => { try { return JSON.parse(l).payload; } catch { return null; } }).filter(p => p && pred(p));

// ---------- analytics report: every row ----------
async function report(tag) {
  const p = main.pages().find(p => p.url().startsWith('https://admin.shopify.com') && p.url().includes('/analytics'))
    || main.pages().find(p => p.url().startsWith('https://admin.shopify.com') && !p.url().includes('/customizer'));
  await p.goto(ANALYTICS, { waitUntil: 'load' });
  const f = await appFrame(p, 'text=/view report/i', 60000);
  await p.waitForTimeout(3000);
  await f.getByText(/view report/i).first().click();
  await p.waitForTimeout(8000);
  await p.screenshot({ path: `${OUT}/analytics-${tag}.png` });
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
  if (!Object.keys(rows).length) throw new Error('Analytics report could not be read (app not signed in?)');
  return rows;
}
const diffRows = (a, b) => Object.keys({ ...a, ...b }).flatMap(name => ['visitors', 'atc', 'checkout', 'conv', 'revenue']
  .filter(k => (a[name]?.[k] ?? 0) !== (b[name]?.[k] ?? 0)).map(k => `${name}.${k} ${a[name]?.[k] ?? 0}→${b[name]?.[k] ?? 0}`));
const delta = (a, b, row, k) => Math.round(((b[row]?.[k] ?? 0) - (a[row]?.[k] ?? 0)) * 100) / 100;
const others = (changes, k) => changes.filter(c => c.includes('.' + k + ' ') && !c.startsWith(INTENT + '.'));

// ---------- fresh shopper context (new session, empty cart) ----------
const ctx = await b.newContext({ viewport: { width: 1400, height: 1000 } });
const events = [];
const watch = (u) => /apps\/buywhy|api\/pixels/.test(u);
ctx.on('request', r => {
  if (!watch(r.url()) || r.method() !== 'POST') return;
  let d = {}; try { d = JSON.parse(r.postData()); } catch {}
  const a = d.analytics || {};
  const e = { type: a.eventType, endpoint: new URL(r.url()).host + new URL(r.url()).pathname, product: String(a.product?.id ?? a.data?.productId ?? ''), intent: a.data?.intent ?? null,
    session: a.sessionId, cart: a.data?.cartToken, lineItems: a.data?.lineItems?.map(i => `${i.productId}:${i.intent}`), req: r };
  events.push(e);
  step(`REQ ${e.endpoint} ${e.type} product=${e.product} intent=${e.intent} session=${e.session}${e.lineItems ? ' lineItems=' + e.lineItems : ''}`);
});
ctx.on('requestfailed', r => { const e = events.find(x => x.req === r); if (e) { e.failed = r.failure()?.errorText; step(`FAILED ${e.type} ${e.failed}`); } });
ctx.on('response', async r => {
  if (!watch(r.url()) || r.request().method() !== 'POST') return;
  const e = events.find(x => x.req === r.request()); let t = '';
  try { t = await r.text(); } catch {}
  let code; try { code = JSON.parse(t).code; } catch {}
  if (e) { e.status = r.status(); e.code = code; }
  step(`RESP ${r.status()} ${e?.type} product=${e?.product} code=${code} ${t.slice(0, 100)}`);
});
const waitFor = async (pred, ms) => { const end = Date.now() + ms; while (Date.now() < end) { const e = events.find(x => pred(x) && (x.code !== undefined || x.failed)); if (e) return e; await new Promise(r => setTimeout(r, 500)); } return events.find(pred); };
const fmt = (e) => e ? `${e.type} → ${e.code !== undefined ? 'code ' + e.code : e.failed ? 'request failed: ' + e.failed : 'response not captured'} (product ${e.product}, intent ${e.intent}, session ${e.session})` : 'no event sent';

async function open(P, url) {
  await P.goto(url, { waitUntil: 'load' });
  if (P.url().includes('/password')) {
    if (!STORE_PASSWORD) throw new Error('Storefront is password protected (set STORE_PASSWORD)');
    step('Storefront password page: unlocking');
    await P.fill('input[type="password"]', STORE_PASSWORD);
    await Promise.all([P.waitForNavigation({ waitUntil: 'load' }).catch(() => {}), P.keyboard.press('Enter')]);
    await P.goto(url, { waitUntil: 'load' });
  }
  await P.waitForTimeout(6000);
}
async function addToCart(P, productId) {
  await P.locator('form[action*="/cart/add"] button[type="submit"]:visible, form[action*="/cart/add"] [name="add"]:visible').first().click();
  const e = await waitFor(x => x.type === 'cta-click' && x.product === productId, 20000);
  await P.waitForTimeout(3000);
  return e;
}

try {
  step('Baseline analytics (all rows of the Sherwani report)');
  await track(T, { open: { id: ID, flow: FLOW }, flowMeta: { [`${ID}|${FLOW}`]: { date: new Date().toISOString().slice(0, 10) } } });
  for (const ev of ['pv', 'atc', 'co', 'pu']) await upd(ev, { status: 'not_run', code: '', before: '', after: '', notes: '⏳ Automation running…' });
  const before = await report('before');
  step('before ' + JSON.stringify(before));
  const B = before[INTENT] || {};
  await upd('pv', { before: String(B.visitors ?? 0) });
  await upd('atc', { before: String(B.atc ?? 0) });
  await upd('co', { before: String(B.checkout ?? 0) });
  await upd('pu', { before: String(B.revenue ?? 0) });

  // ---------- 1. Sherwani via intent link ----------
  const P = await ctx.newPage();
  step('Open ' + URL1);
  await open(P, URL1);
  const session = await P.evaluate(() => sessionStorage.getItem('buywhy_session_id') || (document.cookie.match(/buywhy_session_id=([^;]+)/) || [])[1] || '');
  await P.screenshot({ path: `${OUT}/1-sherwani-pdp.png` });
  const pv1 = await waitFor(e => e.type === 'intent-tab-click' && e.product === SS_ID, 12000);
  await meta({ session });
  await upd('pv', { code: String(pv1?.code ?? ''), notes: `⏳ Sherwani: ${fmt(pv1)}` });

  step('Add Sherwani to cart');
  const atc1 = await addToCart(P, SS_ID);
  const cart1 = await P.evaluate(async () => (await (await fetch('/cart.js')).json()));
  const cartToken = cart1.token.split('?')[0];
  const sessProp = cart1.items.find(i => String(i.product_id) === SS_ID)?.properties?._buywhy_session_id || '';
  step(`cart ${cartToken} items=${cart1.items.map(i => i.product_id)} _buywhy_session_id=${sessProp}`);
  await meta({ cart: cartToken });
  await upd('atc', { code: String(atc1?.code ?? ''), notes: `⏳ Sherwani: ${fmt(atc1)}` });

  // ---------- 2. Snowboard, same tab ----------
  step('Open ' + URL2);
  await open(P, URL2);
  await P.screenshot({ path: `${OUT}/2-snowboard-pdp.png` });
  const pv2 = await waitFor(e => e.type === 'intent-tab-click' && e.product === NONSS_ID, 12000);
  await upd('pv', { notes: `⏳ Sherwani: ${fmt(pv1)}. Snowboard: ${fmt(pv2)}` });
  step('Add Snowboard to cart');
  const atc2 = await addToCart(P, NONSS_ID);
  const cart2 = await P.evaluate(async () => (await (await fetch('/cart.js')).json()));
  step(`cart ${cart2.token} items=${cart2.items.map(i => i.product_id)} total=${cart2.total_price}`);
  const recAtc = db(cartToken);
  step('db after ATC ' + JSON.stringify(recAtc));
  await upd('atc', { notes: `⏳ Sherwani: ${fmt(atc1)}. Snowboard: ${fmt(atc2)}. CartItems stored: ${recAtc.cartItems.map(i => i.productId).join(',') || 'none'}` });

  // ---------- 3. Checkout ----------
  step('Go to /checkout');
  await P.goto(STORE + '/checkout', { waitUntil: 'load' });
  await P.waitForTimeout(10000);
  const co = await waitFor(e => e.type === 'checkout_page', 20000);
  await P.screenshot({ path: `${OUT}/3-checkout.png`, fullPage: true });
  await upd('co', { code: String(co?.code ?? ''), notes: `⏳ ${fmt(co)}; lineItems sent by the browser: ${co?.lineItems?.join(', ') ?? '—'}` });

  // ---------- address only, then manual payment ----------
  step('Fill checkout address');
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
  await P.screenshot({ path: `${OUT}/4-checkout-address.png`, fullPage: true });
  await P.bringToFront();
  fs.writeFileSync(`${OUT}/HANDOFF`, new Date().toISOString());
  step('HANDOFF: waiting for the tester to enter card details and click Pay now (up to 30 min)');
  await upd('pu', { notes: '⏳ Waiting for the tester to enter the card and click Pay now in the checkout window.' });
  await P.waitForURL(/thank[-_]you|orders\//, { timeout: 30 * 60000 }).catch(() => {});
  fs.rmSync(`${OUT}/HANDOFF`, { force: true });
  await P.waitForTimeout(5000);
  await P.screenshot({ path: `${OUT}/5-thank-you.png`, fullPage: true });
  const conf = await P.evaluate(() => (document.body.innerText.match(/Confirmation\s*#?\s*([A-Z0-9]{6,})/i) || [])[1] || '');
  step(`final url ${P.url().slice(0, 120)} confirmation=${conf}`);
  await meta({ order: conf });
  await upd('pu', { notes: conf ? `⏳ Order #${conf} placed. Waiting for the orders/create webhook, then checking DynamoDB and analytics.` : '❌ Payment did not reach the thank-you page.' });

  // ---------- after: webhook, DB, forwarded payloads, analytics ----------
  await new Promise(r => setTimeout(r, 60000));
  const rec = db(cartToken);
  step('db after order ' + JSON.stringify(rec));
  const fwd = forwarded(p => p.session_id === session || p.metadata?.data?.cartToken?.startsWith?.(cartToken) || p.cart_token?.startsWith?.(cartToken));
  for (const p of fwd) step(`FORWARDED ${p.event_type} product=${p.product_id} intent=${p.intent} lineItems=${JSON.stringify((p.metadata?.data?.lineItems || p.metadata?.line_items || []).map(i => String(i.productId ?? i.product_id)))}`);
  const after = await report('after');
  step('after ' + JSON.stringify(after));
  const changes = diffRows(before, after);
  step('analytics changes: ' + (changes.join(', ') || 'none'));
  const d = (k) => delta(before, after, INTENT, k);

  // ---------- verdicts ----------
  const pvOk = pv1?.code === 3001 && pv2?.code === 2004 && d('visitors') === 1 && !others(changes, 'visitors').length;
  await upd('pv', { after: String(after[INTENT]?.visitors ?? 0), status: pvOk ? 'pass' : 'fail',
    notes: `${pvOk ? '✅' : '❌'} Sherwani: ${fmt(pv1)}. Snowboard: ${fmt(pv2)}. ${INTENT} visitors ${d('visitors') >= 0 ? '+' : ''}${d('visitors')}${others(changes, 'visitors').length ? '; other rows changed: ' + others(changes, 'visitors') : ''}.` });

  const nonssItem = rec.cartItems.some(i => i.productId === NONSS_ID);
  const atcOk = atc1?.code === 3001 && atc2?.code === 2004 && !nonssItem && d('atc') === 1 && !others(changes, 'atc').length;
  await upd('atc', { after: String(after[INTENT]?.atc ?? 0), status: atcOk ? 'pass' : 'fail',
    notes: `${atcOk ? '✅' : '❌'} Sherwani: ${fmt(atc1)}. Snowboard: ${fmt(atc2)}. CartItems stored: ${rec.cartItems.map(i => `${i.productId}:${i.intent}`).join(', ') || 'none'}. Cart record intent: ${rec.cart?.intent ?? '—'}; _buywhy_session_id on line: ${sessProp ? 'yes' : 'NO'}. ${INTENT} ATC +${d('atc')}.` });

  const fwdCo = fwd.filter(p => p.event_type === 'checkout_page');
  const coItems = fwdCo.flatMap(p => (p.metadata?.data?.lineItems || []).map(i => String(i.productId)));
  const coOk = co?.code === 3001 && fwdCo.length > 0 && coItems.every(id => id === SS_ID) && coItems.includes(SS_ID) && d('checkout') === 1;
  await upd('co', { after: String(after[INTENT]?.checkout ?? 0), status: coOk ? 'pass' : 'fail',
    notes: `${coOk ? '✅' : '❌'} ${fmt(co)}. Browser sent lineItems [${co?.lineItems?.join(', ') ?? '—'}]; forwarded to analytics: [${coItems.join(', ') || 'nothing forwarded'}]${fwdCo[0] ? ` (product_id ${fwdCo[0].product_id}, intent ${fwdCo[0].intent}, itemCount ${fwdCo[0].metadata?.data?.itemCount}, totalPrice ${fwdCo[0].metadata?.data?.totalPrice})` : ''}. ${INTENT} checkout +${d('checkout')}.` });

  const order = rec.orders[0];
  const fwdPu = fwd.filter(p => p.event_type === 'purchase');
  const puItems = fwdPu.flatMap(p => (p.metadata?.line_items || []).map(i => String(i.product_id)));
  const orderTotal = order?.totalPrice != null ? order.totalPrice / 100 : null;
  const puOk = !!conf && !!order && order.lineItems.join() === SS_ID && puItems.length > 0 && puItems.every(id => id === SS_ID)
    && d('conv') === 1 && orderTotal != null && Math.abs(d('revenue') - orderTotal) < 0.01;
  await upd('pu', { code: 'webhook', after: String(after[INTENT]?.revenue ?? 0), status: puOk ? 'pass' : 'fail',
    notes: `${puOk ? '✅' : '❌'} Order #${conf || '—'}${order ? ` (${order.name}, total $${orderTotal})` : ': no Order record for the cart'}. Order record lineItems: [${order?.lineItems?.join(', ') ?? '—'}]; forwarded purchase product_id ${fwdPu[0]?.product_id ?? '—'}, intent ${fwdPu[0]?.intent ?? '—'}, line_items [${puItems.join(', ') || '—'}]. ${INTENT}: conversions +${d('conv')}, revenue +$${d('revenue')}.${others(changes, 'conv').length || others(changes, 'revenue').length ? ' Other rows changed: ' + [...others(changes, 'conv'), ...others(changes, 'revenue')].join(', ') : ''}` });

  const fullTotals = fwdCo[0] && Number(fwdCo[0].metadata?.data?.itemCount) === 2;
  await track(T, { checks: { [`${ID}|0`]: coOk && !nonssItem && order?.lineItems?.join() === SS_ID, [`${ID}|1`]: !!fullTotals },
    caseNotes: { [ID]: { notes: `Automated run ${new Date().toISOString().slice(0, 16)} on feature/skip-analytics-non-ss-products. Session ${session}, cart ${cartToken}, order #${conf}. Analytics changes: ${changes.join(', ') || 'none'}. Evidence: evidence/uc20/.` } } });
} catch (e) {
  step('ERROR ' + e.message.split('\n')[0]);
  for (const [i, p] of ctx.pages().entries()) await p.screenshot({ path: `${OUT}/error-${i}.png`, fullPage: true }).catch(() => {});
  const s = JSON.parse(await T.evaluate(() => localStorage.getItem('ss-analytics-test-tracker-v1')));
  for (const ev of ['pv', 'atc', 'co', 'pu']) {
    const r = s.results[rk(ev)];
    if (r?.notes?.startsWith('⏳')) await upd(ev, { status: 'blocked', notes: `Automation stopped: ${e.message.split('\n')[0]}. Last: ${r.notes.slice(2)}` });
  }
}
fs.rmSync(BUNDLE, { force: true });
fs.writeFileSync(`${OUT}/log.txt`, log.join('\n') + '\n');
await ctx.close();
process.exit(0);
