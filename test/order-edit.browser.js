import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer';
import { Shufersal } from '../shufersal.js';

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'order-edit-test-'));
  const state = { identity: null, rows: options.draft ? [['P_DRAFT', 1, 'BY_UNIT']] : [], anonymous: false, ...options };
  const requests = [];
  const summary = { code: 'O_1', created: 1, isUpdatable: options.editable ?? true, totalPrice: { value: 20, currencyIso: 'ILS' } };
  const details = () => ({ ...summary, entries: [{ quantity: 2, outOfStock: false, product: { code: 'P_1', name: 'Original', sellingMethod: { code: 'BY_UNIT' } } },
    { quantity: 1, product: { code: 'P_PACKAGE', name: 'Package', sellingMethod: { code: 'BY_PACKAGE' } } }] });
  const cart = () => `<span id="cartTotalItems">${state.rows.length}</span>` + state.rows.map(([code, qty, method], i) => `<article class="miglog-prod ${state.stockError ? 'miglog-cart-prod-notInStock' : ''}" data-entry-number="${i}" data-product-code="${code}" data-entry-qty="${qty}"><input data-miglog-sellingmethod="${method}"></article>`).join('');
  let launches = 0;
  const launch = async options => {
    launches++;
    const browser = await puppeteer.launch(options), newPage = browser.newPage.bind(browser);
    browser.newPage = async () => {
      const page = await newPage();
      page.on('request', r => { r.continue = async () => {
        const u = new URL(r.url());
        const path = u.pathname, method = r.method();
        requests.push({ path: path + u.search, method, body: r.postData() });
        let body, contentType = 'text/html', status = 200;
        if (path.endsWith('/my-account/orders')) {
          contentType = 'application/json'; body = JSON.stringify({ activeOrders: [summary], closedOrders: [] });
        } else if (path.endsWith('/my-account/orders/O_1')) {
          contentType = 'application/json'; body = JSON.stringify(details());
        } else if (path.endsWith('/cart/cartFromOrder/O_1')) {
          // Durable backup must already exist when the state-changing GET arrives.
          assert.ok(s.orderEdit?.backup.path);
          assert.equal(JSON.parse(await readFile(s.orderEdit.backup.path)).order.orderNumber, 'O_1');
          state.identity = 'O_1'; state.rows = [['P_1', 2, 'BY_UNIT'], ['P_PACKAGE', 1, 'BY_PACKAGE']];
          if (state.startFailure) status = 500;
          body = 'true'; contentType = 'application/json';
        } else if (path.endsWith('/cart/remove')) {
          if (!state.discardNoEffect) { state.identity = null; state.rows = []; }
          contentType = 'application/json'; body = '{"error":[]}';
          if (state.discardFailure) status = 500;
        } else if (path.endsWith('/cart/update')) {
          const entry = Number(u.searchParams.get('entryNumber')), quantity = Number(u.searchParams.get('qty'));
          state.rows[entry][1] = quantity;
          state.rows = state.rows.filter(r => r[1] > 0);
          if (state.otherChange) state.rows.push(['P_OTHER', 1, 'BY_UNIT']);
          if (state.writeFailure) status = 500;
          body = cart();
        } else if (path.endsWith('/cart/add')) {
          const data = JSON.parse(r.postData()); state.rows.push([data.productCode, data.qty, data.sellingMethod]); body = cart();
        } else if (path.endsWith('/cart/load')) {
          body = cart();
          if (state.changeOnCartRead) { state.identity = 'FOREIGN'; state.changeOnCartRead = false; }
        } else {
          body = `<script>window.ACC={config:{CSRFToken:'FIXTURE_CSRF'}};window.miglog={account:{anonymous:${state.anonymous}},cart:{order:${JSON.stringify(state.identity)}}};fetch('/online/he/cart/load?restoreCart=true').catch(()=>{});</script>`;
        }
        await r.respond({ contentType, status, body });
      }; });
      return page;
    }; return browser;
  };
  const s = new Shufersal({ launch, env: { SHUFERSAL_BACKUP_DIR: directory }, replacementFetch: async () => { throw Error('fixture unavailable'); } });
  t.after(async () => { await s.close(); await rm(directory, { recursive: true, force: true }); });
  const start = () => s.startOrderEdit({ order_number: 'O_1', acknowledge_repricing_and_sms_reset: true });
  return { s, start, state, requests, launches: () => launches };
}

