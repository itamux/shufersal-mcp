import test from 'node:test';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import { Shufersal, COUPON_AUTHORIZATION, COUPON_POST, allowedRequest } from '../shufersal.js';
for(const outcome of ['success','already-active','rejected','expired','ambiguous','anonymous']) {
 test(`coupon activation: ${outcome}`,async()=>{
  let activated=outcome==='already-active';const posts=[];
  const launch=async options=>{const b=await puppeteer.launch(options);const orig=b.newPage.bind(b);b.newPage=async()=>{const p=await orig();p.on('request',r=>{r.continue=async({headers})=>{
   let body,contentType='text/html';const u=new URL(r.url());
   if(r.method()==='POST'){posts.push({body:r.postData(),headers});if(outcome!=='rejected') activated=true;body='{"activated":true}';contentType='application/json';}
   else if(u.pathname.endsWith('/cart/load')) body='<span id="cartTotalItems">0</span>';
   else if(u.pathname.endsWith('/my-coupons')){contentType='application/json';const c={promotionCode:'123',couponCode:'PRIVATE_CODE',activated,expiryDate:outcome==='expired'?1:Date.now()+86400000};body=JSON.stringify({myCoupons:outcome==='ambiguous'?[c,c]:[c]});}
   else body=`<script>window.miglog={account:{anonymous:${outcome==='anonymous'}}};window.ACC={config:{CSRFToken:'fixture'}};</script>`;
   await r.respond({status:200,contentType,body});
  };});return p;};return b;};
  const s=new Shufersal({launch});try{
   if(['success','already-active'].includes(outcome)){
    const result=await s.activateCoupon({promotion_code:'123'});assert.equal(result.activated,true);assert.equal(result.verified,true);assert.ok(!JSON.stringify(result).includes('PRIVATE'));
    await s.activateCoupon({promotion_code:'123'});assert.equal(posts.length,outcome==='success'?1:0);
    if(posts.length) assert.equal(posts[0].headers.authorization,COUPON_AUTHORIZATION);
   }else{await assert.rejects(s.activateCoupon({promotion_code:'123'}));assert.equal(posts.length,outcome==='rejected'?1:0);}
   assert.ok(!s.couponPending);
  }finally{await s.close();}
 });
}
test('only the exact armed coupon body is admitted',()=>{
 const body='{"couponCode":"fixture"}';
 assert.equal(allowedRequest(COUPON_POST,'POST',false,body,null,{body}),true);
 assert.equal(allowedRequest(COUPON_POST,'POST',false,body),false);
 assert.equal(allowedRequest(COUPON_POST+'?redeem=true','POST',false,body,null,{body}),false);
 assert.equal(allowedRequest(COUPON_POST,'POST',false,'{}',null,{body}),false);
});
