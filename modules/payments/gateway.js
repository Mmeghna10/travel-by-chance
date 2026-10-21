// Thin wrapper around the official Razorpay Node SDK, plus the payment
// configuration. Everything else in the app talks to Razorpay through
// getGateway(), so tests can swap in a simulator (test/fakeRazorpay.js)
// without touching business logic.
const Razorpay = require("razorpay");

let settings = null; // { keyId, keySecret, webhookSecret }
let gateway = null;

function createRazorpayGateway({ keyId, keySecret }) {
  const rzp = new Razorpay({ key_id: keyId, key_secret: keySecret });
  return {
    createOrder: (params) => rzp.orders.create(params),
    fetchPayment: (paymentId) => rzp.payments.fetch(paymentId),
    fetchOrderPayments: async (orderId) => (await rzp.orders.fetchPayments(orderId)).items,
    createRefund: (paymentId, params) => rzp.payments.refund(paymentId, params),
    fetchRefunds: async (paymentId) => (await rzp.payments.fetchMultipleRefund(paymentId, { count: 100 })).items,
    fetchRefund: (paymentId, refundId) => rzp.payments.fetchRefund(paymentId, refundId),
  };
}

// Refuses live keys unless explicitly allowed: this is a portfolio project
// and a typo in .env must never charge real cards.
function validateKeys({ keyId, allowLive }) {
  if (keyId && !keyId.startsWith("rzp_test_") && !allowLive) {
    throw new Error("RAZORPAY_KEY_ID is not a test key (rzp_test_...). Set ALLOW_LIVE_PAYMENTS=true to use live keys.");
  }
}

/** Called once at startup (server.js / worker.js) or by tests. */
function configurePayments({ keyId, keySecret, webhookSecret, allowLive = false, gateway: custom } = {}) {
  validateKeys({ keyId, allowLive });
  settings = keyId && keySecret ? { keyId, keySecret, webhookSecret } : null;
  gateway = custom || (settings ? createRazorpayGateway(settings) : null);
}

function paymentsEnabled() {
  return Boolean(settings && gateway);
}

function getSettings() {
  if (!settings) throw new Error("Payments are not configured (RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET).");
  return settings;
}

function getGateway() {
  if (!gateway) throw new Error("Payments are not configured.");
  return gateway;
}

module.exports = { configurePayments, paymentsEnabled, getSettings, getGateway, validateKeys };
