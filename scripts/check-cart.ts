// Read-only: prints the Cart record and any Order records for the given cart tokens.
// Bundle with esbuild and run from ss-shopify-client so .env loads:
//   npx esbuild <this> --bundle --platform=node --format=esm --packages=external --outfile=/tmp/check-cart.mjs
//   node /tmp/check-cart.mjs <cartToken> [...]
import "dotenv/config";
import { Cart } from "/Users/vijaykumar/Desktop/Workspace/Shoppersense/ss-shopify-client/app/db/entities/cart";
import { Order } from "/Users/vijaykumar/Desktop/Workspace/Shoppersense/ss-shopify-client/app/db/entities/order";

const shopDomain = "vijay-shoppersense-dev-non-plus.myshopify.com";
const tokens = process.argv.slice(2).map(t => t.split("?")[0]);
const orders = (await Order.query.byShop({ shopDomain }).go({ pages: "all" })).data;
const out: Record<string, unknown> = {};
for (const cartToken of tokens) {
  const cart = (await Cart.get({ shopDomain, cartToken }).go()).data;
  out[cartToken] = {
    cart: cart ? { sessionId: cart.sessionId, itemCount: cart.itemCount, totalPrice: cart.totalPrice, source: cart.source, lineItems: (cart.metadata as any)?.lineItems?.length } : null,
    orders: orders.filter(o => o.cartToken === cartToken).map(o => ({ id: o.id, ...Object.fromEntries(Object.entries(o).filter(([k]) => /price|total|intent|tag/i.test(k))) })),
  };
}
console.log(JSON.stringify(out, null, 2));
process.exit(0);
