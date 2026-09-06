// These functions execute inside the headless browser. Coupon codes stay out of MCP output.
export async function prepareCoupon({ promotion_code }) {
  const r = await fetch('/online/he/my-account/coupons/my-coupons', {
    credentials: 'same-origin', redirect: 'error', signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw Error('Coupons unavailable');
  const data = await r.json();
  if (!Array.isArray(data.myCoupons)) throw Error('Coupon format changed');
  const matches = data.myCoupons.filter(c => c.promotionCode === promotion_code && !c.prePaid && !c.prePaidCard && typeof c.expiryDate === 'number' && c.expiryDate >= Date.now());
  if (matches.length !== 1) throw Error('Expected exactly one unexpired account coupon for this promotion');
  const c = matches[0];
  if (typeof c.activated !== 'boolean' || !/^[A-Za-z0-9_-]{1,100}$/.test(c.couponCode || '')) throw Error('Coupon state unavailable');
  return { alreadyActivated: c.activated, body: JSON.stringify({ couponCode: c.couponCode }) };
}

export async function activateCouponAndVerify({ body, csrf, promotion_code }) {
  // No retries: even a failed response can mean the activation happened.
  const r = await fetch('/online/he/my-account/coupons/activate-coupon', {
    method: 'POST', body, credentials: 'same-origin', redirect: 'error',
    headers: { 'content-type': 'application/json', CSRFToken: csrf }, signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw Error('Activation response failed; read coupon status before retrying');
  await r.text();
  const check = await fetch('/online/he/my-account/coupons/my-coupons', {
    credentials: 'same-origin', redirect: 'error', signal: AbortSignal.timeout(20000),
  });
  if (!check.ok) throw Error('Activation unconfirmed; read coupon status');
  const data = await check.json(), code = JSON.parse(body).couponCode;
  const matches = Array.isArray(data.myCoupons) ? data.myCoupons.filter(c => c.couponCode === code && c.promotionCode === promotion_code) : [];
  if (matches.length !== 1 || matches[0].activated !== true) throw Error('Activation not confirmed; read coupon status before retrying');
  return { promotionCode: promotion_code, activated: true, verified: true, alreadyActivated: false };
}
