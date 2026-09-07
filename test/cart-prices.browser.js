import test from 'node:test';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import {parseCart} from '../shopping.js';

test('cart row totals, savings and payable total are distinct',async()=>{
  const browser=await puppeteer.launch({headless:true});
  try{
    const page=await browser.newPage();
    const row='<div class="miglog-prod" data-entry-number="0" data-product-code="P_1" data-entry-qty="2" data-selling-method="BY_UNIT"><p class="miglog-prod-totalPrize">19.80₪</p></div>';
    const html=row+'<span id="cartTotalItems">2</span><span class="discountCartBottom">0.00₪</span><span class="miglog-cart-summary-totalprice">55.70₪</span>';
    const cart=await page.evaluate(parseCart,html);
    assert.equal(cart.items[0].price,'19.80₪');
    assert.equal(cart.items[0].lineTotal,'19.80₪');
    assert.equal(cart.total,'55.70₪');
    assert.equal(cart.savings,'0.00₪');
    const missing=await page.evaluate(parseCart,row+'<span class="discountCartBottom">0.00₪</span>');
    assert.equal(missing.total,null);
    const empty=await page.evaluate(parseCart,'<span id="cartTotalItems">0</span><span class="miglog-cart-summary-totalprice">0.00₪</span>');
    assert.equal(empty.total,'0.00₪');
    assert.equal(empty.savings,null);
  }finally{await browser.close();}
});
