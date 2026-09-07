// Order-care analysis has no network access and never changes a cart or order.
export class OrderCareError extends Error {}

const key = item => JSON.stringify([item.productCode, item.sellingMethod]);

function quantities(items) {
  const rows = new Map();
  for (const item of items) {
    const id = key(item);
    const previous = rows.get(id);
    rows.set(id, { ...item, quantity: (previous?.quantity || 0) + item.quantity });
  }
  return rows;
}

export function inspectShortages(order, { cart = null, cartCoverage = 'not_open_for_this_order' } = {}) {
  const issues = new Map();
  const report = (item, signal) => {
    const id = key(item);
    if (!issues.has(id)) issues.set(id, {
      productCode: item.productCode, sellingMethod: item.sellingMethod, name: item.name,
      signals: [],
    });
    issues.get(id).signals.push(signal);
  };
  for (const item of order.items) {
    if (item.stockSignal === 'out_of_stock') report(item, { source: 'order', kind: 'out_of_stock' });
  }
  if (cart) {
    const ordered = quantities(order.items), current = quantities(cart.items);
    for (const item of cart.items) {
      if (item.outOfStock) report(item, { source: 'editing_cart', kind: 'out_of_stock' });
      if (item.calculationError) report(item, { source: 'editing_cart', kind: 'calculation_error' });
    }
    for (const [id, item] of ordered) {
      const now = current.get(id);
      if (!now || Math.abs(now.quantity - item.quantity) > 0.0001) report(item, {
        source: 'comparison', kind: now ? 'quantity_changed' : 'absent_from_editing_cart',
        orderedQuantity: item.quantity, cartQuantity: now?.quantity ?? 0,
      });
    }
    for (const [id, item] of current) {
      if (!ordered.has(id)) report(item, { source: 'comparison', kind: 'added_to_editing_cart', cartQuantity: item.quantity });
    }
  }
  return {
    orderNumber: order.orderNumber, checkedAt: new Date().toISOString(),
    coverage: { order: 'read', editingCart: cart ? 'read' : cartCoverage, replacementRequest: 'not_supported' },
    complete: false,
    orderItemsWithoutStockSignal: order.items.filter(i => i.stockSignal === 'unknown').length,
    issues: [...issues.values()],
    note: 'Quantity differences may be intentional edits, not shortages. An empty report does not guarantee fulfillment. SMS replacement data is not included.',
  };
}

export function previewOrderChanges(order, changes) {
  if (!order.active) throw new OrderCareError('This order is not active; no edit was started.');
  if (order.editability === 'not_allowed') throw new OrderCareError('The site marks this order as not editable; no edit was started.');
  if (!Array.isArray(changes) || !changes.length || changes.length > 100) throw new OrderCareError('Provide between 1 and 100 quantity changes.');
  const current = quantities(order.items), seen = new Set();
  const diff = changes.map(change => {
    const { product_code: productCode, selling_method: sellingMethod, quantity, expected_quantity: expected } = change;
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(productCode) || !['BY_UNIT', 'BY_WEIGHT'].includes(sellingMethod)
      || !Number.isFinite(quantity) || quantity < 0 || quantity > 1000
      || !Number.isFinite(expected) || expected < 0 || expected > 1000
      || (sellingMethod === 'BY_UNIT' && (!Number.isInteger(quantity) || !Number.isInteger(expected)))) {
      throw new OrderCareError('Invalid product, selling method, or quantity.');
    }
    const id = key({ productCode, sellingMethod });
    if (seen.has(id)) throw new OrderCareError('Each product and selling method may appear only once in an edit preview.');
    seen.add(id);
    const rows = order.items.filter(i => i.productCode === productCode);
    if (rows.some(i => !['BY_UNIT', 'BY_WEIGHT'].includes(i.sellingMethod))) throw new OrderCareError('The order does not identify this product’s selling method.');
    const before = current.get(id)?.quantity ?? 0;
    if (Math.abs(before - expected) > 0.0001) throw new OrderCareError('Order quantities changed; read the order again before previewing edits.');
    return { productCode, sellingMethod, previousQuantity: before, quantity,
      change: before === quantity ? 'unchanged' : quantity === 0 ? 'remove' : before === 0 ? 'add' : 'update' };
  });
  return {
    orderNumber: order.orderNumber, checkedAt: new Date().toISOString(), editability: order.editability,
    changes: diff, currentTotal: order.total, revisedTotal: null,
    applied: false, canApply: false,
    reason: 'Preview only. Starting, saving, and discarding native order edits require verification against an eligible order. Prices, promotions, delivery availability, and deadlines must be checked again before saving.',
  };
}

export function replacementCandidates(order, sourceCode, sellingMethod, catalog, includeUnknown = false) {
  const originals = order.items.filter(i => i.productCode === sourceCode && i.sellingMethod === sellingMethod);
  if (originals.length !== 1) throw new OrderCareError('Select one unambiguous product and selling method from the order.');
  const seen = new Set();
  const candidates = catalog.products.filter(p => {
    if (p.code === sourceCode || seen.has(p.code)) return false;
    seen.add(p.code);
    return p.availability === 'in_stock' || (includeUnknown && p.availability === 'unknown');
  }).map(product => ({ ...product, orderDeliveryEligibility: 'unknown', dietaryMatch: 'unknown' }));
  return {
    orderNumber: order.orderNumber, original: originals[0], candidates,
    catalogPagination: catalog.pagination, facets: catalog.facets, sorts: catalog.sorts,
    applied: false,
    note: 'Candidates come from the full catalog search, not the SMS shortlist. Results cover one page. Catalog stock does not prove availability for this order’s delivery; package and dietary equivalence are not inferred.',
  };
}
