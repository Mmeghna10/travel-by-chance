const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const sdk = require("razorpay/dist/utils/razorpay-utils");
const { verifyCheckoutSignature, verifyWebhookSignature, hmacHex } = require("../../modules/payments/signatures.js");
const { validateKeys } = require("../../modules/payments/gateway.js");

const rand = () => crypto.randomBytes(8).toString("hex");

test("checkout signature: agrees with the official SDK helper on valid and tampered input", () => {
  for (let i = 0; i < 200; i++) {
    const secret = rand();
    const orderId = `order_${rand()}`;
    const paymentId = `pay_${rand()}`;
    const good = hmacHex(secret, `${orderId}|${paymentId}`);
    const cases = [
      [orderId, paymentId, good, secret],
      [orderId, `pay_${rand()}`, good, secret], // signature for a different payment
      [`order_${rand()}`, paymentId, good, secret], // different order
      [orderId, paymentId, good, rand()], // wrong secret
      [orderId, paymentId, good.slice(0, -1) + (good.endsWith("0") ? "1" : "0"), secret], // one char changed
    ];
    for (const [o, p, sig, s] of cases) {
      assert.equal(
        verifyCheckoutSignature({ orderId: o, paymentId: p, signature: sig, keySecret: s }),
        sdk.validatePaymentVerification({ order_id: o, payment_id: p }, sig, s),
      );
    }
  }
});

test("webhook signature: agrees with the SDK, and needs the exact raw bytes", () => {
  const secret = rand();
  const raw = Buffer.from('{"event":"payment.captured","payload":{"payment":{"entity":{"id":"pay_1","amount":100}}}}');
  const sig = hmacHex(secret, raw);
  assert.equal(verifyWebhookSignature({ rawBody: raw, signature: sig, webhookSecret: secret }), true);
  assert.equal(sdk.validateWebhookSignature(raw.toString(), sig, secret), true);

  // Same JSON, different bytes (pretty-printed): signature must NOT match.
  const reserialised = Buffer.from(JSON.stringify(JSON.parse(raw.toString()), null, 2));
  assert.equal(verifyWebhookSignature({ rawBody: reserialised, signature: sig, webhookSecret: secret }), false);
  // A parsed object instead of raw bytes is refused outright.
  assert.equal(verifyWebhookSignature({ rawBody: JSON.parse(raw.toString()), signature: sig, webhookSecret: secret }), false);
});

test("malformed signatures are rejected without throwing", () => {
  const args = { orderId: "order_1", paymentId: "pay_1", keySecret: "s" };
  for (const signature of [undefined, null, "", "zz", "abc", 123, "a".repeat(64), "A".repeat(10_000)]) {
    assert.equal(verifyCheckoutSignature({ ...args, signature }), false, String(signature).slice(0, 20));
  }
  assert.equal(verifyCheckoutSignature({ ...args, keySecret: undefined, signature: hmacHex("s", "order_1|pay_1") }), false);
});

test("live Razorpay keys are refused unless explicitly allowed", () => {
  assert.doesNotThrow(() => validateKeys({ keyId: "rzp_test_abc" }));
  assert.doesNotThrow(() => validateKeys({ keyId: undefined }));
  assert.throws(() => validateKeys({ keyId: "rzp_live_abc" }), /not a test key/);
  assert.doesNotThrow(() => validateKeys({ keyId: "rzp_live_abc", allowLive: true }));
});
