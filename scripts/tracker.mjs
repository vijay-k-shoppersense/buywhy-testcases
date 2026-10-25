// Writes automation results into the manual tracker (index.html) by editing its localStorage
// in a tab of the CDP Chrome, then reloading that tab so the UI shows the update.
const TRACKER = 'http://127.0.0.1:4400/';
const KEY = 'ss-analytics-test-tracker-v1';

export async function trackerPage(ctx) {
  let p = ctx.pages().find(p => p.url().startsWith(TRACKER) && !p.url().includes('results'));
  if (!p) { p = await ctx.newPage(); await p.goto(TRACKER, { waitUntil: 'load' }); }
  return p;
}

// patch: { results: { 'UC-01|atc|pv': {status, code, before, after, notes} }, flowMeta: { 'UC-01|atc': {...} },
//          checks: { 'UC-01|0': true }, caseNotes: { 'UC-01': { notes } }, open: { id, flow } }
export async function track(p, patch) {
  await p.evaluate(([KEY, patch]) => {
    let s = {};
    try { s = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch {}
    s.version ??= 1; s.results ??= {}; s.flowMeta ??= {}; s.checks ??= {}; s.caseNotes ??= {};
    s.ui ??= { tab: 'cases', open: [], flow: {}, q: '', fg: '', fs: '' };
    const now = new Date().toISOString();
    for (const [k, v] of Object.entries(patch.results || {})) s.results[k] = { ...(s.results[k] || {}), ...v, updatedAt: now, by: 'automation' };
    for (const [k, v] of Object.entries(patch.flowMeta || {})) s.flowMeta[k] = { ...(s.flowMeta[k] || {}), ...v };
    Object.assign(s.checks, patch.checks || {});
    for (const [k, v] of Object.entries(patch.caseNotes || {})) s.caseNotes[k] = { ...(s.caseNotes[k] || {}), ...v };
    if (patch.open) {
      const tabsView = /^(IT|RT)-/.test(patch.open.id);
      s.ui.tab = tabsView ? 'tabs' : 'cases'; s.ui.lview = tabsView ? 'tabs' : 'core'; s.ui.q = ''; s.ui.fg = ''; s.ui.fs = '';
      s.ui.open = [...new Set([...(s.ui.open || []), patch.open.id])];
      s.ui.flow = { ...(s.ui.flow || {}), [patch.open.id]: patch.open.flow };
    }
    localStorage.setItem(KEY, JSON.stringify(s));
  }, [KEY, patch]);
  await p.reload({ waitUntil: 'load' });
  if (patch.open) await p.evaluate((id) => document.getElementById('card-' + id)?.scrollIntoView({ block: 'start' }), patch.open.id).catch(() => {});
}

export async function exportState(p) {
  return p.evaluate((KEY) => localStorage.getItem(KEY), KEY);
}
