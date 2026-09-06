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
    assert.deepEqual(tools.map(t => t.name).sort(), ['add_to_shufersal_cart', 'get_shufersal_cart', 'get_shufersal_order', 'get_shufersal_order_history', 'login_shufersal', 'open_shufersal', 'remove_from_shufersal_cart', 'search_shufersal', 'update_shufersal_cart_item']);
    assert.deepEqual(tools.find(t => t.name === 'login_shufersal').inputSchema.properties, {});
    const result = await client.callTool({ name: 'login_shufersal', arguments: {} });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Claw Patrol/);
  } finally { await client.close(); }
});
