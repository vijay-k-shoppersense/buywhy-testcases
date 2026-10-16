# ShopperSense analytics filter tests

Browser end-to-end checks for the ss-shopify-client branch `feature/skip-analytics-non-ss-products`. Results are tracked in [TEST_CASES.md](TEST_CASES.md).

## Manual test tracker

`index.html` is a tracker for manual testing. It has 22 use cases (organic, ad, intent, A/B control/variant, template, the non-ShopperSense filter, multi-product). Each use case is checked against the 4 analytics events: **Page view, Add to cart, Checkout, Purchase**, for both the Add to cart and Buy now flows.

- Serve the folder (`python3 -m http.server 4400`) and open http://127.0.0.1:4400.
- Every change is saved to the browser's localStorage (`ss-analytics-test-tracker-v1`). Use **Export JSON** to back up or move results and **Export CSV** to share them.
- **Settings** fills the URL placeholders (store, products, intent, experiment, utm, template).
- Use cases live in `usecases.js`. `results.html` shows the automated run results from `TEST_CASES.md`.

## Setup

1. `npm install`. The scripts use the installed Google Chrome, so no Playwright browser download is needed.
2. Start Chrome with remote debugging and a separate profile, then log in to Shopify admin in it:
   ```sh
   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9333 --user-data-dir="$PWD/chrome-profile"
   ```
3. Run `shopify app dev` in ss-shopify-client and make sure the web pixel posts to the current tunnel (see ENV-01 in TEST_CASES.md).
4. Set credentials as environment variables (never commit them): `STORE_PASSWORD`, `APP_EMAIL`, `APP_PASSWORD`.

## Scripts

| Script | What it does |
|---|---|
| `scripts/login2.mjs` | Signs in to the BuyWhy app inside Shopify admin |
| `scripts/analytics2.mjs <tag>` | Opens the product analytics page, clicks **View report**, prints the intent summary and saves a screenshot |
| `scripts/full.mjs` | Fresh browser context: intent URL + add to cart (tab A), Snowboard add to cart (tab B), checkout, Bogus Gateway payment. Logs every `/api/pixels` and `/apps/buywhy` request and response code |
| `scripts/check-pid.ts` | Calls `hasShopperSenseIntents` for the test products (bundle with esbuild and run from ss-shopify-client so `.env` loads) |

Screenshots used as evidence are in `evidence/`.
