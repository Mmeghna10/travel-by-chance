// DEMO payment gateway: a stand-in for Razorpay so the full payment flow can
// be shown without a Razorpay account. NO real gateway is contacted and NO
// money moves; every screen that uses it says so.
//
// It implements the same interface as the real gateway (gateway.js), so the
// rest of the app runs its REAL payment code unchanged: order creation,
// HMAC signature verification, "fetch the payment and check it's captured
// with the right amount", guarded booking confirmation, the refund outbox
// and the reconciliation job. Only the provider's side is simulated.
//
// Provider-side records live in MongoDB (not memory) so the web process and
// the worker see the same "provider" and nothing is lost on restart.
const crypto = require("crypto");
const mongoose = require("mongoose");
const { hmacHex } = require("./signatures.js");

const demoRecordSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ["order", "payment", "refund"], required: true },
    id: { type: String, required: true }, // order_demo_..., pay_demo_..., rfnd_demo_...
    entity: { type: mongoose.Schema.Types.Mixed, required: true }, // Razorpay-shaped object
    ref: String, // order id for payments, payment id for refunds
  },
  { timestamps: true },
);
demoRecordSchema.index({ id: 1 }, { unique: true });
demoRecordSchema.index({ kind: 1, ref: 1 });
const DemoRecord = mongoose.models.DemoGatewayRecord || mongoose.model("DemoGatewayRecord", demoRecordSchema, "demogatewayrecords");

const newId = (prefix) => `${prefix}_demo_${crypto.randomBytes(7).toString("hex")}`;
const plain = (doc) => (doc ? JSON.parse(JSON.stringify(doc.entity)) : null);

function notFound(what) {
  return Object.assign(new Error(`The ${what} does not exist`), { statusCode: 400, error: { description: `The ${what} does not exist` } });
}

function createDemoGateway() {
  return {
    async createOrder({ amount, currency, receipt, notes }) {
      const order = { id: newId("order"), entity: "order", amount, currency, receipt, notes, status: "created" };
      await DemoRecord.create({ kind: "order", id: order.id, entity: order });
      return order;
    },
    async fetchPayment(paymentId) {
      const doc = await DemoRecord.findOne({ kind: "payment", id: paymentId });
      if (!doc) throw notFound("payment");
      return plain(doc);
    },
    async fetchOrderPayments(orderId) {
      return (await DemoRecord.find({ kind: "payment", ref: orderId }).sort({ createdAt: 1 })).map(plain);
    },
    async createRefund(paymentId, { amount, receipt, notes }) {
      if (!(await DemoRecord.exists({ kind: "payment", id: paymentId }))) throw notFound("payment");
      const refund = { id: newId("rfnd"), entity: "refund", payment_id: paymentId, amount, currency: "INR", receipt, notes, status: "processed" };
      await DemoRecord.create({ kind: "refund", id: refund.id, ref: paymentId, entity: refund });
      return refund;
    },
    async fetchRefunds(paymentId) {
      return (await DemoRecord.find({ kind: "refund", ref: paymentId })).map(plain);
    },
    async fetchRefund(paymentId, refundId) {
      const doc = await DemoRecord.findOne({ kind: "refund", id: refundId, ref: paymentId });
      if (!doc) throw notFound("refund");
      return plain(doc);
    },
  };
}

/**
 * Plays the customer + provider side of a checkout: records a payment against
 * the demo order and, for a success, returns exactly what Razorpay Checkout
 * hands the browser (order id, payment id, HMAC signature with the key secret).
 *   outcome "success"  -> captured payment + signed checkout response
 *   outcome "declined" -> failed payment (no signature, like a real decline)
 */
async function simulateCheckout({ orderId, outcome, keySecret }) {
  const orderDoc = await DemoRecord.findOne({ kind: "order", id: orderId });
  if (!orderDoc) throw notFound("order");
  const order = orderDoc.entity;
  const succeeded = outcome === "success";
  const payment = {
    id: newId("pay"),
    entity: "payment",
    order_id: orderId,
    amount: order.amount,
    currency: order.currency,
    status: succeeded ? "captured" : "failed",
    captured: succeeded,
    method: "demo",
    error_code: succeeded ? null : "BAD_REQUEST_ERROR",
    error_description: succeeded ? null : "Demo: card declined (simulated)",
  };
  await DemoRecord.create({ kind: "payment", id: payment.id, ref: orderId, entity: payment });
  if (succeeded) {
    await DemoRecord.updateOne({ kind: "order", id: orderId }, { $set: { "entity.status": "paid" } });
  }
  return {
    payment,
    checkoutResponse: succeeded
      ? { razorpay_order_id: orderId, razorpay_payment_id: payment.id, razorpay_signature: hmacHex(keySecret, `${orderId}|${payment.id}`) }
      : null,
  };
}

// The demo "key secret" is derived from the app's SECRET, so it's stable
// across processes and restarts without another setting to manage.
function demoKeySecret(appSecret) {
  return hmacHex(appSecret, "travelbychance-demo-payment-gateway");
}

module.exports = { createDemoGateway, simulateCheckout, demoKeySecret, DemoRecord };
