// Contact and policy pages. A live payment account (Razorpay) is only
// activated for a website that shows these, and guests should be able to read
// the cancellation rules before they pay. The text describes what the code
// actually does (hold times, who can cancel, how refunds work).
const express = require("express");
const router = express.Router();

const LAST_UPDATED = "22 October 2026";

const pages = {
  "/terms": { view: "pages/terms.ejs", title: "Terms of Service" },
  "/privacy": { view: "pages/privacy.ejs", title: "Privacy Policy" },
  "/refund-policy": { view: "pages/refund-policy.ejs", title: "Cancellation & Refund Policy" },
  "/delivery-policy": { view: "pages/delivery-policy.ejs", title: "Service Delivery Policy" },
  "/contact": { view: "pages/contact.ejs", title: "Contact Us" },
};

for (const [path, { view, title }] of Object.entries(pages)) {
  router.get(path, (req, res) => {
    const { holdMinutes = 15 } = req.app.get("bookingOptions") || {};
    res.render(view, { title, lastUpdated: LAST_UPDATED, holdMinutes });
  });
}

module.exports = router;
