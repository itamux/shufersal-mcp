import test from 'node:test';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import { readCatalog, catalogQuery, readCategories, readCoupons, readSales, readPromotionProducts } from '../catalog.js';

test('catalog browser contracts, pagination and account-field minimization', async () => {
  const browser=await puppeteer.launch({headless:true});
  try {
    const page=await browser.newPage();await page.setRequestInterception(true);
    let ignored=false,requests=[];
    page.on('request',async r=>{
      requests.push({url:r.url(),method:r.method()});const u=new URL(r.url());let body='',contentType='text/html';
      if(u.pathname.endsWith('/results')) {contentType='application/json';body=JSON.stringify({results:[{code:'P_1',name:'Milk',secret:'omit'}],pagination:{currentPage:ignored?0:Number(u.searchParams.get('page')),pageSize:5,sort:'relevance',totalNumberOfResults:12,numberOfPages:3}});}
      else if(u.pathname.includes('/subcategories/')) {contentType='application/json';body='[]';}
      else if(u.pathname.endsWith('/my-coupons')) {contentType='application/json';const coupon={promotionCode:'123',couponCode:'PRIVATE-REDEMPTION',expiryDate:Date.now()+86400000,activated:false,display:'<div class="textContainer"><b class="title">Milk deal</b>Buy two</div>'};body=JSON.stringify({myCoupons:[coupon,{...coupon,expiryDate:1},{...coupon,prePaid:true},{...coupon,activated:true,aboutToExpire:true}]});}
      else if(u.pathname.endsWith('/fragment')) body='<div data-page="1" data-pages="3" data-results="41"><div data-promo="123"><div class="textContainer"><b class="title">2 for 22</b><div class="description">Milk</div></div></div></div>';
      else if(u.pathname.includes('/promotionPopup/')) body='<li data-product-row data-product-code="P_1" data-selling-method="BY_UNIT"><a class="product"><span class="description">Milk</span></a><span data-price-per-unit>12.90</span></li>';
      else body='<label>Example brand<input data-facet=":brand:628"></label><input name="sorting" value="relevance">';
      await r.respond({status:200,contentType,body});
    });
    await page.goto('https://www.shufersal.co.il/online/he/');
    const q=catalogQuery({query:'milk',brand_codes:['628'],page:1,page_size:5});
    const results=await page.evaluate(readCatalog,q);assert.equal(results.pagination.page,1);assert.equal(results.facets[0].values[0].name,'Example brand');assert.ok(!JSON.stringify(results).includes('secret'));
    await assert.rejects(page.evaluate(readCatalog,catalogQuery({query:'milk',brand_codes:['bad'],page_size:5})),/Filter unavailable/);
    ignored=true;await assert.rejects(page.evaluate(readCatalog,q),/not honored/);
    assert.deepEqual((await page.evaluate(readCategories,{parent_code:'A01'})).categories,[]);
    const coupons=await page.evaluate(readCoupons,{});assert.equal(coupons.total,2);assert.equal(coupons.coupons[0].title,'Milk deal');assert.ok(!JSON.stringify(coupons).includes('PRIVATE'));
    assert.equal((await page.evaluate(readCoupons,{activated:true,expiring_only:true})).total,1);
    assert.equal((await page.evaluate(readSales,{category_code:'A01',page:1})).offers[0].promotionCode,'123');
    await assert.rejects(page.evaluate(readSales,{page:0}),/pagination/);
    assert.equal((await page.evaluate(readPromotionProducts,{promotion_code:'123'})).products[0].regularPrice,'12.90');
    assert.ok(requests.every(r=>r.method==='GET'));
  } finally {await browser.close();}
});
