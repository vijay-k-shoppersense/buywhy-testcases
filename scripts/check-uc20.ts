// Read-only: for one cart token prints the Cart record (incl. stored checkout line items),
// its CartItem rows and any Order records, with the product IDs each one holds.
// Bundle with esbuild and run from ss-shopify-client so .env loads (see uc20.mjs).
import "dotenv/config";
import { Cart } from "/Users/vijaykumar/Desktop/Workspace/Shoppersense/ss-shopify-client/app/db/entities/cart";
import { CartItem } from "/Users/vijaykumar/Desktop/Workspace/Shoppersense/ss-shopify-client/app/db/entities/cartItem";
import { Order } from "/Users/vijaykumar/Desktop/Workspace/Shoppersense/ss-shopify-client/app/db/entities/order";

const shopDomain = "vijay-shoppersense-dev-non-plus.myshopify.com";
const cartToken = process.argv[2].split("?")[0];
const pid = (i: any) => String(i?.productId ?? i?.product_id ?? "");

const cart = (await Cart.get({ shopDomain, cartToken }).go()).data as any;
const items = (await CartItem.query.byCart({ shopDomain, cartToken }).go().catch(() => ({ data: [] }))).data as any[];
const orders = ((await Order.query.byShop({ shopDomain }).go({ pages: "all" })).data as any[]).filter(o => o.cartToken === cartToken);

console.log(JSON.stringify({
  cart: cart ? {
    sessionId: cart.sessionId, itemCount: cart.itemCount, totalPrice: cart.totalPrice, source: cart.source,
    intent: cart.metadata?.attribution?.intent ?? null,
    checkoutTimestamp: cart.metadata?.data?.checkout_timestamp ?? null,
    checkoutLineItems: (cart.metadata?.lineItems ?? cart.metadata?.data?.lineItems ?? null)?.map(pid) ?? null,
  } : null,
  cartItems: items.map(i => ({ productId: pid(i), intent: i.metadata?.attribution?.intent ?? null })),
  orders: orders.map(o => ({
    id: o.id, name: o.metadata?.name, totalPrice: o.totalPrice, sessionId: o.sessionId,
    lineItems: (o.metadata?.lineItems ?? []).map(pid),
    intent: o.metadata?.data?.intent ?? o.metadata?.data?.activeIntentName ?? null,
  })),
}));
process.exit(0);
