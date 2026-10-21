// Opens Razorpay Checkout for a booking hold. The browser's job is only to
// collect the payment and pass Razorpay's response to our server; the server
// verifies the signature and asks Razorpay for the real payment status before
// confirming anything. If this script never reports back (tab closed, network
// drop), the webhook or the reconciliation job confirms the booking anyway.
(function () {
  async function postJson(url, body) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body || {}),
    });
    let data = {};
    try {
      data = await res.json();
    } catch (e) {}
    return { ok: res.ok, status: res.status, body: data };
  }

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // After a successful checkout the capture may still be in flight
  // (authorized -> captured). Poll briefly for the final booking status.
  async function waitForBooking(bookingId) {
    for (let i = 0; i < 10; i++) {
      const res = await fetch("/api/v1/bookings/" + bookingId, { headers: { Accept: "application/json" } });
      const data = await res.json();
      if (data.booking && data.booking.status !== "PENDING_PAYMENT") return data.booking.status;
      await wait(2000);
    }
    return "PENDING_PAYMENT";
  }

  window.payForBooking = async function (bookingId, onStatus) {
    const say = onStatus || function () {};
    if (typeof Razorpay === "undefined") {
      alert("The payment window could not be loaded. Please check your connection and try again from My Bookings.");
      return;
    }
    say("Preparing payment…");
    const order = await postJson("/api/v1/bookings/" + bookingId + "/payment-order");
    if (!order.ok) {
      alert(order.body.message || "Could not start the payment.");
      if (order.body.code === "HOLD_EXPIRED" || order.body.code === "ALREADY_PAID") window.location.href = "/bookings";
      return;
    }
    const o = order.body;
    const secondsLeft = Math.floor((new Date(o.expiresAt).getTime() - Date.now()) / 1000);

    const rzp = new Razorpay({
      key: o.keyId, // publishable key id only; the secret never leaves the server
      amount: o.amount,
      currency: o.currency,
      order_id: o.orderId,
      name: "TravelByChance",
      description: "Stay booking",
      prefill: o.prefill,
      timeout: Math.max(60, secondsLeft), // don't let checkout outlive the hold by much
      retry: { enabled: true, max_count: 4 },
      theme: { color: "#5D2C0C" },
      handler: async function (response) {
        say("Verifying payment…");
        let status = "PENDING_PAYMENT";
        try {
          const verified = await postJson("/api/v1/payments/verify", response);
          if (verified.ok) status = verified.body.bookingStatus;
        } catch (e) {
          // Fine: the webhook / reconciliation will still confirm it.
        }
        if (status === "PENDING_PAYMENT") status = await waitForBooking(bookingId);
        window.location.href = "/bookings";
      },
      modal: {
        ondismiss: function () {
          say("Payment not completed. Your dates stay held until the timer runs out; you can pay from My Bookings.");
        },
      },
    });
    rzp.on("payment.failed", function (resp) {
      // Checkout lets the customer retry in the same window.
      say("Payment failed: " + ((resp.error && resp.error.description) || "please try another method."));
    });
    rzp.open();
  };
})();
