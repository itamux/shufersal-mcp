import puppeteer from 'puppeteer';
import { prepareCoupon, activateCouponAndVerify } from './coupons.js';
import { catalogQuery, readCatalog, readCategories, readCoupons, readSales, readPromotionProducts } from './catalog.js';
import { parseCart, cartWrite, verifyCart, readOrders } from './shopping.js';
import { inspectShortages, previewOrderChanges, replacementCandidates, OrderCareError } from './order-care.js';
import { replacementLink, readReplacementRequest, recordReplacementSnapshot, reconcileReplacementViews, replacementEditGuard } from './replacement-request.js';

export const ORIGIN = 'https://www.shufersal.co.il';
export const HOME = `${ORIGIN}/online/he/`;
export const LOGIN = `${ORIGIN}/online/he/login`;
export const LOGIN_POST = `${ORIGIN}/online/he/j_spring_security_check`;
export const COUPON_POST = `${ORIGIN}/online/he/my-account/coupons/activate-coupon`;

export function loginCredentials(env) {
  const email = env.SHUFERSAL_EMAIL;
  const password = env.SHUFERSAL_PASSWORD;
  if (typeof email !== 'string' || !email.trim() || typeof password !== 'string' || !password) {
    throw new Error('Set SHUFERSAL_EMAIL and SHUFERSAL_PASSWORD.');
  }
  return { email, password };
}

export function allowedRequest(url, method, loginPending, body = '', cartPending = null, couponPending = null) {
  const target = new URL(url);
  if (target.origin !== ORIGIN || target.username || target.password) return false;
  if (method === 'GET' || method === 'HEAD') {
    return !/logout|checkout/i.test(target.pathname)
      && (!target.pathname.includes('/cart/') || (target.pathname === '/online/he/cart/load' && (!target.search || (method === 'GET' && target.search === '?restoreCart=true'))));
  }
  if (method === 'POST' && couponPending && url === COUPON_POST && body === couponPending.body) return true;
  if (method === 'POST' && cartPending && url === cartPending.url && body === cartPending.body
    && ['/online/he/cart/add', '/online/he/cart/update'].includes(target.pathname)) return true;
  if (method !== 'POST' || url !== LOGIN_POST || !loginPending) return false;
  const form = new URLSearchParams(body);
  return form.getAll('j_username').length === 1 && form.get('j_username') === loginPending.email
    && form.getAll('j_password').length === 1 && form.get('j_password') === loginPending.password;
}

export class AuthenticationError extends Error {
  constructor() {
    super('Login refresh failed. Check the configured credentials or complete any Shufersal verification challenge. No cart or coupon change was attempted.');
    this.name = 'AuthenticationError';
  }
}

export class Shufersal {
  constructor({ env = process.env, launch = puppeteer.launch.bind(puppeteer), replacementFetch = fetch } = {}) {
    this.env = env;
    this.replacementFetch = replacementFetch;
    this.replacementSnapshots = new Map();
    this.launch = launch;
    this.pending = Promise.resolve();
    this.loginPending = false;
  }

