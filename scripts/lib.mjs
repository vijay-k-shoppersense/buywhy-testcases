import { chromium } from 'playwright';
export async function connect() {
  const b = await chromium.connectOverCDP('http://localhost:9333');
  return { b, ctx: b.contexts()[0] };
}
export function adminPage(ctx) { return ctx.pages().find(p => p.url().includes('admin.shopify.com')); }
export async function appFrame(page, sel = 'body', timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    for (const f of page.frames()) {
      if (f === page.mainFrame()) continue;
      try { if (await f.$(sel)) return f; } catch {}
    }
    await page.waitForTimeout(500);
  }
  throw new Error('app frame not found for ' + sel);
}
