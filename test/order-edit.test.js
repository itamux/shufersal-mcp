import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupOrderEdit, compareOrderCart } from '../order-edit.js';
import { allowedRequest, HOME } from '../shufersal.js';

test('order mutations require an exact one-operation grant', () => {
  const start = { url: HOME + 'cart/cartFromOrder/O_1', method: 'GET', body: '' };
  const discard = { url: HOME + 'cart/remove', method: 'POST', body: '' };
  for (const grant of [start, discard]) {
    assert.equal(allowedRequest(grant.url, grant.method, false, grant.body), false);
    assert.equal(allowedRequest(grant.url, grant.method, false, grant.body, null, null, grant), true);
    for (const [url, method, body] of [[grant.url+'?other=1',grant.method,''],[grant.url,grant.method,'x=1'],[grant.url,'DELETE',''],[HOME+'checkout','GET',''],[HOME+'cart/cartFromOrder/OTHER','GET','']]) {
      assert.equal(allowedRequest(url, method, false, body, null, null, grant), false);
    }
  }
});

test('backup fails before opening an edit when storage is not private', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'edit-backup-test-'));
  try {
    await chmod(directory, 0o755);
    await assert.rejects(backupOrderEdit({ SHUFERSAL_BACKUP_DIR: directory }, {}), /private/);
  } finally { await rm(directory, { recursive: true }); }
});

test('comparison preserves service differences and does not confuse method differences with lost quantities', () => {
  const result = compareOrderCart({ items: [{ productCode: 'P_1', sellingMethod: 'BY_PACKAGE', quantity: 1 }, { productCode: 'SERVICE', quantity: 1 }] },
    { items: [{ productCode: 'P_1', sellingMethod: 'BY_UNIT', quantity: 1 }] });
  assert.deepEqual(result.differences, [{ productCode: 'SERVICE', orderedQuantity: 1, cartQuantity: 0 }]);
});
