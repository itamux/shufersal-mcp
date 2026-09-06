// Functions evaluated in Chromium use only their arguments and browser APIs.
export function parseCart(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const nodes = [...doc.querySelectorAll('.miglog-prod[data-entry-number][data-product-code]')];
  const seen = new Set();
  const items = nodes.filter(node => {
    const key = node.getAttribute('data-entry-number');
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).map(node => {
    const quantity = Number(node.getAttribute('data-entry-qty') ?? node.querySelector('[name="qty"]')?.value);
    const entryNumber = Number(node.getAttribute('data-entry-number'));
    const sellingMethod = node.querySelector('[name="sellingMethod"]')?.value || node.getAttribute('data-selling-method');
    if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isInteger(entryNumber) || entryNumber < 0 || !sellingMethod) throw Error('Cart item format changed');
    return {
      productCode: node.getAttribute('data-product-code'), entryNumber, quantity, sellingMethod,
      name: node.getAttribute('data-product-name') || node.querySelector('.miglog-prod-name')?.textContent?.trim() || '',
      price: node.getAttribute('data-product-price') || node.querySelector('.miglog-prod-price')?.textContent?.trim() || null,
    };
  });
  const count = doc.querySelector('#cartTotalItems')?.textContent?.trim();
  if (!items.length && count !== '0') throw Error('Cart format changed or session unavailable');
  return { items, total: doc.querySelector('.discountCartBottom')?.textContent?.trim() || null };
}

export function cartWrite(operation, args, cart) {
  const { product_code: code, selling_method: method, quantity, expected_quantity: expected } = args;
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(code) || !['BY_UNIT', 'BY_WEIGHT'].includes(method)) throw Error('Invalid product or selling method');
  const rows = cart.items.filter(item => item.productCode === code && item.sellingMethod === method);
  if (rows.length > 1) throw Error('Ambiguous cart product');
  const row = rows[0];
  const before = row?.quantity || 0;
  if (operation !== 'add' && (!row || expected !== before)) throw Error('Cart changed; read the cart again');
  const after = operation === 'remove' ? 0 : operation === 'add' ? before + quantity : quantity;
  if (!Number.isFinite(after) || after < 0 || after > 1000 || (method === 'BY_UNIT' && !Number.isInteger(after))) throw Error('Invalid quantity');
  if (operation === 'add') {
    if (!Number.isFinite(quantity) || quantity <= 0) throw Error('Invalid quantity');
    return { path: '/online/he/cart/add', contentType: 'application/json', before, after,
      body: JSON.stringify({ productCodePost: code, productCode: code, sellingMethod: method, qty: quantity, frontQuantity: quantity, comment: '', affiliateCode: '' }) };
  }
  if (operation !== 'remove' && operation !== 'update') throw Error('Invalid cart operation');
  if (operation === 'update' && after <= 0) throw Error('Use remove for zero quantity');
  const query = new URLSearchParams({ entryNumber: String(row.entryNumber), qty: String(after), sellingMethod: method });
  return { path: '/online/he/cart/update?' + query, contentType: 'application/x-www-form-urlencoded; charset=UTF-8',
    body: new URLSearchParams({ quantity: String(after) }).toString(), before, after };
}

export function verifyCart(cart, code, method, expected) {
  const rows = cart.items.filter(item => item.productCode === code && item.sellingMethod === method);
  if (rows.length > 1 || Math.abs((rows[0]?.quantity || 0) - expected) > 0.0001) throw Error('Cart change not confirmed; read the cart before retrying');
  return cart;
}

// Project inside Chromium: account/contact/payment fields never cross MCP.
export async function readOrders({ orderNumber, limit = 20, offset = 0 } = {}) {
  const scalar = value => ['string', 'number', 'boolean'].includes(typeof value) ? value : null;
  const price = value => value && typeof value === 'object' ? { value: scalar(value.value), currency: scalar(value.currencyIso), formatted: scalar(value.formattedValue) } : null;
  const summary = o => ({ orderNumber: o.code, created: scalar(o.created), date: scalar(o.createdString),
    status: scalar(o.customerStatus?.code || o.status?.code), total: price(o.totalPriceWithTax || o.totalPrice),
    totalItems: scalar(o.totalItems), active: o.isActive === true });
  const read = async path => {
    const r = await fetch(path, { headers: { accept: 'application/json', 'x-requested-with': 'XMLHttpRequest' },
      credentials: 'same-origin', redirect: 'error', signal: AbortSignal.timeout(20000) });
    if (!r.ok || !r.headers.get('content-type')?.includes('application/json')) throw Error('Order history unavailable');
    return r.json();
  };
  const data = await read('/online/he/my-account/orders');
  if (!Array.isArray(data.activeOrders) || !Array.isArray(data.closedOrders)) throw Error('Order history format changed');
  const rows = [...data.activeOrders, ...data.closedOrders];
  if (!rows.every(o => typeof o.code === 'string' && typeof o.created === 'number')) throw Error('Order format changed');
  if (!orderNumber) {
    rows.sort((a,b) => b.created - a.created);
    return { orders: rows.slice(offset, offset + limit).map(summary), total: rows.length, offset,
      hasMore: offset + limit < rows.length, historyFrom: scalar(data.from), historyTo: scalar(data.to) };
  }
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(orderNumber) || !rows.some(o => o.code === orderNumber)) throw Error('Order is not in account history');
  const order = await read('/online/he/my-account/orders/' + encodeURIComponent(orderNumber));
  if (order.code !== orderNumber || !Array.isArray(order.entries)) throw Error('Order details unavailable');
  if (!order.entries.every(e => e.product && typeof e.product.code === 'string' && typeof e.quantity === 'number')) throw Error('Order item format changed');
  return { ...summary(order), items: order.entries.map(e => ({
    productCode: e.product.code, name: scalar(e.product.name), quantity: scalar(e.frontQuantity ?? e.quantity),
    sellingMethod: scalar(e.customerSellingMethod?.code || e.product.sellingMethod?.code),
    unitDescription: scalar(e.product.unitDescription), unitPrice: price(e.basePrice), total: price(e.totalPrice),
    outOfStock: e.outOfStock === true,
  })) };
}
