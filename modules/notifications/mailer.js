// SMTP connection for booking emails (Gmail by default: smtp.gmail.com:465
// with an app password). Off when SMTP_USER / SMTP_PASS aren't set: emails
// are then marked SKIPPED instead of piling up.
const nodemailer = require("nodemailer");

let transport = null;
let from = null;
let publicUrl = "http://localhost:8080";

function configureMail({ host = "smtp.gmail.com", port = 465, user, pass, from: sender, siteUrl } = {}) {
  if (siteUrl) publicUrl = siteUrl.replace(/\/+$/, "");
  if (!user || !pass) {
    transport = null;
    return;
  }
  transport = nodemailer.createTransport({ host, port, secure: Number(port) === 465, auth: { user, pass } });
  from = sender || `TravelByChance <${user}>`;
}

/** For tests: use a fake transport ({ sendMail }) or null for "not configured". */
function setMailTransport(fake, sender = "TravelByChance <test@example.com>", siteUrl) {
  transport = fake;
  from = fake ? sender : null;
  if (siteUrl) publicUrl = siteUrl;
}

const mailEnabled = () => Boolean(transport);
const getMail = () => ({ transport, from, publicUrl });

module.exports = { configureMail, setMailTransport, mailEnabled, getMail };
