const ExpressError = require("../utils/ExpressError.js");
const { paymentsEnabled } = require("../modules/payments/gateway.js");
const paymentService = require("../modules/payments/service.js");
const { handleWebhook } = require("../modules/payments/webhooks.js");

function requirePayments() {
  if (!paymentsEnabled()) throw new ExpressError(503, "Online payment is not enabled.", "PAYMENTS_DISABLED");
}

// POST /api/v1/bookings/:id/payment-order
module.exports.createOrder = async (req, res) => {
  requirePayments();
  const order = await paymentService.createPaymentOrder({ bookingId: req.params.id, user: req.user });
  res.json({ success: true, ...order });
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

// POST /api/v1/webhooks/razorpay  (mounted with express.raw in app.js)
module.exports.webhook = async (req, res) => {
  requirePayments();
  const result = await handleWebhook({ rawBody: req.body, headers: req.headers });
  // 2xx tells Razorpay to stop retrying this delivery.
  res.json({ success: true, ...result });
};
