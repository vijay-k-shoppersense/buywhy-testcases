# Test cases: skip analytics for non-ShopperSense products

Branch under test: `feature/skip-analytics-non-ss-products` (ss-shopify-client).
The server should only record cart, checkout and order analytics for products that have generated intents (`ProductIntentDetail` rows).

**Test data**

| Item | Value |
|---|---|
| Store | `vijay-shoppersense-dev-non-plus.myshopify.com` |
| ShopperSense product | The Royal Sherwani Set, `10071543513371`, $5,000.00 |
| Intent used | Plateau Breakthrough, `013cbda3-3909-40da-a131-e89d81deaf9d` |
| Intent URL | `/products/the-royal-sherwani-set?view=shopper-intent&ss_trace_id=013cbda3-3909-40da-a131-e89d81deaf9d` |
| Non-ShopperSense product | The Complete Snowboard, `10071511433499`, $699.95 (`hasShopperSenseIntents` → `false`) |
| Analytics page | `/app/products/a2a3e134-7d4a-4336-a1ec-9f2aba7eeba9/analytics` (click **View report** to refresh) |

**Server response codes**

| Code | Meaning |
|---|---|
| `3001` | Saved and forwarded to the analytics backend |
| `3002` | Saved, not forwarded |
| `2004` | Dropped: product has no intents (new filter) |

**Status key:** ✅ Pass · ❌ Fail · ⚠️ Observation (not caused by this branch) · ⏳ In progress · ⬜ Not run

## Storefront end-to-end

| ID | Scenario | Steps | Expected | Actual | Status | Run |
|---|---|---|---|---|---|---|
| TC-01 | Page view on a ShopperSense product | Open the intent URL in a new tab; refresh analytics | `intent-tab-click` → `3001`; Plateau Breakthrough visitors +1 | `3001`; visitors 23 → 24 | ✅ | R1 |
| TC-02 | Page view on a non-ShopperSense product | Open `/products/the-complete-snowboard` | Not recorded | `intent-tab-click` with `intent: null` → `3001` (recorded) | ❌ | R1, R2 |
| TC-03 | Add to cart, ShopperSense product (web pixel) | Tab A: intent URL → Add to cart | `cta-click` → `3001`, intent Plateau Breakthrough, `_buywhy_session_id` on the cart line | `3001`, intent + intentId sent, session property attached | ✅ | R2 |
| TC-04 | Add to cart, non-ShopperSense product (web pixel) | Tab B, same cart: Snowboard → Add to cart | `cta-click` → `2004` (dropped) | `2004` | ✅ | R2 |
| TC-05 | Add to cart, non-ShopperSense product, sent straight to the local server | `curl` POST to `/api/pixels` | `2004` | `2004` | ✅ | R2 |
| TC-06 | Checkout, mixed cart | Tab B → `/checkout` with Sherwani + Snowboard | `checkout_page` → `3001`; only the Sherwani line item is stored | `3001`. Stored line items not yet checked in analytics | ⏳ | R2 |
| TC-07 | Checkout attribution across tabs | Intent set in tab A; checkout started from tab B | Sherwani line item keeps Plateau Breakthrough | Tab B got a new session (`…r51xd71w`), so both line items were sent as `intent: default` | ⚠️ | R2 |
| TC-08 | Purchase, mixed cart | Pay with Bogus Gateway (card `1`, 12/27, CVC 123) | Order recorded; Plateau Breakthrough conversions +1; Snowboard not attributed | Card-field step timed out; order not placed yet | ⏳ | R2 |
| TC-09 | Checkout, non-ShopperSense products only | Cart with only the Snowboard → `/checkout` | `checkout_page` → `2004` | — | ⬜ | — |
| TC-10 | Purchase, non-ShopperSense products only | Complete TC-09 | No `Cart` record, so the order webhook skips the order | — | ⬜ | — |
| TC-11 | Buy-now (wallet) from the cart page | Shop Pay / Apple Pay button on `/cart` | Known gap: no product ID, so the event is let through | — | ⬜ | — |
| TC-12 | Mixed checkout: revenue/totals | Check `itemCount` / `totalPrice` after TC-08 | Known gap: totals still include the Snowboard | — | ⬜ | — |

## Unit tests (vitest, ss-shopify-client)

| ID | Case | Status |
|---|---|---|
| UT-01 | Keeps add-to-cart events for products with intents | ✅ |
| UT-02 | Drops add-to-cart events for products without intents | ✅ |
| UT-03 | Matches products stored as a `gid://shopify/Product/…` ID | ✅ |
| UT-04 | Lets add-to-cart events without a product ID through | ✅ |
| UT-05 | Does not filter `intent-tab-click` events | ✅ |
| UT-06 | Drops checkout events with no ShopperSense line items | ✅ |
| UT-07 | Removes non-ShopperSense line items and switches the main product | ✅ |
| UT-08 | Leaves checkout events untouched when every line item is ours | ✅ |
| UT-09 | Existing `checkout-page.test.ts` suite still passes (ProductIntentDetail mocked) | ✅ |

## Environment issues found during testing

| ID | Issue | Impact | Workaround |
|---|---|---|---|
| ENV-01 | Web pixel's `getAppUrl()` falls back to production (`https://ss-client.fly.dev`); build-time `process.env` values don't reach it | Dev-store pixel events go to production, which has no filter. Test events from R1 are in production under cart token `hWNI0VSW9FDWfAKJDd4Ug4ht` | URL hard-coded to the local tunnel in `extensions/web-pixel/src/index.js` (do not commit) |
| ENV-02 | After restarting `shopify app dev`, every theme app extension asset on `cdn.shopify.com/extensions/.../dev-.../assets/` returns 404 | Theme tracker and blocks don't load: no page views, no stored intents, no `_buywhy_session_id` | Test browser serves the files from `extensions/shoppersense-blocks/assets/` (`ctx.route` in `scripts/full.mjs`) |
| ENV-03 | Production and the local app read the same analytics data | R1 production events changed the local analytics page (Current PDP ATC 1 → 2, checkout 0 → 1) | Use fresh carts per run and compare before/after |

## Analytics snapshots (Plateau Breakthrough row unless noted)

| When | Visitors | ATC | Checkout | Conversions | Revenue |
|---|---|---|---|---|---|
| R1 before | 23 | 5 | 3 | 3 | $15,000.00 |
| R1 after page view | 24 | 5 | 3 | 3 | $15,000.00 |
| R2 before | 24 | 5 | 3 | 3 | $15,000.00 |
| R2 before (Current PDP row) | 11 | 2 | 1 | — | — |

## Runs

| Run | Date | Notes |
|---|---|---|
| R1 | 2026-10-15 | Page view passed. Pixel was sending to production (ENV-01), so cart/checkout results were not valid |
| R2 | 2026-10-16 | Pixel pointed at local tunnel; theme assets served locally (ENV-02). Filter confirmed for add to cart; purchase step pending |

See also: `../analytics-e2e-tests` (an earlier session's run log for the same branch).
