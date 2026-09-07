import test from 'node:test';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import { Shufersal, CART_AUTHORIZATION } from '../shufersal.js';

for (const outcome of ['success', 'rejected-write', 'stale-cart', 'editing-order', 'expired-session', 'out-of-stock', 'calculation-error', 'zero-count']) {
  test(`headless cart: ${outcome}`, async () => {
    let qty=0; const posts=[];
    const launch=async options=>{
      const browser=await puppeteer.launch(options);const original=browser.newPage.bind(browser);
      browser.newPage=async()=>{const page=await original();page.on('request',request=>{
        request.continue=async({headers})=>{
          const url=new URL(request.url());let body;
          if(request.method()==='POST') {
            posts.push({path:url.pathname,headers});
            if(outcome!=='rejected-write') qty=url.pathname.endsWith('/add')?qty+JSON.parse(request.postData()).qty:Number(url.searchParams.get('qty'));
          }
          if(url.pathname.includes('/cart/')) body=`<div id="cartTotalItems">${['out-of-stock','zero-count'].includes(outcome)?0:qty}</div><div class="discountCartBottom">₪10</div>`+(qty?`<div class="miglog-prod ${outcome==='out-of-stock'?'miglog-cart-prod-notInStock':outcome==='calculation-error'?'errorCalc':''}" data-entry-number="0" data-product-code="P_123" data-entry-qty="${qty}" data-product-name="Fixture"><input name="sellingMethod" value="BY_UNIT"></div>`:'');
          else body=`<script>window.miglog={account:{anonymous:${outcome==='expired-session'}},cart:{order:${outcome==='editing-order'?'"fixture-order"':'null'}}};window.ACC={config:{CSRFToken:'fixture'}};</script>`;
          await request.respond({status:200,contentType:'text/html',body});
        };
      });return page;};return browser;
    };
    const s=new Shufersal({launch});const args={product_code:'P_123',selling_method:'BY_UNIT',quantity:1};
    try{
      if(['editing-order','expired-session'].includes(outcome)){await assert.rejects(s.changeCart('add',args));assert.equal(posts.length,0);return;}
      if(outcome==='rejected-write'){await assert.rejects(s.changeCart('add',args),/not confirmed/);assert.equal(posts.length,1);return;}
      if(['out-of-stock','calculation-error','zero-count'].includes(outcome)){
        await assert.rejects(s.changeCart('add',args),/not confirmed/);
        assert.equal(posts.length,1);
        const cart=await s.cart();
        assert.equal(cart.items[0].outOfStock,outcome==='out-of-stock');
        assert.equal(cart.items[0].calculationError,outcome==='calculation-error');
        assert.equal((await s.changeCart('remove',{...args,expected_quantity:1})).cart.items.length,0);
        return;
      }
      assert.equal((await s.changeCart('add',args)).quantity,1);
      if(outcome==='stale-cart'){await assert.rejects(s.changeCart('update',{...args,quantity:2,expected_quantity:5}),/changed/);assert.equal(posts.length,1);return;}
      assert.equal((await s.changeCart('update',{...args,quantity:2,expected_quantity:1})).quantity,2);
      assert.equal((await s.changeCart('remove',{...args,expected_quantity:2})).cart.items.length,0);
      assert.equal(posts.length,3);
      assert.ok(posts.every(p=>p.headers.authorization===CART_AUTHORIZATION));
    }finally{await s.close();}
  });
}
