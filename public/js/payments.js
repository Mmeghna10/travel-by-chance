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
    } catch (e) {
      // Non-JSON error page (e.g. a proxy 502): keep data = {}.
    }
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

  // What happens after a successful checkout, for Razorpay and demo alike:
  // hand the signed response to the server, which verifies it and confirms.
  async function finishPayment(bookingId, response, say) {
    say("Verifying payment…");
    let status = "PENDING_PAYMENT";
    try {
      const verified = await postJson("/api/v1/payments/verify", response);
      if (verified.ok) status = verified.body.bookingStatus;
    } catch (e) {
      // Fine: the webhook / reconciliation will still confirm it.
    }
    // Capture can lag a moment behind checkout; give it a few seconds so
    // My Bookings shows the final status. We go there either way.
    if (status === "PENDING_PAYMENT") await waitForBooking(bookingId);
    window.location.href = "/bookings";
  }

  function rupees(paise) {
    return "₹" + (paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 });
  }

  function el(tag, style, text) {
    const node = document.createElement(tag);
    if (style) node.style.cssText = style;
    if (text) node.textContent = text;
    return node;
  }

  // DEMO MODE checkout window. Clearly labelled; no real gateway, no money.
  // Each button plays a different customer outcome; the server does the rest
  // exactly as it would for Razorpay.
  function openDemoCheckout(o, bookingId, say) {
    const overlay = el("div", "position:fixed;inset:0;background:rgba(20,12,6,.55);z-index:2000;display:flex;align-items:center;justify-content:center;padding:16px;");
    const box = el("div", "background:#fff;border-radius:16px;max-width:420px;width:100%;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.35);font-family:inherit;");
    const banner = el("div", "background:#fef3c7;color:#92400e;border-bottom:2px dashed #f59e0b;padding:10px 16px;font-weight:800;font-size:.85rem;letter-spacing:.04em;text-align:center;", "DEMO PAYMENT · NO REAL MONEY · NO REAL GATEWAY");
    const body = el("div", "padding:20px;");
    body.append(
      el("div", "font-size:.8rem;color:#78716c;margin-bottom:4px;", "TravelByChance · stay booking"),
      el("div", "font-size:1.8rem;font-weight:800;margin-bottom:4px;", rupees(o.amount)),
      el("div", "font-size:.75rem;color:#a8a29e;margin-bottom:14px;word-break:break-all;", "Order " + o.orderId),
      el(
        "p",
        "font-size:.82rem;color:#57534e;line-height:1.5;margin:0 0 14px;",
        "This simulates Razorpay so you can see the full flow. Whatever you pick, the server runs its real payment code: it checks the signature, checks the payment is captured for the right amount, then confirms the booking.",
      ),
    );
    const timer = el("div", "font-size:.8rem;font-weight:700;color:#b45309;margin-bottom:14px;");
    const status = el("div", "font-size:.85rem;font-weight:600;min-height:1.2em;margin-bottom:10px;");
    const btn = (label, bg, fg) =>
      el("button", "display:block;width:100%;margin-bottom:8px;padding:11px 14px;border-radius:999px;border:1px solid #d6d3d1;font-weight:700;font-size:.88rem;cursor:pointer;background:" + bg + ";color:" + fg + ";", label);
    const pay = btn("Pay " + rupees(o.amount) + " (simulate success)", "#5D2C0C", "#fff");
    const decline = btn("Simulate card declined", "#fff", "#b91c1c");
    const payClose = btn("Pay, then close the window (recovery demo)", "#fff", "#1c1917");
    const cancel = btn("Cancel", "#fff", "#57534e");
    body.append(timer, status, pay, decline, payClose, cancel);
    box.append(banner, body);
    overlay.append(box);
    document.body.append(overlay);

    const tick = () => {
      const s = Math.max(0, Math.floor((new Date(o.expiresAt).getTime() - Date.now()) / 1000));
      timer.textContent = s > 0 ? "Dates held for " + Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0") : "Hold expired; a late payment will be re-checked or refunded";
    };
    tick();
    const interval = setInterval(tick, 1000);
    const close = () => {
      clearInterval(interval);
      overlay.remove();
    };
    const busy = (on) => [pay, decline, payClose, cancel].forEach((b) => (b.disabled = on));

    async function simulate(outcome) {
      busy(true);
      status.style.color = "#57534e";
      status.textContent = "Simulating payment…";
      const res = await postJson("/api/v1/demo-payments/" + encodeURIComponent(o.orderId) + "/pay", { outcome });
      busy(false);
      return res;
    }

    pay.onclick = async () => {
      const res = await simulate("success");
      if (!res.ok) {
        status.style.color = "#b91c1c";
        status.textContent = res.body.message || "Demo payment failed.";
        return;
      }
      busy(true);
      status.textContent = "Payment captured (demo). Verifying on the server…";
      await finishPayment(bookingId, res.body, say);
    };
    decline.onclick = async () => {
      const res = await simulate("declined");
      status.style.color = "#b91c1c";
      status.textContent = (res.body.message || "Declined (demo).") + " You can try again.";
    };
    payClose.onclick = async () => {
      const res = await simulate("success");
      if (!res.ok) {
        status.style.color = "#b91c1c";
        status.textContent = res.body.message || "Demo payment failed.";
        return;
      }
      // Deliberately do NOT tell the server: like a customer who paid and
      // closed the tab. The reconciliation job will find the payment.
      close();
      say("Paid (demo), and the window closed before confirming. The server's reconciliation job will confirm it within about 1–2 minutes; check My Bookings.");
    };
    cancel.onclick = () => {
      close();
      say("Payment not completed. Your dates stay held until the timer runs out; you can pay from My Bookings.");
    };
  }

  window.payForBooking = async function (bookingId, onStatus) {
    const say = onStatus || function () {};
    say("Preparing payment…");
    const order = await postJson("/api/v1/bookings/" + bookingId + "/payment-order");
    if (!order.ok) {
      alert(order.body.message || "Could not start the payment.");
      if (order.body.code === "HOLD_EXPIRED" || order.body.code === "ALREADY_PAID") window.location.href = "/bookings";
      return;
    }
    const o = order.body;
    if (o.mode === "demo") return openDemoCheckout(o, bookingId, say);
    if (typeof Razorpay === "undefined") {
      alert("The payment window could not be loaded. Please check your connection and try again from My Bookings.");
      return;
    }
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
      handler: function (response) {
        return finishPayment(bookingId, response, say);
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
