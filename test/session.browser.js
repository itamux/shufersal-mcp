import test from 'node:test';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import {Shufersal,AuthenticationError,LOGIN,LOGIN_POST,EMAIL,PASSWORD} from '../shufersal.js';

for(const scenario of ['recover','rejected','already-authenticated','write-failure']) {
  test(`automatic session: ${scenario}`,async()=>{
    let authenticated=scenario==='already-authenticated',logins=0,writes=0,qty=0;
    const launch=async options=>{
      const browser=await puppeteer.launch(options),newPage=browser.newPage.bind(browser);
      browser.newPage=async()=>{
        const page=await newPage();
        page.on('request',r=>{r.continue=async()=>{
          const u=new URL(r.url());let status=200;
          if(r.method()==='POST'&&r.url()===LOGIN_POST){logins++;authenticated=scenario!=='rejected';}
          if(r.method()==='POST'&&u.pathname.endsWith('/cart/add')){writes++;qty=1;if(scenario==='write-failure')status=500;}
          const form=r.url()===LOGIN?`<form id="loginForm" method="post" action="${LOGIN_POST}"><input name="j_username"><input name="j_password"><input name="CSRFToken" value="fixture"></form>`:'';
          const cart=`<span id="cartTotalItems">${qty}</span>`+(qty?'<div class="miglog-prod" data-entry-number="0" data-product-code="P_1" data-entry-qty="1" data-selling-method="BY_UNIT"></div>':'');
          const body=u.pathname.includes('/cart/')?cart:`${form}<script>window.miglog={account:{anonymous:${!authenticated}},cart:{}};window.ACC={config:{CSRFToken:'fixture'}};</script>`;
          await r.respond({status,contentType:'text/html',body});
        };});return page;
      };return browser;
    };
    const s=new Shufersal({launch,env:{SHUFERSAL_EMAIL:EMAIL,SHUFERSAL_PASSWORD:PASSWORD}});
    try{
      const args={product_code:'P_1',selling_method:'BY_UNIT',quantity:1};
      if(scenario==='rejected'){
        await assert.rejects(s.changeCart('add',args),AuthenticationError);
        assert.equal(logins,1);assert.equal(writes,0);return;
      }
      if(scenario==='write-failure'){
        await assert.rejects(s.changeCart('add',args),/Cart write response failed/);
        assert.equal(logins,1);assert.equal(writes,1);
        assert.equal((await s.cart()).items[0].quantity,1);
        assert.equal(writes,1);return;
      }
      // Queued concurrent reads share the recovered session without deadlock.
      await Promise.all([s.cart(),s.cart()]);
      assert.equal(logins,scenario==='recover'?1:0);
      authenticated=false;
      assert.equal((await s.changeCart('add',args)).verified,true);
      assert.equal(logins,scenario==='recover'?2:1);assert.equal(writes,1);
    }finally{await s.close();}
  });
}
