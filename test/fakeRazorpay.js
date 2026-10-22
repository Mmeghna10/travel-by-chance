// In-memory stand-in for Razorpay's API, implementing the same gateway
// interface as modules/payments/gateway.js. Signatures are REAL HMACs (same
// algorithm and secrets as production), so signature checks are tested for
// real; only the network is simulated. Test helpers (pay, webhook, ...) play
// the customer's and Razorpay's side.
const crypto = require("crypto");

const hmac = (secret, msg) => crypto.createHmac("sha256", secret).update(msg).digest("hex");
const copy = (o) => JSON.parse(JSON.stringify(o));

class FakeRazorpay {
  constructor({ keySecret, webhookSecret }) {
    this.keySecret = keySecret;
    this.webhookSecret = webhookSecret;
    this.orders = new Map();
    this.payments = new Map();
    this.refunds = new Map();
    this.calls = { createOrder: 0, createRefund: 0 };
    this.failures = {}; // method -> [Error, ...] thrown on the next calls
    this.refundStatus = "processed"; // what new refunds start as
    this.loseResponseAfterRefund = false; // refund created, then the HTTP response is lost
    this.latencyMs = 0; // simulated network round-trip for every call
    this.seq = 0;
  }

  id(prefix) {
    return `${prefix}_T${String(++this.seq).padStart(12, "0")}`;
  }

  failNext(method, error, times = 1) {
    this.failures[method] = Array.from({ length: times }, () => error);
  }

  async maybeFail(method) {
    // Yield like a real network call, so concurrent callers interleave.
    await new Promise((r) => (this.latencyMs ? setTimeout(r, this.latencyMs) : setImmediate(r)));
    const queue = this.failures[method];
    if (queue && queue.length) throw queue.shift();
  }

  // ---- gateway interface ----
  async createOrder({ amount, currency, receipt, notes }) {
    this.calls.createOrder++;
    await this.maybeFail("createOrder");
    const order = { id: this.id("order"), entity: "order", amount, currency, receipt, notes, status: "created" };
    this.orders.set(order.id, order);
    return copy(order);
  }

  async fetchPayment(paymentId) {
    await this.maybeFail("fetchPayment");
    const p = this.payments.get(paymentId);
    if (!p) throw Object.assign(new Error("The id provided does not exist"), { statusCode: 400 });
    return copy(p);
  }

  async fetchOrderPayments(orderId) {
    await this.maybeFail("fetchOrderPayments");
    return [...this.payments.values()].filter((p) => p.order_id === orderId).map(copy);
  }

  async createRefund(paymentId, { amount, receipt, notes }) {
    this.calls.createRefund++;
    await this.maybeFail("createRefund");
    const refund = { id: this.id("rfnd"), entity: "refund", payment_id: paymentId, amount, currency: "INR", receipt, notes, status: this.refundStatus };
    this.refunds.set(refund.id, refund);
    if (this.loseResponseAfterRefund) {
      this.loseResponseAfterRefund = false;
      throw new Error("socket hang up"); // Razorpay did it; we just never heard back
    }
    return copy(refund);
  }

  async fetchRefunds(paymentId) {
    await this.maybeFail("fetchRefunds");
    return [...this.refunds.values()].filter((r) => r.payment_id === paymentId).map(copy);
  }

  async fetchRefund(paymentId, refundId) {
    await this.maybeFail("fetchRefund");
    return copy(this.refunds.get(refundId));
  }

  // ---- customer / Razorpay side ----

  /** The customer pays against an order. Returns the payment entity. */
  pay(orderId, { status = "captured", amount, currency } = {}) {
    const order = this.orders.get(orderId);
    const payment = {
      id: this.id("pay"),
      entity: "payment",
      order_id: orderId,
      amount: amount ?? order.amount,
      currency: currency ?? order.currency,
      status,
      captured: status === "captured",
      method: "card",
      error_code: status === "failed" ? "BAD_REQUEST_ERROR" : null,
      error_description: status === "failed" ? "Your payment has been declined by the bank" : null,
    };
    this.payments.set(payment.id, payment);
    if (status === "captured") order.status = "paid";
    return copy(payment);
  }

  /** Auto-capture of an authorized payment. */
  capture(paymentId) {
    const p = this.payments.get(paymentId);
    p.status = "captured";
    p.captured = true;
    this.orders.get(p.order_id).status = "paid";
    return copy(p);
  }

  setRefundStatus(refundId, status) {
    this.refunds.get(refundId).status = status;
    return copy(this.refunds.get(refundId));
  }

  /** What Checkout's handler receives after a successful payment. */
  checkoutResponse(orderId, paymentId, secret = this.keySecret) {
    return { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: hmac(secret, `${orderId}|${paymentId}`) };
  }

  /** A signed webhook delivery: { body (Buffer), headers }. */
  webhook(event, entities, { eventId = this.id("evt"), secret = this.webhookSecret } = {}) {
    const json = JSON.stringify({
      entity: "event",
      event,
      contains: Object.keys(entities),
      payload: Object.fromEntries(Object.entries(entities).map(([k, v]) => [k, { entity: v }])),
      created_at: Math.floor(Date.now() / 1000),
    });
    const body = Buffer.from(json);
    return {
      body,
      headers: { "content-type": "application/json", "x-razorpay-signature": hmac(secret, body), "x-razorpay-event-id": eventId },
    };
  }
}

module.exports = { FakeRazorpay, hmac };
