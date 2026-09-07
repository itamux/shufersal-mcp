import test from 'node:test';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import { parseCart } from '../shopping.js';
import { readCatalog, catalogQuery, readCategories, readCoupons, readSales, readPromotionProducts } from '../catalog.js';

test('catalog browser contracts, pagination and account-field minimization', async () => {
  const browser=await puppeteer.launch({headless:true});
  try {
    const page=await browser.newPage();await page.setRequestInterception(true);
    let ignored=false,requests=[],stock,stockMarkup='';
    page.on('request',async r=>{
      requests.push({url:r.url(),method:r.method()});const u=new URL(r.url());let body='',contentType='text/html';
      if(u.pathname.endsWith('/results')) {contentType='application/json';body=JSON.stringify({results:[{code:'P_1',name:'Milk',stock,baseProductImageMedium:'https://res.cloudinary.com/shufersal/image/upload/v1/product.png',secret:'omit'}],pagination:{currentPage:ignored?0:Number(u.searchParams.get('page')),pageSize:5,sort:'relevance',totalNumberOfResults:12,numberOfPages:3}});}
      else if(u.pathname.includes('/subcategories/')) {contentType='application/json';body='[]';}
      else if(u.pathname.endsWith('/my-coupons')) {contentType='application/json';const coupon={promotionCode:'123',couponCode:'PRIVATE-REDEMPTION',expiryDate:Date.now()+86400000,activated:false,display:'<div class="textContainer"><b class="title">Milk deal</b>Buy two</div>'};body=JSON.stringify({myCoupons:[coupon,{...coupon,expiryDate:1},{...coupon,prePaid:true},{...coupon,activated:true,aboutToExpire:true}]});}
      else if(u.pathname.endsWith('/fragment')) body='<div data-page="1" data-pages="3" data-results="41"><div data-promo="123"><div class="textContainer"><b class="title">2 for 22</b><div class="description">Milk</div></div></div></div>';
      else if(u.pathname.includes('/promotionPopup/')) body='<li data-product-row data-product-code="P_1" data-selling-method="BY_UNIT">'+stockMarkup+'<a class="imgContainer"><img src="https://res.cloudinary.com/shufersal/image/upload/v1/product.png"></a><a class="product"><span class="description">Milk</span></a><span data-price-per-unit>12.90</span></li>';
      else body='<label>Example brand<input data-facet=":brand:628"></label><input name="sorting" value="relevance">';
      await r.respond({status:200,contentType,body});
    });
    await page.goto('https://www.shufersal.co.il/online/he/');
    const q=catalogQuery({query:'milk',brand_codes:['628'],page:1,page_size:5});
    const results=await page.evaluate(readCatalog,q);assert.equal(results.pagination.page,1);assert.equal(results.products[0].imageUrl,'https://res.cloudinary.com/shufersal/image/upload/v1/product.png');assert.equal(results.facets[0].values[0].name,'Example brand');assert.ok(!JSON.stringify(results).includes('secret'));
    await assert.rejects(page.evaluate(readCatalog,catalogQuery({query:'milk',brand_codes:['bad'],page_size:5})),/Filter unavailable/);
    for (const [value, expected] of [['inStock','in_stock'],['outOfStock','out_of_stock'],['unexpected','unknown'],[null,'unknown'],[undefined,'unknown']]) {
      stock=value === undefined ? undefined : {stockLevelStatus:{code:value},warehouse:'PRIVATE-STOCK'};
      for (const request of [q,catalogQuery({category_code:'A01',page:1,page_size:5})]) {
        const row=(await page.evaluate(readCatalog,request)).products[0];
        assert.equal(row.availability,expected);assert.equal(row.stockStatus,value??null);
        assert.ok(!JSON.stringify(row).includes('PRIVATE-STOCK'));
      }
    }
    ignored=true;await assert.rejects(page.evaluate(readCatalog,q),/not honored/);
    assert.deepEqual((await page.evaluate(readCategories,{parent_code:'A01'})).categories,[]);
    const coupons=await page.evaluate(readCoupons,{});assert.equal(coupons.total,2);assert.equal(coupons.coupons[0].title,'Milk deal');assert.ok(!JSON.stringify(coupons).includes('PRIVATE'));
    assert.equal((await page.evaluate(readCoupons,{activated:true,expiring_only:true})).total,1);
    assert.equal((await page.evaluate(readSales,{category_code:'A01',page:1})).offers[0].promotionCode,'123');
    await assert.rejects(page.evaluate(readSales,{page:0}),/pagination/);
    assert.equal((await page.evaluate(readPromotionProducts,{promotion_code:'123'})).products[0].regularPrice,'12.90');
    assert.equal((await page.evaluate(readPromotionProducts,{promotion_code:'123'})).products[0].imageUrl,'https://res.cloudinary.com/shufersal/image/upload/v1/product.png');
    for (const [markup, expected] of [
      ['', 'unknown'],
      ['<div hidden><div class="js-miglog-outofstock"></div></div>', 'unknown'],
      ['<div class="miglog-prod-inStock"></div><div class="js-miglog-outofstock hidden"></div>', 'in_stock'],
      ['<div class="js-miglog-outofstock"></div>', 'out_of_stock'],
      ['<div class="miglog-prod-inStock"></div><div class="js-miglog-outofstock"></div>', 'unknown'],
      ['<div class="js-miglog-outofstock hidden"></div>', 'unknown'],
    ]) {
      stockMarkup=markup;
      const row=(await page.evaluate(readPromotionProducts,{promotion_code:'123'})).products[0];
      assert.equal(row.availability,expected);
      assert.equal(row.stockStatus,expected==='in_stock'?'inStock':expected==='out_of_stock'?'outOfStock':null);
    }
    const cartImage=src=>`<div class="miglog-prod" data-entry-number="0" data-product-code="P_1" data-entry-qty="1" data-selling-method="BY_UNIT"><a class="imgContainer"><img src="${src}"></a></div>`;
    assert.equal((await page.evaluate(parseCart,cartImage('https://res.cloudinary.com/shufersal/image/upload/v1/product.png'))).items[0].imageUrl,'https://res.cloudinary.com/shufersal/image/upload/v1/product.png');
    for(const src of ['', 'javascript:alert(1)', 'https://evil.invalid/product.png', 'https://media.shufersal.co.il/product_images/default/M_P_default.png']) assert.equal((await page.evaluate(parseCart,cartImage(src))).items[0].imageUrl,null);
    assert.ok(requests.every(r=>r.method==='GET'));
  } finally {await browser.close();}
});
