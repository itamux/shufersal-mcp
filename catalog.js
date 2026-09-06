// Browser-evaluated catalog reads. No arbitrary URLs or account fields returned.
export async function readCategories({ parent_code } = {}) {
  const codePattern = /^[A-Za-z0-9_-]{1,80}$/;
  if (!parent_code) {
    const seen = new Set();
    const categories = [...document.querySelectorAll('li.firstLevel[data-category]')].flatMap(node => {
      const code = node.getAttribute('data-category');
      const link = node.querySelector('a.category-title');
      if (!codePattern.test(code || '') || seen.has(code) || !link) return [];
      seen.add(code);
      return [{ code, name: link.textContent.trim(), url: 'https://www.shufersal.co.il/online/he/c/' + code }];
    });
    if (!categories.length) throw Error('Category navigation unavailable');
    return { parentCode: null, categories };
  }
  if (!codePattern.test(parent_code)) throw Error('Invalid category code');
  const r = await fetch('/online/he/categoryfeatures/subcategories/' + encodeURIComponent(parent_code), {
    headers: { accept: 'application/json' }, credentials: 'same-origin', redirect: 'error', signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw Error('Category navigation unavailable');
  const data = await r.json();
  if (!Array.isArray(data) || !data.every(c => codePattern.test(c.code) && c.name && typeof c.name.iw === 'string')) throw Error('Category format changed');
  return { parentCode: parent_code, categories: data.map(c => ({
    code: c.code, name: c.name.iw, englishName: typeof c.name.en === 'string' ? c.name.en : null,
    url: 'https://www.shufersal.co.il/online/he/c/' + c.code,
  })) };
}

export function catalogQuery({ query = '', category_code, brand_codes = [], filters = [], sort = 'relevance', page = 0, page_size = 15, food_only = false } = {}) {
  const code = /^[A-Za-z0-9_-]{1,80}$/;
  const sorts = ['relevance', 'pricePerUnit-asc', 'pricePerUnit-desc', 'name-asc', 'name-desc', 'popularity', 'topRated'];
  if (typeof query !== 'string' || query.length > 200 || /[:\x00-\x1f]/.test(query) || !sorts.includes(sort) ||
    !Number.isInteger(page) || page < 0 || page > 1000 || !Number.isInteger(page_size) || page_size < 1 || page_size > 50 ||
    (category_code && !code.test(category_code)) || brand_codes.length > 10 || filters.length > 12) throw Error('Invalid catalog parameters');
  const refinements = [...brand_codes.map(value => ({ code: 'brand', value })), ...filters];
  if (!refinements.every(f => code.test(f.code) && typeof f.value === 'string' && f.value.length > 0 && f.value.length <= 200 && !/[:\x00-\x1f]/.test(f.value))) throw Error('Invalid filter code or value');
  const parts = [query.trim(), sort];
  if (category_code) parts.push('allCategories', category_code);
  for (const f of refinements) parts.push(f.code, f.value);
  return { q: parts.join(':'), page, limit: page_size, food: food_only, refinements,
    metadataPath: category_code ? '/online/he/c/' + category_code : '/online/he/search' };
}

export async function readCatalog(request) {
  const imageUrl = values => values.find(v => typeof v === 'string'
    && /^https:\/\/(?:res\.cloudinary\.com\/shufersal\/image\/upload\/|media\.shufersal\.co\.il\/product_images\/)[^\s?#]+$/.test(v) && !v.includes('/default/')) || null;
  const { q, page, limit, food, refinements, metadataPath } = request;
  const baseQuery = q.split(':').slice(0, 2).join(':');
  const params = new URLSearchParams({ q, page: String(page), limit: String(limit) });
  if (food) params.set('food', 'true');
  // Facet options in the full catalog are richer than autocomplete JSON.
  const meta = await fetch(metadataPath + '?' + new URLSearchParams({ q: baseQuery }), {
    credentials: 'same-origin', redirect: 'follow', signal: AbortSignal.timeout(20000),
  });
  if (new URL(meta.url).origin !== location.origin || !meta.ok) throw Error('Catalog filters unavailable');
  const doc = new DOMParser().parseFromString(await meta.text(), 'text/html');
  const facets = new Map();
  for (const input of doc.querySelectorAll('input[data-facet]')) {
    const [empty, code, value, extra] = input.getAttribute('data-facet').split(':');
    if (empty !== '' || !code || !value || extra !== undefined) continue;
    if (!facets.has(code)) facets.set(code, { code, values: [] });
    const f = facets.get(code);
    if (!f.values.some(v => v.code === value)) f.values.push({ code: value,
      name: input.closest('label')?.textContent.replace(/\s+/g, ' ').trim() || value,
      selected: refinements.some(r => r.code === code && r.value === value) });
  }
  for (const f of refinements) {
    if (!facets.get(f.code)?.values.some(v => v.code === f.value)) throw Error('Filter unavailable for this query/category; use returned facet options');
  }
  const response = await fetch('/online/he/search/results?' + params, {
    headers: { accept: 'application/json', 'x-requested-with': 'XMLHttpRequest' },
    credentials: 'same-origin', redirect: 'error', signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw Error('Product search unavailable');
  const data = await response.json();
  const p = data.pagination;
  if (!Array.isArray(data.results) || !p || !Number.isInteger(p.currentPage) || !Number.isInteger(p.totalNumberOfResults)) throw Error('Product search format changed');
  if (p.currentPage !== page || p.pageSize !== limit || p.sort !== q.split(':')[1]) throw Error('Requested paging or sort was not honored');
  return { products: data.results.slice(0, limit).map(item => ({
    code: item.code, name: item.name,
    imageUrl: imageUrl([item.baseProductImageMedium, ...(Array.isArray(item.images) ? item.images.filter(i => i.format === 'product').map(i => i.url) : []), item.baseProductImageLarge, item.baseProductImageSmall]),
    price: item.price, pricePerUnit: item.pricePerUnit,
    sellingMethod: item.sellingMethod, unitDescription: item.unitDescription, brandName: item.brandName,
    promotionCode: item.mainPromotionCode || null, promotionDescription: item.promotionCharacteristicDescription || null,
  })), pagination: { page: p.currentPage, pageSize: p.pageSize, totalPages: p.numberOfPages,
    totalResults: p.totalNumberOfResults, hasMore: p.currentPage + 1 < p.numberOfPages, sort: p.sort },
    facets: [...facets.values()],
    sorts: [...new Set([...doc.querySelectorAll('input[name="sorting"]')].map(i => i.value))],
  };
}

export async function readCoupons({ limit = 20, offset = 0, activated, expiring_only = false } = {}) {
  const r = await fetch('/online/he/my-account/coupons/my-coupons', {
    headers: { accept: 'application/json' }, credentials: 'same-origin', redirect: 'error', signal: AbortSignal.timeout(20000),
  });
  if (!r.ok || !r.headers.get('content-type')?.includes('application/json')) throw Error('Personal coupons unavailable');
  const data = await r.json();
  if (!Array.isArray(data.myCoupons)) throw Error('Coupon format changed');
  const now = Date.now();
  const available = data.myCoupons.filter(c => !c.prePaid && !c.prePaidCard && typeof c.expiryDate === 'number' && c.expiryDate >= now);
  const rows = available.filter(c => (activated === undefined || c.activated === activated) && (!expiring_only || c.aboutToExpire));
  return { coupons: rows.slice(offset, offset + limit).map(c => {
    if (typeof c.display !== 'string') throw Error('Coupon display unavailable');
    const doc = new DOMParser().parseFromString(c.display, 'text/html');
    const text = selector => doc.querySelector(selector)?.textContent.replace(/\s+/g, ' ').trim() || null;
    return { promotionCode: typeof c.promotionCode === 'string' ? c.promotionCode : null,
      title: text('.textContainer .title'), offer: text('.textContainer'),
      expiresAt: new Date(c.expiryDate).toISOString(), activated: c.activated === true,
      aboutToExpire: c.aboutToExpire === true, productInCart: c.productInCart === true,
      usage: typeof c.usage === 'number' ? c.usage : null };
  }), total: rows.length, availableTotal: available.length, offset, hasMore: offset + limit < rows.length };
}

export async function readSales({ category_code = 'A', page = 0 } = {}) {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(category_code) || !Number.isInteger(page) || page < 0 || page > 1000) throw Error('Invalid sale parameters');
  const r = await fetch('/online/he/c/' + category_code + '/promotion/fragment?' + new URLSearchParams({ q: ':relevance', page: String(page) }), {
    credentials: 'same-origin', redirect: 'error', signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw Error('Sales unavailable');
  const doc = new DOMParser().parseFromString(await r.text(), 'text/html');
  const meta = doc.querySelector('[data-pages][data-page][data-results]');
  if (!meta || Number(meta.dataset.page) !== page) throw Error('Sale pagination unavailable or ignored');
  const seen = new Set();
  const offers = [...doc.querySelectorAll('[data-promo]')].flatMap(n => {
    const promotionCode = n.getAttribute('data-promo');
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(promotionCode || '') || seen.has(promotionCode)) return [];
    seen.add(promotionCode);
    const text = selector => n.querySelector(selector)?.textContent.replace(/\s+/g, ' ').trim() || null;
    return [{ promotionCode, title: text('.textContainer .title'), description: text('.textContainer .description'), offer: text('.textContainer') }];
  });
  const totalResults = Number(meta.dataset.results), totalPages = Number(meta.dataset.pages);
  if (!Number.isInteger(totalResults) || !Number.isInteger(totalPages) || (totalResults > 0 && !offers.length)) throw Error('Sale format changed');
  return { offers, pagination: { page, totalResults, totalPages, hasMore: page + 1 < totalPages } };
}

export async function readPromotionProducts({ promotion_code } = {}) {
  const imageUrl = values => values.find(v => typeof v === 'string'
    && /^https:\/\/(?:res\.cloudinary\.com\/shufersal\/image\/upload\/|media\.shufersal\.co\.il\/product_images\/)[^\s?#]+$/.test(v) && !v.includes('/default/')) || null;
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(promotion_code || '')) throw Error('Invalid promotion code');
  const r = await fetch('/online/he/promotionPopup/' + promotion_code, {
    credentials: 'same-origin', redirect: 'error', signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw Error('Promotion products unavailable');
  const doc = new DOMParser().parseFromString(await r.text(), 'text/html');
  const seen = new Set();
  const products = [...doc.querySelectorAll('[data-product-row][data-product-code]')].flatMap(n => {
    const code = n.getAttribute('data-product-code');
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(code || '') || seen.has(code)) return [];
    seen.add(code);
    const text = selector => n.querySelector(selector)?.textContent.replace(/\s+/g, ' ').trim() || null;
    return [{ code,
      imageUrl: imageUrl([...n.querySelectorAll('.imgContainer img')].flatMap(i => [i.getAttribute('data-src'), i.getAttribute('src')])),
      name: text('.product .description'), package: text('.product .brand-name'),
      sellingMethod: n.getAttribute('data-selling-method'), regularPrice: text('[data-price-per-unit]'),
      unitPrice: text('.pricePerUnit .small') }];
  });
  if (!products.length) throw Error('Promotion has no readable eligible products');
  return { promotionCode: promotion_code, products, priceNote: 'Regular prices; offer conditions and quantities determine the discount. Product availability must be checked when adding to cart.' };
}
