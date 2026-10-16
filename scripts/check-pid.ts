import "dotenv/config";
import { hasShopperSenseIntents } from "/Users/vijaykumar/Desktop/Workspace/Shoppersense/ss-shopify-client/app/services/analytics/productFilter.server";
const shop = "vijay-shoppersense-dev-non-plus.myshopify.com";
for (const id of ["10071543513371", "10071511433499"]) console.log(id, await hasShopperSenseIntents(shop, id));