test('owned edit: durable backup, same session, absolute unit/package changes, stale protection and safe discard', async t => {
  const { s, start, state, requests } = await fixture(t);
  let result = await start();
  assert.equal(result.state, 'editing'); assert.equal(result.canSave, false);
  assert.equal((await stat(result.backup.path)).mode & 0o777, 0o600);
  const backup = JSON.parse(await readFile(result.backup.path));
  assert.equal(backup.cart.items.length, 0); assert.equal(backup.order.items[0].quantity, 2);
  assert.ok(!JSON.stringify(backup).includes('FIXTURE_CSRF'));
  const id = result.editId, startIndex = requests.length;
  await assert.rejects(start, /already exists/);
  await assert.rejects(s.changeCart('add', { product_code: 'P_1', selling_method: 'BY_UNIT', quantity: 1 }), /order edit tool/);
  await s.cart(); await s.orderDetails('O_1'); await s.login(); await s.open();
  assert.ok(!requests.slice(startIndex).some(r => /restoreCart|login|j_spring/.test(r.path)));
  const stale = result.cartRevision;
  const change = async (code, method, from, to) => {
    result = await s.changeOrderEdit({ edit_id: id, cart_revision: result.cartRevision, product_code: code, selling_method: method, expected_quantity: from, quantity: to });
    assert.equal(result.verified, true); assert.equal(result.submitted, false);
  };
  await change('P_1', 'BY_UNIT', 2, 3);
  await assert.rejects(s.changeOrderEdit({ edit_id: id, cart_revision: stale, product_code: 'P_1', selling_method: 'BY_UNIT', expected_quantity: 2, quantity: 4 }), /cart changed/);
  await change('P_PACKAGE', 'BY_PACKAGE', 1, 2);
  await change('P_NEW', 'BY_UNIT', 0, 1);
  await change('P_NEW', 'BY_UNIT', 1, 0);
  const count = requests.filter(r => r.method === 'POST').length;
  await s.changeOrderEdit({ edit_id: id, cart_revision: result.cartRevision, product_code: 'P_1', selling_method: 'BY_UNIT', expected_quantity: 3, quantity: 3 });
  assert.equal(requests.filter(r => r.method === 'POST').length, count);
  result = await s.getOrderEdit(id);
  const ended = await s.discardOrderEdit({ edit_id: id, cart_revision: result.cartRevision, confirm_discard: true });
  assert.equal(ended.orderUnchanged, true); assert.equal(ended.state, 'discarded'); assert.equal(state.identity, null);
  assert.equal(JSON.parse(await readFile(ended.backup.path)).order.items[0].quantity, 2);
  assert.ok(!requests.some(r => /checkout/.test(r.path) || r.method === 'DELETE'));
});

for (const [scenario, options] of Object.entries({ draft: { draft: true }, ineligible: { editable: false }, foreign: { identity: 'OTHER' } })) {
  test(`start refuses ${scenario} without mutation`, async t => {
    const { start, requests } = await fixture(t, options);
    await assert.rejects(start);
    assert.ok(!requests.some(r => /cartFromOrder/.test(r.path) || r.method === 'POST'));
  });
}

