import test from 'node:test';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import { Shufersal, HOME, allowedRequest } from '../shufersal.js';

for (const scenario of ['draft', 'matching', 'foreign', 'cart-failure', 'context-change', 'preview', 'replacements', 'sms-choice', 'sms-preview']) {
  test(`order care without live orders: ${scenario}`, async () => {
    const requests = [];
    let identity = ['matching', 'cart-failure', 'context-change'].includes(scenario) ? { code: 'O_1' } : scenario === 'foreign' ? 'O_2' : null;
    const summary = { code: 'O_1', created: 1, isUpdatable: true };
    const launch = async options => {
      const browser = await puppeteer.launch(options), newPage = browser.newPage.bind(browser);
      browser.newPage = async () => {
        const page = await newPage();
        page.on('request', r => { r.continue = async () => {
          const url = new URL(r.url()); requests.push({ path: url.pathname + url.search, method: r.method() });
          let contentType = 'text/html', status = 200, body;
          if (url.pathname.endsWith('/my-account/orders')) {
            contentType = 'application/json'; body = JSON.stringify({ activeOrders: [summary], closedOrders: [] });
          } else if (url.pathname.endsWith('/my-account/orders/O_1')) {
            contentType = 'application/json'; body = JSON.stringify({ ...summary, entries: [
              { quantity: 2, outOfStock: true, product: { code: 'P_1', name: 'Original', sellingMethod: { code: 'BY_UNIT' } } },
              { quantity: 1, product: { code: 'P_2', name: 'Unreported shortage', sellingMethod: { code: 'BY_UNIT' } } },
            ] });
          } else if (url.pathname.endsWith('/cart/load')) {
            if (scenario === 'cart-failure') status = 500;
            if (scenario === 'context-change') identity = 'OTHER';
            body = '<span id="cartTotalItems">3</span><div class="miglog-prod" data-entry-number="0" data-product-code="P_1" data-entry-qty="2" data-selling-method="BY_UNIT"></div><div class="miglog-prod miglog-cart-prod-notInStock" data-entry-number="1" data-product-code="P_2" data-entry-qty="1" data-selling-method="BY_UNIT"></div>';
          } else if (url.pathname.endsWith('/search/results')) {
            contentType = 'application/json'; body = JSON.stringify({ results: [
              { code: 'P_3', name: 'Alternative', stock: { stockLevelStatus: { code: 'inStock' } } },
            ], pagination: { currentPage: 0, pageSize: 15, totalNumberOfResults: 1, numberOfPages: 1, sort: 'relevance' } });
          } else {
            body = `<script>window.miglog={account:{anonymous:false},cart:{order:${JSON.stringify(identity)}}};fetch('/online/he/cart/load?restoreCart=true').catch(()=>{});</script>`;
          }
          await r.respond({ status, contentType, body });
        }; }); return page;
      }; return browser;
    };
    let smsReads = 0;
    const replacementUrl = 'https://services.shufersal.co.il/cfcalternative/?e=0&t=FIXTURE_ONLY_PRIVATE_TOKEN_123456';
    const s = new Shufersal({ launch, replacementFetch: async (url, options) => {
      smsReads++;
      assert.ok(url.endsWith('/Correlate/GetOrder'));
      assert.equal(options.redirect, 'error');
      return new Response(JSON.stringify({ Error: { ErrorCode: 0 }, Content: {
        Order: [{ OrderNumber: 'O_1', IsExpired: false, IsReadOnly: false }],
        Products: [{ ProductID: 1, CustomerCoordinationRequired: 6 }],
        AlternativeProducts: [{ ProductID: 3, ParentProductId: 1, CorrelateItemStatusCode: 1, RequestedQuantity: 1 }],
      } }), { headers: { 'content-type': 'application/json' } });
    } });
    try {
      const active = await s.orderHistory({ activeOnly: true });
      assert.equal(active.orders[0].active, true);
      if (scenario === 'sms-choice') {
        const result = await s.orderShortages('O_1', replacementUrl);
        assert.equal(result.issues[0].resolution, 'sms_replacement_reported');
        assert.equal(result.issues[0].needsReplacementDecision, null);
        assert.equal(smsReads, 1);
        assert.ok(!JSON.stringify(result).includes('PRIVATE_TOKEN'));
      } else if (scenario === 'preview' || scenario === 'sms-preview') {
        const result = await s.previewOrderEdit({ order_number: 'O_1', replacement_url: scenario === 'sms-preview' ? replacementUrl : undefined, changes: [{ product_code: 'P_1', selling_method: 'BY_UNIT', expected_quantity: 2, quantity: 1 }] });
        assert.equal(result.canApply, false); assert.equal(result.changes[0].quantity, 1);
        assert.equal(result.replacementGuard.canStartEdit, false);
        assert.equal(result.replacementGuard.recordedChoices.length, scenario === 'sms-preview' ? 1 : 0);
        assert.equal(smsReads, scenario === 'sms-preview' ? 1 : 0);
      } else if (scenario === 'replacements') {
        const result = await s.orderReplacements({ order_number: 'O_1', product_code: 'P_1', selling_method: 'BY_UNIT', query: 'alternative' });
        assert.equal(result.candidates[0].code, 'P_3');
        assert.equal(result.applied, false);
      } else {
        const result = await s.orderShortages('O_1');
        assert.equal(result.issues[0].signals[0].source, 'order');
        if (scenario === 'matching') {
          assert.equal(result.issues[1].productCode, 'P_2');
          assert.equal(result.issues[1].signals[0].source, 'editing_cart');
          assert.equal(result.coverage.editingCart, 'read');
        } else {
          assert.equal(result.issues.length, 1);
          assert.equal(result.coverage.editingCart, scenario === 'cart-failure' ? 'read_failed' : scenario === 'context-change' ? 'context_changed' : 'not_open_for_this_order');
        }
      }
      assert.ok(requests.every(r => r.method === 'GET'));
      assert.ok(requests.every(r => !/restoreCart|cartFromOrder|checkout/.test(r.path)));
      if (!['matching', 'cart-failure', 'context-change'].includes(scenario)) assert.ok(requests.every(r => !r.path.includes('/cart/')));
    } finally { await s.close(); }
  });
}

test('native order mutations remain blocked, including the GET that starts editing', () => {
  for (const [path, method] of [['cart/cartFromOrder/O_1', 'GET'], ['my-account/orders/O_1', 'DELETE'], ['checkout', 'GET'], ['my-account/orders/O_1/update/time-slot', 'PUT']]) {
    assert.equal(allowedRequest(HOME + path, method), false);
  }
});
