# Session handoff: skip analytics for non-ShopperSense products

Context from the previous Claude session (2026-10-15 to 2026-10-16). Read once; it is not loaded automatically.

## Goal
Only record storefront analytics for products the merchant generated intents for (have `ProductIntentDetail` rows), not every product in the store.

## Code changes (ss-shopify-client, branch `feature/skip-analytics-non-ss-products`, NOT committed yet)
- `app/services/analytics/productFilter.server.ts` (new): `hasShopperSenseIntents(shop, productId)` queries `ProductIntentDetail.byProduct` with limit 1 (numeric ID, then `gid://` form). `filterShopperSenseProducts(analytics, shop)`:
  - `cta-click` / `cart-click`: drop if the product has no intents. Events with no product ID are kept.
  - `checkout_page`: removes non-SS line items, drops the event if none are left, and re-points the primary product to the first remaining item.
  - `intent-tab-click` (page view): NOT filtered yet.
- `app/controllers/analytics.controller.ts`: the filter runs at the top of `processIntentAnalytics` (web pixel, `/api/pixels`) and `routeIntentAnalytics` (app proxy, `/apps/buywhy`). New code `NON_SHOPPERSENSE_PRODUCT: 2004`.
- Tests: `tests/analytics/productFilter.test.ts` (8 cases); `tests/pageStudio/checkout-page.test.ts` now mocks `ProductIntentDetail`. All 523 tests pass.
- `extensions/web-pixel/src/index.js`: `getAppUrl()` hard-coded to a trycloudflare tunnel URL for local testing. **Revert before committing.**
- No caching: the user chose to query every time.

## Decisions / facts confirmed by the user
- All clients were onboarded after `ProductIntentDetail` was introduced (2026-07-24), so no backfill is needed.
- `ProductIntentDetail` rows are written only in the customizer save (`app/routes/app.customizer.tsx`, right after `updateProductComponentData`).

## Known gaps (not fixed)
1. Page views (`intent-tab-click`) for non-SS products are still recorded (code 3001). Fix: apply the product check to that event type too.
2. Buy-now/wallet buttons on pages with no product (e.g. `/cart`) send no product ID, so the event is let through and its order can be recorded.
3. `clearProductComponentData` (customizer.tsx:799, _index.tsx:61 and :100) never deletes `ProductIntentDetail` rows, so a product whose intents were all removed still counts as ShopperSense.
4. On mixed carts, checkout `itemCount`/`totalPrice` and the order's `totalPrice` / `metadata.lineItems` still include non-SS products.
5. A checkout started from a different tab gets a new session ID, so its line items are sent with `intent: default`.

## Environment issues
- ENV-01: the web pixel falls back to production (`https://ss-client.fly.dev`) because build-time `process.env` values don't reach it, so dev-store pixel events go to production. Test events from 2026-10-15 are in production under cart `hWNI0VSW9FDWfAKJDd4Ug4ht`.
- ENV-02: after restarting `shopify app dev`, theme app extension assets on the dev CDN returned 404. The automation served them from `extensions/shoppersense-blocks/assets/` instead.

## Browser E2E results (dev store `vijay-shoppersense-dev-non-plus`)
- Sherwani (`10071543513371`, intent Plateau Breakthrough) page view → 3001; visitors went from 23 to 24.
- Sherwani add to cart → 3001. Complete Snowboard (`10071511433499`, no intents) add to cart → **2004 (dropped)**.
- Mixed checkout → 3001. Order placed manually: Confirmation #CGUIJ0RF2, cart `hWNI2lueCZfKaU4oQVxYzkJQ`, $5,699.95.
- **Not done yet:** refresh the analytics report after that order (TC-06 / TC-08), and check that the Snowboard wasn't attributed.

## Test repo: /Users/vijaykumar/Desktop/Workspace/Shoppersense/ss-analytics-filter-tests
- `index.html`: manual tracker UI. 22 use cases × 4 events (Page view, ATC, Checkout, Purchase) × ATC/Buy-now flows; data saved in localStorage key `ss-analytics-test-tracker-v1`; Matrix tab has info/URL tooltips. Use cases are defined in `usecases.js`.
- `TEST_CASES.md` / `results.html`: automated run results. `scripts/`: Playwright scripts (connect over CDP to Chrome on port 9333).
- Serve with `python3 -m http.server 4400` in that folder.
- A separate older repo, `../analytics-e2e-tests`, was created by another session and has been left untouched.

## Possible next steps
- Fix gaps 1–3, then revert the pixel URL hack and commit/PR the branch to `development`.
- Fix ENV-01 (pixel build-time URL).
