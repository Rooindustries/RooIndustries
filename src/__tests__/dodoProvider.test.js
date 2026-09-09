/** @jest-environment node */
import crypto from 'node:crypto';
import { createDodoCheckout, createDodoClient, inspectDodoCheckout, validateDodoPayment, verifyDodoCapture, unwrapDodoWebhook } from '../server/api/payment/dodoProvider';
import providerConfig from '../server/api/payment/providerConfig';
const originalEnv = { ...process.env };
const originalFetch = global.fetch;
const secret = 'whsec_' + Buffer.from('offline-dodo-signature-secret-32bytes').toString('base64');
const record = () => ({ _id:'paymentRecord.dodo.offline', provider:'dodo', providerOrderId:'cks_offline', pricingSnapshot:{netAmount:84.99}, bookingPayload:{email:'test@example.com'}, providerPublicData:{currency:'USD',productId:'pdt_offline',environment:'test_mode'} });
const payment = () => ({payment_id:'pay_offline',checkout_session_id:'cks_offline',metadata:{paymentRecordId:record()._id},status:'succeeded',total_amount:8499,currency:'USD',product_cart:[{product_id:'pdt_offline',quantity:1}],refunds:[],customer:{email:'test@example.com'}});
const sign = (raw, timestamp = Math.floor(Date.now()/1000)) => {
  const id='evt_offline';
  const signature=crypto.createHmac('sha256',Buffer.from(secret.slice(6),'base64')).update(`${id}.${timestamp}.${raw}`).digest('base64');
  return {'webhook-id':id,'webhook-timestamp':String(timestamp),'webhook-signature':`v1,${signature}`};
};
beforeEach(()=>{
  process.env={...originalEnv,VERCEL_ENV:'development',DODO_PAYMENTS_ENVIRONMENT:'test_mode',DODO_PAYMENTS_API_KEY:'offline-test-key',DODO_PAYMENTS_PRODUCT_ID:'pdt_offline',DODO_PAYMENTS_WEBHOOK_KEY:secret,DODO_PAYMENTS_RETURN_URL:'http://100.127.48.111:3188/payment?dodo_return=1'};
  global.fetch=jest.fn(async(input)=>{
    const path=new URL(typeof input==='string'?input:input.url).pathname;
    const body=path.startsWith('/products/')?{price:{type:'one_time_price',currency:'USD',price:50,discount:0,pay_what_you_want:true,tax_inclusive:true,purchasing_power_parity:false}}:
      path==='/checkouts'?{session_id:'cks_offline',checkout_url:'https://test.checkout.dodopayments.com/cks_offline'}:
      path.startsWith('/checkouts/')?{id:'cks_offline',payment_id:'pay_offline'}:payment();
    return new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}});
  });
});
afterEach(()=>{process.env={...originalEnv};global.fetch=originalFetch;});

test('creates a server-priced USD checkout using only the configured product and frozen net amount',async()=>{
  const result=await createDodoCheckout({record:record()});
  expect(result).toMatchObject({orderId:'cks_offline',currency:'USD',amount:8499,productId:'pdt_offline'});
  const [input,init]=global.fetch.mock.calls.find(([input])=>new URL(typeof input==='string'?input:input.url).pathname==='/checkouts');
  const body=JSON.parse(init.body);
  expect(body.product_cart).toEqual([{product_id:'pdt_offline',quantity:1,amount:8499}]);
  expect(body.feature_flags).toMatchObject({allow_currency_selection:false,allow_discount_code:false,allow_customer_editing_name:true});
  expect(body.metadata.paymentRecordId).toBe(record()._id);
  expect(body.cancel_url).toContain('dodo_cancel=1');
  expect(String(input)).toContain('test.dodopayments.com');
});
test('does not repeat ambiguous checkout creation',async()=>{
  await expect(createDodoCheckout({record:record(),lookupOnly:true})).rejects.toMatchObject({code:'dodo_order_creation_requires_recovery'});
  expect(global.fetch).not.toHaveBeenCalled();
});
test.each([0,-1,NaN,Infinity])('rejects invalid total %s before any provider request',async netAmount=>{
  await expect(createDodoCheckout({record:{...record(),pricingSnapshot:{netAmount}}})).rejects.toMatchObject({code:'dodo_amount_invalid'});
  expect(global.fetch).not.toHaveBeenCalled();
});
test.each([
  [{total_amount:8498},'dodo_amount_mismatch'],[{total_amount:'8499'},'dodo_amount_mismatch'],[{total_amount:-1},'dodo_amount_mismatch'],
  [{currency:'EUR'},'dodo_currency_mismatch'],[{checkout_session_id:'cks_other'},'dodo_payment_binding_mismatch'],
  [{metadata:{paymentRecordId:'another-checkout'}},'dodo_payment_binding_mismatch'],
  [{product_cart:[{product_id:'pdt_other',quantity:1}]},'dodo_product_mismatch'],
  [{product_cart:[{product_id:'pdt_offline',quantity:2}]},'dodo_product_mismatch'],
])('rejects mismatched provider evidence %j',(patch,reason)=>{
  expect(validateDodoPayment({record:record(),payment:{...payment(),...patch}})).toMatchObject({ok:false,reason});
});
test('checks checkout-session and payment resources rather than a success redirect',async()=>{
  expect(await inspectDodoCheckout({record:record()})).toMatchObject({state:'captured',providerPaymentId:'pay_offline'});
  expect(global.fetch).toHaveBeenCalledTimes(2);
});
test('accepts an actual Standard Webhooks signature without network access',()=>{
  const raw=JSON.stringify({type:'payment.succeeded',data:payment()});
  expect(unwrapDodoWebhook({rawBody:raw,headers:sign(raw)}).type).toBe('payment.succeeded');
  expect(global.fetch).not.toHaveBeenCalled();
});
test.each(['invalid','stale','modified','missing'])('rejects %s signed notification',scenario=>{
  const raw=JSON.stringify({type:'payment.succeeded',data:payment()});
  const headers=sign(raw,scenario==='stale'?Math.floor(Date.now()/1000)-600:undefined);
  if(scenario==='invalid')headers['webhook-signature']='v1,invalid';
  if(scenario==='missing')delete headers['webhook-id'];
  expect(()=>unwrapDodoWebhook({rawBody:scenario==='modified'?raw+' ':raw,headers})).toThrow();
});
test('requires explicit mode and refuses test keys in production runtime',()=>{
  delete process.env.DODO_PAYMENTS_ENVIRONMENT;
  expect(()=>createDodoClient()).toThrow('dodo_credentials_missing');
  process.env.DODO_PAYMENTS_ENVIRONMENT='test_mode';process.env.VERCEL_ENV='production';
  expect(providerConfig.resolvePaymentProviders().dodo.enabled).toBe(false);
  expect(()=>createDodoClient()).toThrow('dodo_environment_disabled');
  process.env.VERCEL_ENV='preview';process.env.ENABLE_PREVIEW_PAYMENTS='1';
  expect(providerConfig.resolvePaymentProviders().dodo.enabled).toBe(true);
});

