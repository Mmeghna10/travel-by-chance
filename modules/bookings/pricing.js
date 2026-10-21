// The single source of truth for what a stay costs. The browser never computes
// prices; it asks the quote endpoint, which calls this.
//
// Money is held in integer paise (1 rupee = 100 paise), the unit Razorpay uses,
// so we never accumulate floating-point errors like 0.1 + 0.2.
const CURRENCY = "INR";
// Business rule kept from the original app: both fees are a percentage of ONE
// night's rate, charged once per stay (not per night).
const CLEANING_FEE_RATE = 0.05;
const SERVICE_FEE_RATE = 0.12;

function toPaise(rupees) {
  return Math.round(rupees * 100);
}

function quote(nightlyRupees, nights) {
  if (!Number.isFinite(nightlyRupees) || nightlyRupees < 0) {
    throw new Error(`Invalid nightly price: ${nightlyRupees}`);
  }
  if (!Number.isInteger(nights) || nights < 1) {
    throw new Error(`Invalid number of nights: ${nights}`);
  }
  const nightlyPaise = toPaise(nightlyRupees);
  const subtotalPaise = nightlyPaise * nights;
  const cleaningFeePaise = Math.round(nightlyPaise * CLEANING_FEE_RATE);
  const serviceFeePaise = Math.round(nightlyPaise * SERVICE_FEE_RATE);
  return {
    currency: CURRENCY,
    nightlyPaise,
    nights,
    subtotalPaise,
    cleaningFeePaise,
    serviceFeePaise,
    totalPaise: subtotalPaise + cleaningFeePaise + serviceFeePaise,
  };
}

// For display only, e.g. 317050 -> "₹3,170.50"
function formatPaise(paise) {
  return "₹" + (paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

module.exports = { quote, toPaise, formatPaise, CURRENCY };
