// Functions evaluated in Chromium use only their arguments and browser APIs.
export function parseCart(html) {
  const imageUrl = values => values.find(v => typeof v === 'string'
    && /^https:\/\/(?:res\.cloudinary\.com\/shufersal\/image\/upload\/|media\.shufersal\.co\.il\/product_images\/)[^\s?#]+$/.test(v) && !v.includes('/default/')) || null;
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
    const lineTotal = node.querySelector('.miglog-prod-totalPrize')?.textContent?.trim() || null;
    return {
      productCode: node.getAttribute('data-product-code'),
      imageUrl: imageUrl([...node.querySelectorAll('.imgContainer img')].flatMap(i => [i.getAttribute('data-src'), i.getAttribute('src')])),
      entryNumber, quantity, sellingMethod,
      outOfStock: node.classList.contains('miglog-cart-prod-notInStock'),
      calculationError: node.classList.contains('errorCalc'),
      name: node.getAttribute('data-product-name') || node.querySelector('.miglog-prod-name')?.textContent?.trim() || '',
      price: lineTotal, lineTotal,
    };
  });
  const count = doc.querySelector('#cartTotalItems')?.textContent?.trim();
  if (!items.length && count !== '0') throw Error('Cart format changed or session unavailable');
  return { items, itemCount: count !== undefined && /^\d+$/.test(count) ? Number(count) : null,
    total: doc.querySelector('.miglog-cart-summary-totalprice')?.textContent?.trim() || null,
    savings: doc.querySelector('.discountCartBottom')?.textContent?.trim() || null };
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
  if (expected > 0) {
    if (rows[0]?.outOfStock) throw Error('Cart change not confirmed: product is out of stock; do not retry adding it');
    if (rows[0]?.calculationError) throw Error('Cart change not confirmed: Shufersal reports a calculation error; read the cart before retrying');
    if (cart.itemCount === 0) throw Error('Cart change not confirmed: Shufersal reports an empty cart despite a saved row; do not retry adding it');
  }
  return cart;
}

// Project inside Chromium: account/contact/payment fields never cross MCP.
export async function readOrders({ orderNumber, limit = 20, offset = 0, activeOnly = false } = {}) {
  const imageUrl = values => values.find(v => typeof v === 'string'
    && /^https:\/\/(?:res\.cloudinary\.com\/shufersal\/image\/upload\/|media\.shufersal\.co\.il\/product_images\/)[^\s?#]+$/.test(v) && !v.includes('/default/')) || null;
  const scalar = value => ['string', 'number', 'boolean'].includes(typeof value) ? value : null;
  const price = value => value && typeof value === 'object' ? { value: scalar(value.value), currency: scalar(value.currencyIso), formatted: scalar(value.formattedValue) } : null;
  const summary = o => ({ orderNumber: o.code, created: scalar(o.created), date: scalar(o.createdString),
    status: scalar(o.customerStatus?.code || o.status?.code), total: price(o.totalPriceWithTax || o.totalPrice),
    totalItems: scalar(o.totalItems), active: activeCodes.has(o.code),
    // Expose the site flag without inferring permission from a status name.
    editability: o.isUpdatable === true ? 'allowed' : o.isUpdatable === false ? 'not_allowed' : 'unknown',
    editDeadline: null,
    deliveryWindows: (Array.isArray(o.consignments) ? o.consignments : []).map(c => ({
      start: scalar(c.timeSlotStartTimeString), end: scalar(c.timeSlotEndTimeString),
    })).filter(w => w.start !== null || w.end !== null),
  });
  const read = async path => {
    const r = await fetch(path, { headers: { accept: 'application/json', 'x-requested-with': 'XMLHttpRequest' },
      credentials: 'same-origin', redirect: 'error', signal: AbortSignal.timeout(20000) });
    if (!r.ok || !r.headers.get('content-type')?.includes('application/json')) throw Error('Order history unavailable');
    return r.json();
  };
  const data = await read('/online/he/my-account/orders');
  if (!Array.isArray(data.activeOrders) || !Array.isArray(data.closedOrders)) throw Error('Order history format changed');
  const activeCodes = new Set(data.activeOrders.map(o => o.code));
  const rows = [...data.activeOrders, ...data.closedOrders];
  if (new Set(rows.map(o => o.code)).size !== rows.length) throw Error('Ambiguous order history');
  if (!rows.every(o => typeof o.code === 'string' && typeof o.created === 'number')) throw Error('Order format changed');
  if (!orderNumber) {
    const selected = (activeOnly ? rows.filter(o => activeCodes.has(o.code)) : rows).sort((a,b) => b.created - a.created);
    return { orders: selected.slice(offset, offset + limit).map(summary), total: selected.length, offset,
      hasMore: offset + limit < selected.length, historyFrom: scalar(data.from), historyTo: scalar(data.to) };
  }
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(orderNumber) || !rows.some(o => o.code === orderNumber)) throw Error('Order is not in account history');
  const order = await read('/online/he/my-account/orders/' + encodeURIComponent(orderNumber));
  if (order.code !== orderNumber || !Array.isArray(order.entries)) throw Error('Order details unavailable');
  if (!order.entries.every(e => e.product && typeof e.product.code === 'string' && Number.isFinite(e.quantity) && e.quantity >= 0 && (e.frontQuantity == null || (Number.isFinite(e.frontQuantity) && e.frontQuantity >= 0)))) throw Error('Order item format changed');
  return { ...summary(order), items: order.entries.map(e => ({
    productCode: e.product.code,
    imageUrl: imageUrl([e.product.baseProductImageMedium, ...(Array.isArray(e.product.images) ? e.product.images.filter(i => i.format === 'product').map(i => i.url) : []), e.product.baseProductImageLarge, e.product.baseProductImageSmall]),
    name: scalar(e.product.name), quantity: scalar(e.frontQuantity ?? e.quantity),
    sellingMethod: scalar(e.customerSellingMethod?.code || e.product.sellingMethod?.code),
    unitDescription: scalar(e.product.unitDescription), unitPrice: price(e.basePrice), total: price(e.totalPrice),
    outOfStock: e.outOfStock === true,
    stockSignal: e.outOfStock === true ? 'out_of_stock' : e.outOfStock === false ? 'not_marked_unavailable' : 'unknown',
  })) };
}
