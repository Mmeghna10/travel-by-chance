// The text of each booking email: plain text plus simple HTML. Listing
// titles and usernames come from users, so everything is HTML-escaped.
const { formatPaise } = require("../bookings/pricing.js");

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const day = (d) => new Date(d).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

function stay(booking, listing) {
  const nights = booking.nights || Math.round((booking.checkOut - booking.checkIn) / 86_400_000);
  return [
    `${listing.title}, ${listing.location}`,
    `${day(booking.checkIn)} → ${day(booking.checkOut)} (${nights} ${nights === 1 ? "night" : "nights"})`,
    `Check-in from ${listing.checkInTime || "12:00"}`,
  ];
}

const amount = (booking) => (booking.amountPaise ? formatPaise(booking.amountPaise) : `₹${booking.totalPrice}`);

/**
 * @returns {{ subject: string, text: string, html: string }}
 */
function buildEmail({ event, booking, listing, user, publicUrl, demo = false }) {
  const ref = String(booking._id).slice(-8).toUpperCase();
  const bookingsUrl = `${publicUrl}/bookings`;
  const planUrl = `${publicUrl}/bookings/${booking._id}/plan`;
  const demoNote = demo ? "This site runs in DEMO payment mode: no real money was charged or refunded." : null;
  const content = {
    booking_confirmed: {
      subject: `Booking confirmed: ${listing.title}`,
      lines: [
        "Your stay is confirmed.",
        ...stay(booking, listing),
        `Total: ${amount(booking)}`,
        "Free cancellation until your check-in date (full refund).",
        `Plan your arrival day: ${planUrl}`,
      ],
    },
    booking_cancelled: {
      subject: `Booking cancelled: ${listing.title}`,
      lines: ["Your booking has been cancelled. You weren't charged.", ...stay(booking, listing)],
    },
    refund_started: {
      subject: `Refund on its way: ${listing.title}`,
      lines: [
        `We've started a full refund of ${amount(booking)} to your original payment method.`,
        ...stay(booking, listing),
        "Banks usually take 5-7 working days to show it. We'll email you when the payment provider confirms it.",
      ],
    },
    refund_completed: {
      subject: `Refund processed: ${listing.title}`,
      lines: [`Your refund of ${amount(booking)} has been processed by our payment provider.`, ...stay(booking, listing)],
    },
    refund_delayed: {
      subject: `Your refund needs a moment: ${listing.title}`,
      lines: [
        `The automatic refund of ${amount(booking)} didn't go through. We've been alerted and will sort it out.`,
        `If you don't hear from us within 2 working days, please reply to this email or use ${publicUrl}/contact.`,
      ],
    },
    hold_expired: {
      subject: `Your hold expired: ${listing.title}`,
      lines: [
        "We held your dates while you paid, but the payment wasn't completed in time, so the hold was released. You weren't charged.",
        ...stay(booking, listing),
        `Book again: ${publicUrl}/listings/${listing._id}`,
      ],
    },
  }[event];
  if (!content) throw new Error(`Unknown email event ${event}`);

  const lines = [`Hi ${user.username},`, "", ...content.lines, "", `Booking reference: ${ref}`, `Your bookings: ${bookingsUrl}`];
  if (demoNote) lines.push("", demoNote);
  lines.push("", "TravelByChance");
  const text = lines.join("\n");
  const linkify = (line) => esc(line).replace(/https?:\/\/[^\s<]+/g, (u) => `<a href="${u}">${u}</a>`);
  const html = `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#2b2118">${lines
    .map((l) => (l ? `<p style="margin:0 0 6px">${linkify(l)}</p>` : "<br>"))
    .join("")}</div>`;
  return { subject: content.subject, text, html };
}

module.exports = { buildEmail, esc };
