import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
const ASSETS = '/Users/vijaykumar/Desktop/Workspace/Shoppersense/ss-shopify-client/extensions/shoppersense-blocks/assets';
const STORE = 'https://vijay-shoppersense-dev-non-plus.myshopify.com';
const b = await chromium.connectOverCDP('http://localhost:9333');
const ctx = await b.newContext({ viewport: { width: 1400, height: 1000 } });

// Test-harness only: serve theme app extension assets from the local repo (dev CDN returns 404).
await ctx.route(/cdn\.shopify\.com\/extensions\/.*\/assets\/([^/?]+)/, async (route) => {
  const name = decodeURIComponent(new URL(route.request().url()).pathname.split('/').pop());
  const file = path.join(ASSETS, name);
  if (!fs.existsSync(file)) return route.continue();
  const type = name.endsWith('.css') ? 'text/css' : 'application/javascript';
  return route.fulfill({ status: 200, contentType: type, body: fs.readFileSync(file) });
});

const log = [];
const step = (s) => { log.push('--- ' + s); console.log('--- ' + s); };
const watch = (u) => /apps\/buywhy|api\/pixels/.test(u);
ctx.on('request', r => { if (watch(r.url()) && r.method() === 'POST') { let d = {}; try { d = JSON.parse(r.postData()); } catch {} const a = d.analytics || {}; const li = a.data?.lineItems; log.push(`REQ  ${new URL(r.url()).host}${new URL(r.url()).pathname} ${a.eventType} product=${a.product?.id ?? a.data?.productId} intent=${a.data?.intent} intentId=${a.data?.intentId ?? ''} session=${a.sessionId} cart=${a.data?.cartToken ?? ''}${li ? ' lineItems=' + li.map(i => i.productId + ':' + i.intent).join(',') : ''}`); } });
ctx.on('response', async r => { if (watch(r.url()) && r.request().method() === 'POST') { let t=''; try { t = (await r.text()).slice(0, 120); } catch {} log.push(`RESP ${r.status()} ${t}`); } });

async function unlock(p, url) {
  await p.goto(url, { waitUntil: 'load' });
  if (p.url().includes('/password')) {
    await p.fill('input[type="password"]', process.env.STORE_PASSWORD);
    await Promise.all([p.waitForNavigation({ waitUntil: 'load' }).catch(() => {}), p.press('input[type="password"]', 'Enter')]);
    await p.goto(url, { waitUntil: 'load' });
  }
}
async function atc(p) {
  await p.waitForTimeout(3000);
  await p.locator('form[action*="/cart/add"] button[type="submit"]:visible, form[action*="/cart/add"] [name="add"]:visible').first().click();
  await p.waitForTimeout(8000);
}

try {
  const A = await ctx.newPage();
  step('A: open Plateau intent URL');
  await unlock(A, STORE + '/products/the-royal-sherwani-set?view=shopper-intent&ss_trace_id=013cbda3-3909-40da-a131-e89d81deaf9d');
  await A.waitForTimeout(6000);
  step('A: tracker loaded=' + await A.evaluate(() => !!window.BuyWhyAnalytics));
  step('A: ATC Royal Sherwani Set');
  await atc(A);

  const B = await ctx.newPage();
  step('B: open The Complete Snowboard');
  await B.goto(STORE + '/products/the-complete-snowboard', { waitUntil: 'load' });
  await B.waitForTimeout(4000);
  step('B: ATC The Complete Snowboard');
  await atc(B);
  const cart = await B.evaluate(async () => (await (await fetch('/cart.js')).json()));
  step(`cart ${cart.token.split('?')[0]} items=${cart.items.map(i => i.product_id + ' props=' + JSON.stringify(i.properties)).join(' ; ')} total=${cart.total_price}`);

  step('B: go to checkout');
  await B.goto(STORE + '/checkout', { waitUntil: 'load' });
  await B.waitForTimeout(10000);

  step('B: fill contact + address');
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

  step('B: fill card');
  const card = async (frameName, val) => {
    const fl = B.frameLocator(`iframe[name^="card-fields-${frameName}"]`).first();
    const input = fl.locator('input').first();
    await input.click(); await input.pressSequentially(val, { delay: 60 });
  };
  await card('number', '1');
  await card('expiry', '1227');
  await card('verification_value', '123');
  await card('name', 'Test Buyer');
  await B.waitForTimeout(2000);
  await B.screenshot({ path: 'full-before-pay.png', fullPage: true });

  step('B: pay');
  await B.locator('button#checkout-pay-button, button:has-text("Pay now"), button:has-text("Complete order")').first().click();
  await B.waitForURL(/thank[-_]you|orders\//, { timeout: 90000 }).catch(() => {});
  await B.waitForTimeout(8000);
  step('final url ' + B.url().slice(0, 140));
  await B.screenshot({ path: 'full-after-pay.png', fullPage: true });
  const conf = await B.evaluate(() => document.body.innerText.match(/(Order|Confirmation)\s*#?\s*[A-Z0-9-]+/i)?.[0] || '');
  step('confirmation: ' + conf);
} catch (e) {
  step('ERROR ' + e.message.split('\n')[0]);
  for (const p of ctx.pages()) await p.screenshot({ path: `full-error-${ctx.pages().indexOf(p)}.png`, fullPage: true }).catch(() => {});
}
console.log('\n' + log.join('\n'));
process.exit(0);
