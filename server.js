#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Shufersal, AuthenticationError } from './shufersal.js';

const shopping = new Shufersal();
const server = new McpServer({ name: 'itamux-shufersal', version: '0.4.5' });
function tool(name, description, inputSchema, call) {
  server.registerTool(name, { description: description + (!['open_shufersal', 'login_shufersal'].includes(name) ? ' The server refreshes a logged-out session once before starting this operation. Failed writes are never replayed automatically.' : ''), inputSchema }, async args => {
    try {
      return { content: [{ type: 'text', text: JSON.stringify(await call(args)) }] };
    } catch (error) {
      if (error instanceof AuthenticationError) return { isError: true, content: [{ type: 'text', text: error.message }] };
      // Browser/network errors may contain credentials, request bodies or
      // session-bearing URLs. Never return those through MCP or console logs.
      return { isError: true, content: [{ type: 'text', text:
        `${name} failed. Check connection and Claw Patrol configuration. For login, credentials or a verification challenge may need attention. After a coupon activation failure, read coupon state before retrying. After a cart failure, read the cart before retrying: the change may already have happened. Do not retry writes automatically.` }] };
    }
  });
}
tool('open_shufersal', 'Open Shufersal headlessly and report whether the current session is authenticated.', {}, () => shopping.open());
tool('login_shufersal', 'Log in once using configured Claw Patrol email/password placeholders. No credentials are accepted as tool arguments. Reuse an authenticated session; do not retry failures automatically.', {}, () => shopping.login());
const code = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
const catalog = {
  category_code: code.optional(),
  brand_codes: z.array(code).max(10).default([]),
  filters: z.array(z.object({ code, value: z.string().min(1).max(200).regex(/^[^:\x00-\x1f]+$/) })).max(12).default([]).describe('Use code/value pairs from returned facets'),
  sort: z.enum(['relevance', 'pricePerUnit-asc', 'pricePerUnit-desc', 'name-asc', 'name-desc', 'popularity', 'topRated']).default('relevance'),
  page: z.number().int().min(0).max(1000).default(0),
  page_size: z.number().int().min(1).max(50).default(15),
  food_only: z.boolean().default(false),
};
tool('search_shufersal', 'Search products with server-side paging, category, brand, available facets and sorting. Includes stockStatus and availability (in_stock, out_of_stock, unknown). Never assume unknown means in stock; cart verification is still required. Facets describe available filter codes. Does not change the cart.', { ...catalog, query: z.string().trim().min(1).max(200).regex(/^[^:\x00-\x1f]+$/) }, args => shopping.search(args));
tool('get_shufersal_categories', 'List top-level categories, or direct subcategories of parent_code. Repeat to browse deeper; an empty list means a leaf.', { parent_code: code.optional() }, args => shopping.categories(args));
tool('browse_shufersal_category', 'Browse products in a category or subcategory returned by get_shufersal_categories, with paging, sorting, filters, stockStatus and availability (in_stock, out_of_stock, unknown). Never assume unknown means in stock; cart verification is still required.', { ...catalog, category_code: code }, args => shopping.search(args));
tool('get_shufersal_sales', 'List current sale offers, including multi-buy terms. Use promotionCode with get_shufersal_promotion_products for eligible products and regular prices. Does not activate coupons.', { category_code: code.default('A'), page: z.number().int().min(0).max(1000).default(0) }, args => shopping.sales(args));
tool('get_shufersal_promotion_products', 'List products eligible for one sale offer or personal coupon promotionCode. Availability is unknown when this listing provides no stock signal; check search results and verify the cart. Prices are regular item prices; read offer terms for discounts and required quantities.', { promotion_code: code }, args => shopping.promotionProducts(args));
tool('get_shufersal_personal_coupons', 'Read this authenticated account’s unexpired personal coupons and activation status. Excludes prepaid cards and redemption codes. Does not activate or redeem coupons.', { limit: z.number().int().min(1).max(100).default(20), offset: z.number().int().min(0).max(10000).default(0), activated: z.boolean().optional(), expiring_only: z.boolean().default(false) }, args => shopping.coupons(args));
tool('activate_shufersal_coupon', 'Activate one unexpired account coupon selected by promotion_code from personal coupons. Already-active coupons are a no-op. Confirms activation with a fresh account read. Does not redeem or buy anything. After failure read coupon state before retrying; no automatic retries.', { promotion_code: code }, args => shopping.activateCoupon(args));
const product = {
  product_code: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/).describe('Exact product code from search or cart'),
  selling_method: z.enum(['BY_UNIT', 'BY_WEIGHT']).describe('Selling method code from search or cart'),
};
const quantity = z.number().positive().max(1000).describe('Units for BY_UNIT, weight quantity for BY_WEIGHT');
tool('get_shufersal_cart', 'Read the current authenticated cart, quantities, itemCount, outOfStock and calculationError flags, and displayed total including delivery/service. Item lineTotal (also returned as price) is the entire row amount, not a unit price; savings is separate from total. These are displayed amounts, not a completed charge. Unavailable or error rows are not confirmed purchasable items.', {}, () => shopping.cart());
tool('add_to_shufersal_cart', 'Add a product to the draft cart and verify its new quantity and absence of stock/calculation errors. Changes the cart, never checks out. Do not retry automatically.', { ...product, quantity }, args => shopping.changeCart('add', args));
tool('update_shufersal_cart_item', 'Set the absolute quantity of one cart product. Requires its current quantity from get_shufersal_cart; rejects stale values. Never edits an existing order.', { ...product, quantity, expected_quantity: quantity }, args => shopping.changeCart('update', args));
tool('remove_from_shufersal_cart', 'Remove one product from the draft cart and verify removal. Requires its current quantity from get_shufersal_cart.', { ...product, expected_quantity: quantity }, args => shopping.changeCart('remove', args));
tool('get_shufersal_order_history', 'Read online order history, newest first. Returns order identifiers, dates and totals; does not reorder or cancel.', { limit: z.number().int().min(1).max(100).default(20), offset: z.number().int().min(0).max(10000).default(0) }, args => shopping.orderHistory(args));
tool('get_shufersal_order', 'Read purchased products in one order returned by get_shufersal_order_history. Does not change orders or send invoices.', { order_number: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/) }, args => shopping.orderDetails(args.order_number));
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await shopping.close();
  await server.close();
}
process.once('SIGINT', () => void close());
process.once('SIGTERM', () => void close());
process.stdin.once('end', () => void close());
await server.connect(new StdioServerTransport());
