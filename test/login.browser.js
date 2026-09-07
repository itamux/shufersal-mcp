// Local intercepted HTML only; never contacts Shufersal or submits real credentials.
import test from 'node:test';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import { Shufersal, HOME, LOGIN, LOGIN_POST } from '../shufersal.js';
const EMAIL = 'fixture@example.invalid';
const PASSWORD = 'fixture-password&=with spaces';

for (const outcome of ['success', 'rejected', 'changed-form']) {
  test(`headless login: ${outcome}`, async () => {
    let authenticated = false; const posts = []; const launches = [];
    const launch = async options => {
      launches.push(options);
      const browser = await puppeteer.launch(options);
      const original = browser.newPage.bind(browser);
      browser.newPage = async () => {
        const page = await original();
        page.on('request', request => {
          request.continue = async ({ headers }) => {
            if (request.method() === 'POST') {
              posts.push({ url: request.url(), body: request.postData(), headers });
              authenticated = outcome === 'success';
            }
            const action = outcome === 'changed-form' ? 'https://evil.invalid/' : LOGIN_POST;
            const html = request.url() === LOGIN ? `<form id="loginForm" method="post" action="${action}"><input name="j_username"><input name="j_password"><input type="hidden" name="CSRFToken" value="fixture"></form>` : '';
            await request.respond({status:200, contentType:'text/html', body:`<html><body>${html}<script>window.miglog={account:{anonymous:${!authenticated}}};</script></body></html>`});
          };
        });
        return page;
      };
      return browser;
    };
    const shopping = new Shufersal({ launch, env: { SHUFERSAL_EMAIL: EMAIL, SHUFERSAL_PASSWORD: PASSWORD } });
    try {
      if (outcome === 'success') {
        assert.deepEqual(await shopping.login(), { authenticated: true, reused: false });
        assert.deepEqual(await shopping.login(), { authenticated: true, reused: true });
      } else await assert.rejects(shopping.login(), /Login/);
      assert.equal(launches[0].headless, true);
      assert.equal(posts.length, outcome === 'changed-form' ? 0 : 1);
      for (const post of posts) {
        assert.equal(post.url, LOGIN_POST);
        assert.equal(post.headers.authorization, undefined);
        const fields = new URLSearchParams(post.body);
        assert.equal(fields.get('j_username'), EMAIL);
        assert.equal(fields.get('j_password'), PASSWORD);
        assert.equal(fields.get('CSRFToken'), 'fixture');
      }
    } finally { await shopping.close(); }
  });
}
