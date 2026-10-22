// Razorpay signature checks, implemented exactly as documented:
//   checkout: HMAC-SHA256(order_id + "|" + razorpay_payment_id, key_secret)
//   webhook:  HMAC-SHA256(raw request body, webhook_secret)
// The SDK ships helpers for both (razorpay/dist/utils/razorpay-utils), but
// they compare with `===`, which returns as soon as a character differs. We
// use crypto.timingSafeEqual instead so response time leaks nothing about the
// expected signature. test/unit/signatures.test.js checks that we agree with
// the SDK on valid and invalid signatures.
const crypto = require("crypto");

function hmacHex(secret, message) {
  return crypto.createHmac("sha256", secret).update(message).digest("hex");
}

function safeEqualHex(expectedHex, receivedHex) {
  if (typeof receivedHex !== "string" || !/^[0-9a-f]+$/i.test(receivedHex)) return false;
  const a = Buffer.from(expectedHex, "hex");
  const b = Buffer.from(receivedHex, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// `orderId` must be the order id WE stored for this booking, not the one the
// browser sent back (Razorpay's docs say the same).
function verifyCheckoutSignature({ orderId, paymentId, signature, keySecret }) {
  if (!orderId || !paymentId || !keySecret) return false;
  return safeEqualHex(hmacHex(keySecret, `${orderId}|${paymentId}`), signature);
}

// `rawBody` must be the exact bytes received (a Buffer). Parsing and
// re-serialising JSON can change whitespace or key order and break the HMAC.
function verifyWebhookSignature({ rawBody, signature, webhookSecret }) {
  if (!Buffer.isBuffer(rawBody) || !webhookSecret) return false;
  return safeEqualHex(hmacHex(webhookSecret, rawBody), signature);
}

module.exports = { verifyCheckoutSignature, verifyWebhookSignature, hmacHex };
