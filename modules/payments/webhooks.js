// Razorpay webhook processing. Delivery is at-least-once and not ordered:
// the same event may arrive twice (even concurrently), and payment.authorized
// may arrive after payment.captured. Handling that is the job of the handlers
// (idempotent, never move backwards); the event log just avoids redoing work.
const crypto = require("crypto");
const Payment = require("../../models/payment.js");
const Refund = require("../../models/refund.js");
const WebhookEvent = require("../../models/webhookEvent.js");
const ExpressError = require("../../utils/ExpressError.js");
const { getSettings } = require("./gateway.js");
const { verifyWebhookSignature } = require("./signatures.js");
const { applyGatewayPayment } = require("./service.js");
const { applyGatewayRefund } = require("./refunds.js");

async function handlePaymentEntity(entity) {
  if (!entity || !entity.order_id) return "IGNORED";
  const payment = await Payment.findOne({ orderId: entity.order_id });
  if (!payment) return "UNKNOWN_ORDER"; // not ours (e.g. another app on the same account)
  return applyGatewayPayment(payment, entity);
}

async function handleRefundEntity(entity) {
  if (!entity) return "IGNORED";
  // By Razorpay id, or by our receipt if the worker crashed before saving the id.
  const refund =
    (await Refund.findOne({ razorpayRefundId: entity.id })) ||
    (entity.receipt ? await Refund.findOne({ receipt: entity.receipt }) : null);
  if (!refund) return "UNKNOWN_REFUND";
  return applyGatewayRefund(refund, entity);
}

async function dispatch(event) {
  const payload = event.payload || {};
  const entity = (key) => payload[key] && payload[key].entity;
  switch (event.event) {
    case "payment.authorized":
    case "payment.captured":
    case "payment.failed":
    case "order.paid": // carries the captured payment too
      return handlePaymentEntity(entity("payment"));
    case "refund.created":
    case "refund.processed":
    case "refund.failed":
      return handleRefundEntity(entity("refund"));
    default:
      return "IGNORED"; // subscribed to more than we need; acknowledge
  }
}

/**
 * @param {Buffer} rawBody   exact bytes received
 * @param {object} headers   lower-cased request headers
 * @returns {{ status: string, result?: string }}
 */
async function handleWebhook({ rawBody, headers }) {
  const { webhookSecret } = getSettings();
  if (!webhookSecret) throw new ExpressError(503, "Webhooks are not configured.", "WEBHOOK_NOT_CONFIGURED");

  if (!verifyWebhookSignature({ rawBody, signature: headers["x-razorpay-signature"], webhookSecret })) {
    console.warn("[webhooks] rejected delivery with invalid signature");
    throw new ExpressError(400, "Invalid signature.", "SIGNATURE_INVALID");
  }

  // Parse only AFTER verifying, and only the bytes that were verified.
  const event = JSON.parse(rawBody.toString("utf8"));
  const eventId = headers["x-razorpay-event-id"] || `sha256:${crypto.createHash("sha256").update(rawBody).digest("hex")}`;

  const record = await WebhookEvent.findOneAndUpdate(
    { eventId },
    { $setOnInsert: { eventId, event: event.event, status: "RECEIVED", receivedAt: new Date() }, $inc: { deliveries: 1 } },
    { upsert: true, new: true },
  ).catch(async (err) => {
    if (err.code === 11000) return WebhookEvent.findOne({ eventId }); // concurrent first delivery
    throw err;
  });
  if (record.status === "PROCESSED") return { status: "DUPLICATE" };

  try {
    const result = await dispatch(event);
    await WebhookEvent.updateOne({ eventId }, { $set: { status: "PROCESSED", processedAt: new Date() }, $unset: { lastError: "" } });
    return { status: "PROCESSED", result };
  } catch (err) {
    // Recorded and re-thrown: we answer 5xx so Razorpay retries later.
    await WebhookEvent.updateOne({ eventId }, { $set: { status: "FAILED", lastError: err.message } });
    throw err;
  }
}

module.exports = { handleWebhook };
