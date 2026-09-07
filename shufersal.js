import puppeteer from 'puppeteer';
import { prepareCoupon, activateCouponAndVerify } from './coupons.js';
import { catalogQuery, readCatalog, readCategories, readCoupons, readSales, readPromotionProducts } from './catalog.js';
import { parseCart, cartWrite, verifyCart, readOrders } from './shopping.js';

export const ORIGIN = 'https://www.shufersal.co.il';
export const HOME = `${ORIGIN}/online/he/`;
export const LOGIN = `${ORIGIN}/online/he/login`;
export const LOGIN_POST = `${ORIGIN}/online/he/j_spring_security_check`;
export const EMAIL = 'PH_shufersal_email';
export const PASSWORD = 'PH_shufersal_password';
export const AUTHORIZATION = 'Bearer PH_shufersal_login';
export const COUPON_POST = `${ORIGIN}/online/he/my-account/coupons/activate-coupon`;
export const COUPON_AUTHORIZATION = 'Bearer PH_shufersal_coupon';
export const CART_AUTHORIZATION = 'Bearer PH_shufersal_cart';

// Only public placeholders belong in the consumer process. Values are filled
// by Claw Patrol's shufersal_login credential at the outgoing form boundary.
export function loginPlaceholders(env) {
  if (env.SHUFERSAL_EMAIL !== EMAIL || env.SHUFERSAL_PASSWORD !== PASSWORD) {
    throw new Error('Set SHUFERSAL_EMAIL and SHUFERSAL_PASSWORD to the documented Claw Patrol placeholders.');
  }
  return { email: EMAIL, password: PASSWORD };
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
  return form.getAll('j_username').length === 1 && form.get('j_username') === EMAIL
    && form.getAll('j_password').length === 1 && form.get('j_password') === PASSWORD;
}

export class AuthenticationError extends Error {
  constructor() {
    super('Login refresh failed. Check the configured credentials or complete any Shufersal verification challenge. No cart or coupon change was attempted.');
    this.name = 'AuthenticationError';
  }
}

export class Shufersal {
  constructor({ env = process.env, launch = puppeteer.launch.bind(puppeteer) } = {}) {
    this.env = env;
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
        if (!allowedRequest(url, method, this.loginPending, request.postData(), this.cartPending, this.couponPending)) {
          void request.abort().catch(() => {});
          return;
        }
        if (method === 'POST') {
          // Dispatch marker is attached only to the exact login POST; never
          // a global browser header or a header carried across redirects.
          if (url === LOGIN_POST) {
            headers.authorization = AUTHORIZATION; this.loginPending = false;
          } else if (url === COUPON_POST) {
            headers.authorization = COUPON_AUTHORIZATION; this.couponPending = null;
          } else {
            headers.authorization = CART_AUTHORIZATION; this.cartPending = null;
          }
        }
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
      const placeholders = loginPlaceholders(this.env);
      let page = await this.navigate(LOGIN);
      const validForm = await page.evaluate(expected => {
        const form = document.querySelector('form#loginForm');
        return form?.action === expected && form.method.toLowerCase() === 'post'
          && !!form.querySelector('[name="CSRFToken"]')?.value
          && !!form.querySelector('[name="j_username"]')
          && !!form.querySelector('[name="j_password"]');
      }, LOGIN_POST);
      if (!validForm) throw new Error('Login form unavailable or changed; manual verification required.');
      this.loginPending = true;
      try {
        const navigation = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 });
        // Bypass email-format validation of the non-secret placeholder while
        // preserving Shufersal's real form action, CSRF token and cookies.
        await Promise.all([navigation, page.evaluate(({ email, password }) => {
          const form = document.querySelector('form#loginForm');
          form.querySelector('[name="j_username"]').value = email;
          form.querySelector('[name="j_password"]').value = password;
          const remember = form.querySelector('[name="remember-me"]');
          if (remember) remember.checked = false;
          HTMLFormElement.prototype.submit.call(form);
        }, placeholders)]);
      } finally {
        this.loginPending = false;
      }
      // Fresh server-rendered state, not a redirect or status-code heuristic.
      page = await this.navigate(HOME);
      if (!await this.authenticated(page)) {
        throw new Error('Login not confirmed. Check the Claw Patrol binding, credentials, or a required verification challenge. No automatic retry was made.');
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

  async accountPage() {
    let page = await this.navigate(HOME);
    if (!await this.authenticated(page)) page = await this.refreshSession();
    if (await page.evaluate(() => !!window.miglog?.showMergeCarts)) throw Error('Cart merge decision required; no shopping operation started');
    // Match native page initialization: login alone can expose an empty session cart.
    await this.readCart(page, true);
    return page;
  }

  async readCart(page, restore = false) {
    const html = await page.evaluate(async restore => {
      const r = await fetch('/online/he/cart/load' + (restore ? '?restoreCart=true' : ''), { credentials: 'same-origin', redirect: 'error', signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw Error('Cart unavailable');
      return r.text();
    }, restore);
    return page.evaluate(parseCart, html);
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
    return this.run(async () => (await this.accountPage()).evaluate(readOrders, args));
  }

  orderDetails(orderNumber) {
    return this.run(async () => (await this.accountPage()).evaluate(readOrders, { orderNumber }));
  }

  async close() {
    await this.pending;
    await this.browser?.close();
  }
}
