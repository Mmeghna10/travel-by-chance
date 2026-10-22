const ExpressError = require("../utils/ExpressError.js");
const { paymentsEnabled, paymentsMode, getSettings } = require("../modules/payments/gateway.js");
const { simulateCheckout } = require("../modules/payments/demoGateway.js");
const Payment = require("../models/payment.js");
const paymentService = require("../modules/payments/service.js");
const { handleWebhook } = require("../modules/payments/webhooks.js");

function requirePayments() {
  if (!paymentsEnabled()) throw new ExpressError(503, "Online payment is not enabled.", "PAYMENTS_DISABLED");
}

// POST /api/v1/bookings/:id/payment-order
module.exports.createOrder = async (req, res) => {
  requirePayments();
  const order = await paymentService.createPaymentOrder({ bookingId: req.params.id, user: req.user });
  res.json({ success: true, mode: paymentsMode(), ...order });
};

// POST /api/v1/payments/verify  (Checkout handler response)
module.exports.verify = async (req, res) => {
  requirePayments();
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
  const result = await paymentService.verifyCheckout({
    user: req.user,
    orderId: razorpay_order_id,
    paymentId: razorpay_payment_id,
    signature: razorpay_signature,
  });
  res.json({ success: true, ...result });
};

// POST /api/v1/demo-payments/:orderId/pay  { outcome: "success" | "declined" }
// DEMO MODE ONLY. Plays the customer + provider side of a checkout, like
// Razorpay's window would. It doesn't confirm anything itself: on success
// it returns a signed checkout response, and the browser then calls the same
// /payments/verify endpoint real payments use.
module.exports.demoPay = async (req, res) => {
  if (paymentsMode() !== "demo") throw new ExpressError(404, "Page Not Found");
  // Only the owner of the booking behind this order may "pay" for it.
  const payment = await Payment.findOne({ orderId: req.params.orderId, user: req.user._id });
  if (!payment) throw new ExpressError(404, "Order not found.", "ORDER_NOT_FOUND");
  const outcome = req.body && req.body.outcome === "declined" ? "declined" : "success";
  const result = await simulateCheckout({ orderId: payment.orderId, outcome, keySecret: getSettings().keySecret });
  if (outcome === "declined") {
    return res.status(402).json({ success: false, code: "DEMO_DECLINED", message: result.payment.error_description });
  }
  res.json({ success: true, demo: true, ...result.checkoutResponse });
};

// POST /api/v1/webhooks/razorpay  (mounted with express.raw in app.js)
module.exports.webhook = async (req, res) => {
  requirePayments();
  const result = await handleWebhook({ rawBody: req.body, headers: req.headers });
  // 2xx tells Razorpay to stop retrying this delivery.
  res.json({ success: true, ...result });
};