  // One browser context per MCP process; never overlap navigation and search.
  run(operation) {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => {});
    return result;
  }

  async page() {
    if (!this.browser?.connected) {
      // Ephemeral browser profile: no saved passwords or durable session files.
      this.browser = await this.launch({ headless: true });
      this.tab = await this.browser.newPage();
      this.tab.setDefaultNavigationTimeout(30000);
      await this.tab.setRequestInterception(true);
      this.tab.on('request', request => {
        const url = request.url();
        const method = request.method();
        const headers = { ...request.headers() };
        delete headers.authorization;
        if ((url === `${HOME}cart/load?restoreCart=true` && !this.restoringCart)
          || !allowedRequest(url, method, this.loginPending, request.postData(), this.cartPending, this.couponPending)) {
          void request.abort().catch(() => {});
          return;
        }
        if (method === 'POST') {
          if (url === LOGIN_POST) this.loginPending = false;
          else if (url === COUPON_POST) this.couponPending = null;
          else this.cartPending = null;
        }
        if (url === `${HOME}cart/load?restoreCart=true`) this.restoringCart = false;
        void request.continue({ headers }).catch(() => {});
      });
    }
    return this.tab;
  }

  async navigate(url) {
    const page = await this.page();
    const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
    if (!response?.ok() || new URL(page.url()).origin !== ORIGIN) {
      throw new Error('Shufersal page is unavailable.');
    }
    return page;
  }

  async authenticated(page) {
    return page.evaluate(() => window.miglog?.account?.anonymous === false);
  }

  open() {
    return this.run(async () => {
      const page = await this.navigate(HOME);
      return { opened: true, authenticated: await this.authenticated(page) };
    });
  }

  login() {
    return this.run(async () => {
      const page = await this.navigate(HOME);
      if (await this.authenticated(page)) return { authenticated: true, reused: true };
      await this.refreshSession();
      return { authenticated: true, reused: false };
    });
  }

  // Called inside run(): never enqueue nested work or replay an operation.
  async refreshSession() {
    try {
      const credentials = loginCredentials(this.env);
      let page = await this.navigate(LOGIN);
      const validForm = await page.evaluate(expected => {
        const form = document.querySelector('form#loginForm');
        return form?.action === expected && form.method.toLowerCase() === 'post'
          && !!form.querySelector('[name="CSRFToken"]')?.value
          && !!form.querySelector('[name="j_username"]')
          && !!form.querySelector('[name="j_password"]');
      }, LOGIN_POST);
      if (!validForm) throw new Error('Login form unavailable or changed; manual verification required.');
      this.loginPending = credentials;
      try {
        const navigation = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 });
        // Submit the native form with its CSRF token and browser session cookies.
        await Promise.all([navigation, page.evaluate(({ email, password }) => {
          const form = document.querySelector('form#loginForm');
          form.querySelector('[name="j_username"]').value = email;
          form.querySelector('[name="j_password"]').value = password;
          const remember = form.querySelector('[name="remember-me"]');
          if (remember) remember.checked = false;
          HTMLFormElement.prototype.submit.call(form);
        }, credentials)]);
      } finally {
        this.loginPending = false;
      }
      // Fresh server-rendered state, not a redirect or status-code heuristic.
      page = await this.navigate(HOME);
      if (!await this.authenticated(page)) {
        throw new Error('Login not confirmed. Check credentials or a required verification challenge. No automatic retry was made.');
      }
      return page;
    } catch {
      // Do not expose browser errors, credentials, or session-bearing URLs.
      throw new AuthenticationError();
    }
  }

  search(args) {
    const request = catalogQuery(typeof args === 'string' ? { query: args } : args);
    return this.run(async () => (await this.accountPage()).evaluate(readCatalog, request));
  }

  categories(args) {
    return this.run(async () => (await this.accountPage()).evaluate(readCategories, args));
  }

  sales(args) {
    return this.run(async () => (await this.accountPage()).evaluate(readSales, args));
  }

  promotionProducts(args) {
    return this.run(async () => (await this.accountPage()).evaluate(readPromotionProducts, args));
  }

  coupons(args) {
    return this.run(async () => (await this.accountPage()).evaluate(readCoupons, args));
  }

  activateCoupon(args) {
    return this.run(async () => {
      const page = await this.accountPage();
      const prepared = await page.evaluate(prepareCoupon, args);
      if (prepared.alreadyActivated) return { promotionCode: args.promotion_code, activated: true, verified: true, alreadyActivated: true };
      const csrf = await page.evaluate(() => window.ACC?.config?.CSRFToken);
      if (typeof csrf !== 'string' || !csrf) throw Error('Coupon CSRF unavailable');
      this.couponPending = { body: prepared.body };
      try {
        return await page.evaluate(activateCouponAndVerify, { ...args, body: prepared.body, csrf });
      } finally { this.couponPending = null; }
    });
  }

  async accountPage({ restoreCart = true } = {}) {
    let page = await this.navigate(HOME);
    if (!await this.authenticated(page)) page = await this.refreshSession();
    if (await page.evaluate(() => !!window.miglog?.showMergeCarts)) throw Error('Cart merge decision required; no shopping operation started');
    // Match native page initialization: login alone can expose an empty session cart.
    // Order reads must not populate or replace an editing cart. Draft shopping
    // operations also leave an existing order-edit session untouched.
    if (restoreCart && !await page.evaluate(() => !!window.miglog?.cart?.order)) await this.readCart(page, true);
    return page;
  }

  async readCart(page, restore = false) {
    this.restoringCart = restore;
    try {
      const html = await page.evaluate(async restore => {
        const r = await fetch('/online/he/cart/load' + (restore ? '?restoreCart=true' : ''), { credentials: 'same-origin', redirect: 'error', signal: AbortSignal.timeout(20000) });
        if (!r.ok) throw Error('Cart unavailable');
        return r.text();
      }, restore);
      return await page.evaluate(parseCart, html);
    } finally { this.restoringCart = false; }
  }

  cart() {
    return this.run(async () => this.readCart(await this.accountPage()));
  }

  changeCart(operation, args) {
    return this.run(async () => {
      const page = await this.accountPage();
      if (await page.evaluate(() => !!window.miglog?.cart?.order)) throw Error('Existing order is being edited; cart changes blocked');
      const before = await this.readCart(page);
      const write = cartWrite(operation, args, before);
      const csrf = await page.evaluate(() => window.ACC?.config?.CSRFToken);
      if (typeof csrf !== 'string' || !csrf) throw Error('Cart CSRF unavailable');
      this.cartPending = { url: ORIGIN + write.path, body: write.body };
      try {
        await page.evaluate(async ({ path, body, contentType, csrf }) => {
          const r = await fetch(path, { method: 'POST', body, credentials: 'same-origin', redirect: 'error',
            headers: { 'content-type': contentType, 'CSRFToken': csrf, 'x-requested-with': 'XMLHttpRequest' },
            signal: AbortSignal.timeout(20000) });
          // HTML alone is not evidence that a requested cart change succeeded.
          if (!r.ok) throw Error('Cart write response failed; read cart before retrying');
          await r.text();
        }, { ...write, csrf });
      } finally { this.cartPending = null; }
      const cart = verifyCart(await this.readCart(page), args.product_code, args.selling_method, write.after);
      return { verified: true, previousQuantity: write.before, quantity: write.after, cart };
    });
  }

  orderHistory(args = {}) {
    return this.run(async () => (await this.accountPage({ restoreCart: false })).evaluate(readOrders, args));
  }

  orderDetails(orderNumber) {
    return this.run(async () => (await this.accountPage({ restoreCart: false })).evaluate(readOrders, { orderNumber }));
  }

  orderShortages(orderNumber, replacementUrl) {
    return this.run(async () => {
      const page = await this.accountPage({ restoreCart: false });
      const order = await page.evaluate(readOrders, { orderNumber });
      const replacement = await this.replacementContext(orderNumber, replacementUrl);
      const report = options => reconcileReplacementViews(order, inspectShortages(order, options), replacement);
      // Only a positively identified editing cart can be compared to this order.
      // Never infer the association from item overlap or an empty draft cart.
      const editingOrder = () => {
        const value = window.miglog?.cart?.order;
        return typeof value === 'string' ? value : typeof value?.code === 'string' ? value.code : null;
      };
      if (await page.evaluate(editingOrder) !== orderNumber) return report();
      let cart;
      try { cart = await this.readCart(page); }
      catch { return report({ cartCoverage: 'read_failed' }); }
      // Re-read server-rendered context: another client may have changed the
      // session cart while this page still held the old order identifier.
      try {
        const refreshed = await this.navigate(HOME);
        if (!await this.authenticated(refreshed) || await refreshed.evaluate(editingOrder) !== orderNumber) {
          return report({ cartCoverage: 'context_changed' });
        }
      } catch { return report({ cartCoverage: 'context_verification_failed' }); }
      return report({ cart });
    });
  }

  previewOrderEdit({ order_number: orderNumber, changes, replacement_url: replacementUrl }) {
    return this.run(async () => {
      const page = await this.accountPage({ restoreCart: false });
      const order = await page.evaluate(readOrders, { orderNumber });
      const preview = previewOrderChanges(order, changes);
      return { ...preview, replacementGuard: replacementEditGuard(await this.replacementContext(orderNumber, replacementUrl)) };
    });
  }

  orderReplacements({ order_number: orderNumber, product_code: productCode, selling_method: sellingMethod, include_unknown: includeUnknown = false, ...args }) {
    const request = catalogQuery(args);
    return this.run(async () => {
      const page = await this.accountPage({ restoreCart: false });
      const order = await page.evaluate(readOrders, { orderNumber });
      if (!order.active) throw new OrderCareError('This order is not active.');
      if (order.items.filter(i => i.productCode === productCode && i.sellingMethod === sellingMethod).length !== 1) {
        throw new OrderCareError('Select one unambiguous product and selling method from the order.');
      }
      return replacementCandidates(order, productCode, sellingMethod, await page.evaluate(readCatalog, request), includeUnknown);
    });
  }

  // Internal helpers run within the same serialized queue as order operations.
  rememberReplacement(snapshot) {
    if (!snapshot.orderNumber) return snapshot;
    const recorded = recordReplacementSnapshot(snapshot, this.replacementSnapshots.get(snapshot.orderNumber));
    this.replacementSnapshots.delete(snapshot.orderNumber);
    this.replacementSnapshots.set(snapshot.orderNumber, recorded);
    if (this.replacementSnapshots.size > 50) this.replacementSnapshots.delete(this.replacementSnapshots.keys().next().value);
    return recorded;
  }

  async readReplacement(url) {
    return this.rememberReplacement(await readReplacementRequest(url, { fetcher: this.replacementFetch }));
  }

  replacementRequest(url) {
    return this.run(() => this.readReplacement(url));
  }

  async replacementContext(orderNumber, url) {
    const cached = this.replacementSnapshots.get(orderNumber) || null;
    if (!url) return { snapshot: cached, fresh: false, readState: cached ? 'cached_not_rechecked' : 'not_provided' };
    replacementLink(url); // Invalid links fail before network access.
    let snapshot;
    try { snapshot = await readReplacementRequest(url, { fetcher: this.replacementFetch }); }
    catch { return { snapshot: cached, fresh: false, readState: 'read_failed' }; }
    if (!snapshot.orderNumber) return { snapshot: cached, fresh: false, readState: snapshot.state };
    if (snapshot.orderNumber !== orderNumber) throw new OrderCareError('The SMS request belongs to a different order; it was not combined with this order.');
    return { snapshot: this.rememberReplacement(snapshot), fresh: true, readState: 'read' };
  }

  async close() {
    await this.pending;
    await this.browser?.close();
    this.replacementSnapshots.clear();
  }
}
