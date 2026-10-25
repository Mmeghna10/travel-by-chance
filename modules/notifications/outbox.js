// Booking emails through a transactional outbox (same pattern as refunds):
//
//   enqueue  - inside the booking's transaction, one row per (booking, event)
//   send     - a background job claims due rows with a lease, sends, marks SENT;
//              on failure retries with backoff, and gives up after MAX_ATTEMPTS
//
// Delivery is at-least-once: if the process dies after the mail server
// accepted a message but before the row is marked SENT, the lease expires and
// it's sent again. A rare duplicate email beats a lost one.
const EmailOutbox = require("../../models/emailOutbox.js");
const Booking = require("../../models/booking.js");
const { getMail, mailEnabled } = require("./mailer.js");
const { buildEmail } = require("./templates.js");
const { paymentsMode } = require("../payments/gateway.js");
const { logger } = require("../observability/logger.js");
const { reportError } = require("../observability/errors.js");

const MAX_ATTEMPTS = 5;
const LEASE_MS = 2 * 60_000;
const BACKOFF_MINUTES = [1, 5, 30, 120];

// Which booking status changes are emailed.
const EVENT_FOR_STATUS = {
  CONFIRMED: "booking_confirmed",
  CANCELLED: "booking_cancelled",
  REFUND_PENDING: "refund_started",
  REFUNDED: "refund_completed",
  REFUND_FAILED: "refund_delayed",
  EXPIRED: "hold_expired",
};

/** Queue an email inside the caller's transaction (no-op for un-emailed statuses). */
async function enqueueForStatus({ bookingId, status, session, now = new Date() }) {
  const event = EVENT_FOR_STATUS[status];
  if (!event) return;
  await EmailOutbox.updateOne(
    { _id: `${bookingId}:${event}` },
    { $setOnInsert: { booking: bookingId, event, status: "PENDING", attempts: 0, createdAt: now } },
    { upsert: true, session },
  );
}

async function settle(row, update) {
  await EmailOutbox.updateOne({ _id: row._id, status: "SENDING" }, update);
}

async function sendOne(row, now) {
  if (!mailEnabled()) {
    await settle(row, { $set: { status: "SKIPPED", lastError: "mail not configured" }, $unset: { lockedUntil: "" } });
    return "SKIPPED";
  }
  const booking = await Booking.findById(row.booking).populate("listing").populate("user", "username email");
  if (!booking || !booking.listing || !booking.user || !booking.user.email) {
    await settle(row, { $set: { status: "SKIPPED", lastError: "booking, listing or email missing" }, $unset: { lockedUntil: "" } });
    return "SKIPPED";
  }
  const { transport, from, publicUrl } = getMail();
  try {
    const msg = buildEmail({ event: row.event, booking, listing: booking.listing, user: booking.user, publicUrl, demo: paymentsMode() === "demo" });
    await transport.sendMail({ from, to: booking.user.email, subject: msg.subject, text: msg.text, html: msg.html });
    await settle(row, { $set: { status: "SENT", sentAt: now }, $unset: { lockedUntil: "", lastError: "" } });
    return "SENT";
  } catch (err) {
    const message = String(err.message || err).slice(0, 300);
    if (row.attempts >= MAX_ATTEMPTS) {
      await settle(row, { $set: { status: "GAVE_UP", lastError: message }, $unset: { lockedUntil: "" } });
      reportError(err, { message: "booking email gave up", emailId: row._id });
      return "GAVE_UP";
    }
    const wait = BACKOFF_MINUTES[Math.min(row.attempts - 1, BACKOFF_MINUTES.length - 1)] * 60_000;
    await settle(row, { $set: { status: "PENDING", lastError: message, nextAttemptAt: new Date(now.getTime() + wait) }, $unset: { lockedUntil: "" } });
    logger.warn({ emailId: row._id, attempts: row.attempts, err: message }, "booking email failed; will retry");
    return "RETRY";
  }
}

/** One worker pass. Returns counts per outcome. */
async function processEmailQueue({ now = new Date(), limit = 20 } = {}) {
  const counts = { SENT: 0, RETRY: 0, GAVE_UP: 0, SKIPPED: 0 };
  for (let i = 0; i < limit; i++) {
    // Claim with a lease; a worker that dies mid-send leaves a lease that expires.
    const row = await EmailOutbox.findOneAndUpdate(
      {
        $or: [
          { status: "PENDING", $or: [{ nextAttemptAt: { $exists: false } }, { nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }] },
          { status: "SENDING", lockedUntil: { $lte: now } },
        ],
      },
      { $set: { status: "SENDING", lockedUntil: new Date(now.getTime() + LEASE_MS) }, $inc: { attempts: 1 } },
      { new: true, sort: { createdAt: 1 } },
    );
    if (!row) break;
    counts[await sendOne(row, now)]++;
  }
  return counts;
}

module.exports = { enqueueForStatus, processEmailQueue, EVENT_FOR_STATUS, MAX_ATTEMPTS };