test('production uses the live API and excludes test checkout hosts', async () => {
  process.env.VERCEL_ENV = 'production';
  process.env.DODO_PAYMENTS_ENVIRONMENT = 'live_mode';
  process.env.DODO_PAYMENTS_RETURN_URL = 'https://www.example.com/payment';
  expect(providerConfig.resolvePaymentProviders().dodo).toEqual({enabled: true, mode: 'live'});
  await expect(createDodoCheckout({record: record()})).rejects.toMatchObject({code: 'dodo_checkout_url_invalid'});
  expect(global.fetch.mock.calls.every(([input]) => new URL(typeof input === 'string' ? input : input.url).origin === 'https://live.dodopayments.com')).toBe(true);
});

test('production rejects an insecure return URL before creating a checkout', async () => {
  process.env.VERCEL_ENV = 'production';
  process.env.DODO_PAYMENTS_ENVIRONMENT = 'live_mode';
  await expect(createDodoCheckout({record: record()})).rejects.toMatchObject({code: 'dodo_return_url_invalid'});
  expect(global.fetch).toHaveBeenCalledTimes(1);
});

test('provider outages remain unavailable and cannot authorize a payment', async () => {
  global.fetch.mockResolvedValue(new Response('{}', {status: 503}));
  expect(await inspectDodoCheckout({record: record()})).toMatchObject({state: 'unavailable'});
  expect(await verifyDodoCapture({record: record()})).toMatchObject({ok: false, retryable: true});
});

test('missing Dodo configuration is non-retryable and makes no provider requests', async () => {
  delete process.env.DODO_PAYMENTS_API_KEY;
  expect(await inspectDodoCheckout({record: record()})).toMatchObject({state: 'disabled', retryable: false});
  expect(await verifyDodoCapture({record: record()})).toMatchObject({ok: false, retryable: false});
  expect(global.fetch).not.toHaveBeenCalled();
});

test.each(['opened', 'challenged', 'lost', 'accepted', 'expired', 'cancelled'])('a disputed payment cannot authorize fulfillment after dispute.%s', async status => {
  const proof = {...payment(), disputes: [{dispute_status: `dispute_${status}`} ]};
  expect(await verifyDodoCapture({record: record(), payment: proof})).toMatchObject({ok: false, captured: true, reason: 'dodo_payment_disputed'});
});

test('successful refunds require accounting before capture verification', async () => {
  global.fetch.mockImplementation(async input => {
    const path = new URL(typeof input === 'string' ? input : input.url).pathname;
    const data = path.startsWith('/checkouts/')
      ? {id: 'cks_offline', payment_id: 'pay_offline'}
      : {...payment(), refunds: [{status: 'succeeded'}]};
    return new Response(JSON.stringify(data), {status: 200, headers: {'content-type': 'application/json'}});
  });
  expect(await verifyDodoCapture({record: record()})).toMatchObject({ok: false, reason: 'dodo_refund_requires_reconciliation'});
});