for (const scenario of ['logout', 'context-change', 'disconnect', 'write-failure', 'stock-error', 'other-change']) {
  test(`edit fails closed: ${scenario}`, async t => {
    const { s, start, state, requests, launches } = await fixture(t);
    const result = await start(), boundary = requests.length;
    if (scenario === 'logout') state.anonymous = true;
    if (scenario === 'context-change') state.changeOnCartRead = true;
    if (scenario === 'disconnect') await s.browser.close();
    if (scenario === 'write-failure') state.writeFailure = true;
    if (scenario === 'stock-error') state.stockError = true;
    if (scenario === 'other-change') state.otherChange = true;
    const args = { edit_id: result.editId, cart_revision: result.cartRevision, product_code: 'P_1', selling_method: 'BY_UNIT', expected_quantity: 2, quantity: 3 };
    await assert.rejects(s.changeOrderEdit(args));
    if (scenario === 'write-failure' || scenario === 'other-change') await assert.rejects(s.changeOrderEdit(args), /uncertain/);
    const read = await s.getOrderEdit(result.editId);
    assert.ok(read.backup.path);
    assert.equal(launches(), 1);
    assert.ok(!requests.slice(boundary).some(r => /restoreCart|j_spring|cartFromOrder/.test(r.path)));
    if (['logout', 'context-change', 'disconnect'].includes(scenario)) {
      await assert.rejects(s.login());
      await assert.rejects(s.cart());
      await assert.rejects(s.refreshSession(), /expired/);
      assert.equal(read.state, 'context_unavailable');
      assert.ok(!requests.slice(boundary).some(r => r.method === 'POST'));
    }
  });
}

test('ambiguous start is not replayed; fresh matching context permits inspection', async t => {
  const { s, start, requests } = await fixture(t, { startFailure: true });
  const result = await start(); assert.equal(result.state, 'start_uncertain');
  await assert.rejects(start, /already exists/);
  assert.equal((await s.getOrderEdit(result.editId)).state, 'editing');
  assert.equal(requests.filter(r => /cartFromOrder/.test(r.path)).length, 1);
});

test('SMS read failure or missing approval prevents starting', async t => {
  const { s, requests } = await fixture(t);
  await assert.rejects(s.startOrderEdit({ order_number: 'O_1' }), /approval/);
  await assert.rejects(s.startOrderEdit({ order_number: 'O_1', acknowledge_repricing_and_sms_reset: true,
    replacement_url: 'https://services.shufersal.co.il/cfcalternative/?e=0&t=FIXTURE_ONLY_PRIVATE_TOKEN_123456' }), /SMS/);
  assert.ok(!requests.some(r => /cartFromOrder/.test(r.path)));
});

test('uncertain discard reconciles through a read without another removal', async t => {
  const { s, start, requests } = await fixture(t, { discardFailure: true });
  const result = await start();
  await assert.rejects(s.discardOrderEdit({ edit_id: result.editId, cart_revision: result.cartRevision, confirm_discard: true }), /could not be verified/);
  const checked = await s.getOrderEdit(result.editId);
  assert.equal(checked.state, 'no_edit_observed'); assert.equal(checked.orderUnchanged, true);
  assert.equal(requests.filter(r => r.path.endsWith('/cart/remove')).length, 1);
  assert.equal(s.orderEdit.phase, 'discard_uncertain');
  await assert.rejects(start, /already exists/);
});

test('nonprivate backup path prevents the state-changing start', async t => {
  const { s, start, requests } = await fixture(t);
  const { chmod } = await import('node:fs/promises');
  await chmod(s.env.SHUFERSAL_BACKUP_DIR, 0o755);
  await assert.rejects(start, /private/);
  assert.ok(!requests.some(r => /cartFromOrder/.test(r.path)));
});


test('pending discard never unlocks item changes even when the old basket is still visible', async t => {
  const { s, start, requests } = await fixture(t, { discardFailure: true, discardNoEffect: true });
  const result = await start();
  await assert.rejects(s.discardOrderEdit({ edit_id: result.editId, cart_revision: result.cartRevision, confirm_discard: true }));
  const read = await s.getOrderEdit(result.editId);
  assert.equal(read.state, 'discard_uncertain'); assert.equal(read.canChange, false);
  const count = requests.length;
  await assert.rejects(s.changeOrderEdit({ edit_id: result.editId, cart_revision: read.cartRevision, product_code: 'P_1', selling_method: 'BY_UNIT', expected_quantity: 2, quantity: 3 }), /uncertain/);
  assert.equal(requests.length, count);
});
