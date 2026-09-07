import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectShortages, previewOrderChanges, replacementCandidates, OrderCareError } from '../order-care.js';

const item = { productCode: 'P_1', sellingMethod: 'BY_UNIT', name: 'Fixture', quantity: 2, stockSignal: 'unknown' };
const order = { orderNumber: 'O_1', active: true, editability: 'unknown', total: { value: 20 }, items: [item] };

test('shortage sources are reconciled without treating differences as stock failures', () => {
  const result = inspectShortages({ ...order, items: [{ ...item, stockSignal: 'out_of_stock' }] }, { cart: { items: [
    { ...item, quantity: 1, outOfStock: true, calculationError: true },
    { ...item, productCode: 'P_2', quantity: 1, outOfStock: true },
  ] } });
  assert.equal(result.complete, false);
  assert.deepEqual(result.issues[0].signals.map(s => [s.source, s.kind]), [
    ['order', 'out_of_stock'], ['editing_cart', 'out_of_stock'], ['editing_cart', 'calculation_error'], ['comparison', 'quantity_changed'],
  ]);
  assert.equal(result.issues[1].productCode, 'P_2');
  assert.equal(result.issues[1].signals[0].kind, 'out_of_stock');
  assert.equal(result.issues[1].signals[1].kind, 'added_to_editing_cart');
});

test('empty or absent cart data cannot certify fulfillment', () => {
  const absent = inspectShortages(order);
  assert.equal(absent.issues.length, 0);
  assert.equal(absent.orderItemsWithoutStockSignal, 1);
  assert.equal(absent.coverage.editingCart, 'not_open_for_this_order');
  assert.equal(absent.coverage.replacementRequest, 'not_supported');
  assert.equal(absent.complete, false);
  const empty = inspectShortages(order, { cart: { items: [] } });
  assert.equal(empty.issues[0].signals[0].kind, 'absent_from_editing_cart');
});

test('preview checks stale quantities, duplicate changes, closed/locked orders, units and unknown methods', () => {
  const change = { product_code: 'P_1', selling_method: 'BY_UNIT', expected_quantity: 2, quantity: 0 };
  const result = previewOrderChanges(order, [change, { ...change, product_code: 'P_2', expected_quantity: 0, quantity: 1 }]);
  assert.equal(result.changes[0].change, 'remove');
  assert.equal(result.changes[1].change, 'add');
  assert.equal(result.applied, false); assert.equal(result.canApply, false); assert.equal(result.revisedTotal, null);
  assert.equal(order.items[0].quantity, 2);
  for (const [o, changes] of [
    [order, [{ ...change, expected_quantity: 1 }]], [order, [change, change]],
    [{ ...order, active: false }, [change]], [{ ...order, editability: 'not_allowed' }, [change]],
    [order, [{ ...change, quantity: 0.5 }]], [order, [{ ...change, quantity: -1 }]],
    [{ ...order, items: [{ ...item, sellingMethod: null }] }, [change]],
  ]) assert.throws(() => previewOrderChanges(o, changes), OrderCareError);
});

test('replacement candidates omit original, unavailable and duplicate products without claiming equivalence', () => {
  const catalog = { products: [
    { code: 'P_1', availability: 'in_stock' }, { code: 'P_2', availability: 'out_of_stock' },
    { code: 'P_3', availability: 'unknown' }, { code: 'P_4', availability: 'in_stock' },
    { code: 'P_4', availability: 'in_stock' },
  ], pagination: { totalResults: 100, hasMore: true } };
  const result = replacementCandidates(order, 'P_1', 'BY_UNIT', catalog);
  assert.deepEqual(result.candidates.map(p => p.code), ['P_4']);
  assert.equal(result.candidates[0].orderDeliveryEligibility, 'unknown');
  assert.equal(result.candidates[0].dietaryMatch, 'unknown');
  assert.equal(result.catalogPagination.totalResults, 100);
  assert.deepEqual(replacementCandidates(order, 'P_1', 'BY_UNIT', catalog, true).candidates.map(p => p.code), ['P_3', 'P_4']);
  assert.throws(() => replacementCandidates(order, 'FOREIGN', 'BY_UNIT', catalog), OrderCareError);
});
