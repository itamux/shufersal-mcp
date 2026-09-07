import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('stdio discovery works and missing login configuration fails without leaking values', async () => {
  const transport = new StdioClientTransport({ command: process.execPath, args: ['server.js'], env: { PATH: process.env.PATH } });
  const client = new Client({ name: 'protocol-test', version: '1' });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(t => t.name).sort(), ['get_shufersal_replacement_request', 'get_shufersal_active_orders', 'get_shufersal_order_shortages', 'preview_shufersal_order_edit', 'find_shufersal_order_replacements', 'activate_shufersal_coupon', 'browse_shufersal_category', 'get_shufersal_categories', 'get_shufersal_sales', 'get_shufersal_promotion_products', 'get_shufersal_personal_coupons', 'add_to_shufersal_cart', 'get_shufersal_cart', 'get_shufersal_order', 'get_shufersal_order_history', 'login_shufersal', 'open_shufersal', 'remove_from_shufersal_cart', 'search_shufersal', 'update_shufersal_cart_item'].sort());
    assert.deepEqual(tools.find(t => t.name === 'login_shufersal').inputSchema.properties, {});
    const invalidSms = await client.callTool({ name: 'get_shufersal_replacement_request', arguments: { replacement_url: 'https://evil.invalid/FIXTURE_SECRET_TOKEN' } });
    assert.equal(invalidSms.isError, true);
    assert.doesNotMatch(invalidSms.content[0].text, /FIXTURE_SECRET_TOKEN/);
    const result = await client.callTool({ name: 'login_shufersal', arguments: {} });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /configuration|Login refresh failed/);
  } finally { await client.close(); }
});
