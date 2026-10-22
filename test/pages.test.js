// Contact and policy pages, and what the booking box says in each payment mode.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { configurePayments } = require("../modules/payments/gateway.js");
const { FakeRazorpay } = require("./fakeRazorpay.js");
const h = require("./helpers.js");

let app;
let listing;
before(async () => {
  await h.startDb();
  app = h.buildApp({}, { holdMinutes: 12 }, {
    business: { name: "TBC Stays", email: "help@tbc.example", phone: "+91 98765 43210", address: "12 MG Road, Pune" },
  });
});
after(h.stopDb);
beforeEach(async () => {
  await h.resetDb();
  configurePayments({});
  listing = await h.createListing(await h.createUser("host", "admin"));
});

test("every policy page renders and links to the others", async () => {
  for (const [path, heading] of [
    ["/terms", "Terms of Service"],
    ["/privacy", "Privacy Policy"],
    ["/refund-policy", "Cancellation &amp; Refund Policy"],
    ["/delivery-policy", "Service Delivery Policy"],
    ["/contact", "Contact Us"],
  ]) {
    const res = await h.request(app).get(path);
    assert.equal(res.status, 200, path);
    assert.ok(res.text.includes(heading), `${path} has its heading`);
    for (const link of ["/terms", "/privacy", "/refund-policy", "/contact"]) {
      assert.ok(res.text.includes(`href="${link}"`), `${path} links to ${link}`);
    }
  }
});

test("pages use the configured business details and real hold time", async () => {
  const contact = await h.request(app).get("/contact");
  for (const s of ["help@tbc.example", "+91 98765 43210", "12 MG Road, Pune", "TBC Stays"]) assert.ok(contact.text.includes(s), s);
  const refunds = await h.request(app).get("/refund-policy");
  assert.ok(refunds.text.includes("12 minutes"), "hold time comes from the booking settings");
  const footer = (await h.request(app).get("/listings")).text;
  assert.ok(footer.includes("TBC Stays. All rights reserved."));
  assert.ok(!footer.includes("Pvt. Ltd."), "no made-up company name");
});

test("contact page without details says so instead of inventing them", async () => {
  const bare = h.buildApp();
  const res = await h.request(bare).get("/contact");
  assert.ok(res.text.includes("Contact details haven&#39;t been added") || res.text.includes("Contact details haven't been added"));
});

test("test keys: booking box says test mode; live keys: it doesn't", async () => {
  configurePayments({ keyId: "rzp_test_x", keySecret: "s", gateway: new FakeRazorpay({ keySecret: "s" }) });
  let page = (await h.request(app).get(`/listings/${listing._id}`)).text;
  assert.ok(page.includes("Test mode, no real money"));
  assert.ok(page.includes('href="/refund-policy"'), "refund policy linked before paying");

  configurePayments({ keyId: "rzp_live_x", keySecret: "s", allowLive: true, gateway: new FakeRazorpay({ keySecret: "s" }) });
  page = (await h.request(app).get(`/listings/${listing._id}`)).text;
  assert.ok(page.includes("Secure payment by Razorpay"));
  assert.ok(!page.includes("Test mode, no real money"), "never tell real payers it's a test");
  assert.ok(page.includes("checkout.razorpay.com/v1/checkout.js"));
});

test("live keys are still refused unless explicitly allowed", () => {
  assert.throws(() => configurePayments({ keyId: "rzp_live_x", keySecret: "s" }), /not a test key/);
});
