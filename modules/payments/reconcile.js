// Reconciliation: periodically ask Razorpay what really happened, for the
// cases where neither the browser nor a webhook told us. For example: the
// customer paid and closed the tab, webhooks aren't configured (local dev),
// a webhook was lost, or we crashed between recording a capture and
// confirming the booking.
const Booking = require("../../models/booking.js");
const Payment = require("../../models/payment.js");
const Refund = require("../../models/refund.js");
const { confirmPayment } = require("../bookings/lifecycle.js");
const { getGateway } = require("./gateway.js");
const { applyGatewayPayment } = require("./service.js");
const { applyGatewayRefund } = require("./refunds.js");

const QUIET_MS = 60 * 1000; // give the browser/webhook a minute first
const RECHECK_MS = 2 * 60 * 1000; // per-payment polling interval
const LOOKBACK_MS = 4 * 24 * 60 * 60 * 1000; // Razorpay auto-refunds uncaptured payments after 3 days

async function reconcilePayments({ now = new Date(), limit = 50 } = {}) {
  const gateway = getGateway();
  const summary = { checked: 0, confirmed: 0, refundsChecked: 0, errors: 0 };

  // 1. Orders that aren't captured yet: did a payment succeed without us hearing?
  const open = await Payment.find({
    status: { $in: ["CREATED", "FAILED", "AUTHORIZED"] },
    orderId: { $exists: true },
    updatedAt: { $lte: new Date(now.getTime() - QUIET_MS) },
    createdAt: { $gte: new Date(now.getTime() - LOOKBACK_MS) },
    $or: [{ lastReconciledAt: { $exists: false } }, { lastReconciledAt: { $lte: new Date(now.getTime() - RECHECK_MS) } }],
  })
    .sort({ lastReconciledAt: 1 })
    .limit(limit);

  for (const payment of open) {
    summary.checked++;
    try {
      const attempts = await gateway.fetchOrderPayments(payment.orderId);
      // Captured first, so a captured attempt is never shadowed by a failed one.
      const rank = { captured: 0, refunded: 0, authorized: 1, failed: 2 };
      attempts.sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9));
      for (const entity of attempts) {
        const outcome = await applyGatewayPayment(payment, entity, { now });
        if (outcome.startsWith("CONFIRMED") || outcome === "REFUND_REQUIRED") summary.confirmed++;
        if (entity.status === "captured") break;
      }
      await Payment.updateOne({ _id: payment._id }, { $set: { lastReconciledAt: now } });
    } catch (err) {
      summary.errors++;
      console.error(`[reconcile] order ${payment.orderId}:`, err.message);
    }
  }

  // 2. Captured on our side but the booking never got confirmed (crash
  //    between the two steps). confirmPayment() is idempotent.
  const captured = await Payment.find({ status: "CAPTURED", updatedAt: { $lte: new Date(now.getTime() - QUIET_MS) } })
    .select("booking")
    .limit(500)
    .lean();
  if (captured.length) {
    const stuck = await Booking.find({
      _id: { $in: captured.map((p) => p.booking) },
      status: { $in: ["PENDING_PAYMENT", "EXPIRED", "CANCELLED"] },
      paidAt: { $exists: false },
    }).select("_id");
    for (const b of stuck) {
      try {
        await confirmPayment({ bookingId: b._id, now });
        summary.confirmed++;
      } catch (err) {
        summary.errors++;
        console.error(`[reconcile] booking ${b._id}:`, err.message);
      }
    }
  }

  // 3. Refunds accepted by Razorpay whose final outcome we haven't heard.
  const pendingRefunds = await Refund.find({
    status: "PENDING",
    razorpayRefundId: { $exists: true },
    updatedAt: { $lte: new Date(now.getTime() - RECHECK_MS) },
  }).limit(limit);
  for (const refund of pendingRefunds) {
    summary.refundsChecked++;
    try {
      await applyGatewayRefund(refund, await gateway.fetchRefund(refund.paymentId, refund.razorpayRefundId), { now });
    } catch (err) {
      summary.errors++;
      console.error(`[reconcile] refund ${refund.razorpayRefundId}:`, err.message);
    }
  }
  return summary;
}

module.exports = { reconcilePayments };
