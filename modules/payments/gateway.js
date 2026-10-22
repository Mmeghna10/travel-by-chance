// Thin wrapper around the official Razorpay Node SDK, plus the payment
// configuration. Everything else in the app talks to Razorpay through
// getGateway(), so tests can swap in a simulator (test/fakeRazorpay.js)
// without touching business logic.
const Razorpay = require("razorpay");
const { createDemoGateway, demoKeySecret } = require("./demoGateway.js");

let settings = null; // { mode: "razorpay" | "demo", keyId, keySecret, webhookSecret }
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

// Demo mode is for showing the flow without a Razorpay account. It must be
// impossible to end up in it by accident next to real keys, or in production
// without saying so explicitly.
function validateDemo({ demo, keyId, isProduction, allowDemoInProduction }) {
  if (!demo) return;
  if (keyId) throw new Error("DEMO_PAYMENTS=true and RAZORPAY_KEY_ID are both set; choose one.");
  if (isProduction && !allowDemoInProduction) {
    throw new Error("DEMO_PAYMENTS is refused when NODE_ENV=production. Set ALLOW_DEMO_PAYMENTS_IN_PRODUCTION=true for a public demo site.");
  }
}

/** Called once at startup (server.js / worker.js) or by tests. */
function configurePayments({
  keyId,
  keySecret,
  webhookSecret,
  allowLive = false,
  gateway: custom,
  demo = false,
  demoSecret,
  isProduction = false,
  allowDemoInProduction = false,
} = {}) {
  validateDemo({ demo, keyId, isProduction, allowDemoInProduction });
  if (demo) {
    if (!demoSecret) throw new Error("Demo payments need a secret to sign simulated checkouts.");
    settings = { mode: "demo", keyId: "demo", keySecret: demoKeySecret(demoSecret) };
    gateway = custom || createDemoGateway();
    return;
  }
  validateKeys({ keyId, allowLive });
  settings = keyId && keySecret ? { mode: "razorpay", keyId, keySecret, webhookSecret } : null;
  gateway = custom || (settings ? createRazorpayGateway(settings) : null);
}

/** "razorpay", "demo", or null when payments are off. */
function paymentsMode() {
  return paymentsEnabled() ? settings.mode : null;
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

module.exports = { configurePayments, paymentsEnabled, paymentsMode, getSettings, getGateway, validateKeys, validateDemo };
