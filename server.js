#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Shufersal } from './shufersal.js';

const shopping = new Shufersal();
const server = new McpServer({ name: 'itamux-shufersal', version: '0.2.0' });
function tool(name, description, inputSchema, call) {
  server.registerTool(name, { description, inputSchema }, async args => {
    try {
      return { content: [{ type: 'text', text: JSON.stringify(await call(args)) }] };
    } catch {
      // Browser/network errors may contain credentials, request bodies or
      // session-bearing URLs. Never return those through MCP or console logs.
      return { isError: true, content: [{ type: 'text', text:
        `${name} failed. Check connection and Claw Patrol configuration. For login, credentials or a verification challenge may need attention. After a cart failure, read the cart before retrying: the change may already have happened. Do not retry writes automatically.` }] };
    }
  });
}
tool('open_shufersal', 'Open Shufersal headlessly and report whether the current session is authenticated.', {}, () => shopping.open());
tool('login_shufersal', 'Log in once using configured Claw Patrol email/password placeholders. No credentials are accepted as tool arguments. Reuse an authenticated session; do not retry failures automatically.', {}, () => shopping.login());
tool('search_shufersal', 'Search Shufersal products and prices. Does not change the cart.', { query: z.string().trim().min(1).max(200) }, ({ query }) => shopping.search(query));
const product = {
  product_code: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/).describe('Exact product code from search or cart'),
  selling_method: z.enum(['BY_UNIT', 'BY_WEIGHT']).describe('Selling method code from search or cart'),
};
const quantity = z.number().positive().max(1000).describe('Units for BY_UNIT, weight quantity for BY_WEIGHT');
tool('get_shufersal_cart', 'Read the current authenticated cart, quantities and displayed total.', {}, () => shopping.cart());
tool('add_to_shufersal_cart', 'Add a product to the draft cart and verify its new quantity. Changes the cart, never checks out. Do not retry automatically.', { ...product, quantity }, args => shopping.changeCart('add', args));
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
