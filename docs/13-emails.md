# 13. Booking emails

Guests get an email when something happens to their booking:

| Event | When | Says |
|---|---|---|
| `booking_confirmed` | payment verified, or an instant booking when payments are off | stay, dates, total, free-cancellation rule, link to **Plan my arrival day** |
| `booking_cancelled` | an unpaid booking is cancelled | not charged |
| `refund_started` | a paid booking is cancelled (or a late payment can't be honoured) | full refund started, 5–7 working days |
| `refund_completed` | the payment provider confirms the refund | refund processed |
| `refund_delayed` | the automatic refund failed for good | we've been alerted; how to reach us |
| `hold_expired` | an unpaid hold runs out | dates released, not charged |

A hold doesn't get an email, because the guest is on the payment page at that moment. In DEMO payment mode every email says no real money moved.

## How it works: a transactional outbox (same pattern as refunds)

1. **Queue.** Every booking status change goes through `applyTransition()` (`modules/bookings/stateMachine.js`), inside a MongoDB transaction. The email is queued **in that same transaction**, as a row in `emailoutboxes` with the id `<bookingId>:<event>`.
   - If the transaction rolls back (e.g. sold out), no email row exists.
   - If it commits, the email can't be lost, even if the server crashes right after.
   - The id makes each event emailed **at most once per booking**, even when transitions are retried or workers race.
2. **Send.** The `emails` background job claims due rows with a **lease**, sends them over SMTP, and marks them `SENT`.
   - **Failure:** it retries after 1, 5, 30 and 120 minutes, then marks the row `GAVE_UP` after 5 attempts and reports the error.
   - **SMTP not configured:** rows are marked `SKIPPED` instead of piling up.
3. **At-least-once.** If the process dies after Gmail accepted a message but before the row was marked `SENT`, the lease expires and the email is sent again. A rare duplicate is better than a lost confirmation.
4. **Never on the request path.** A slow or down mail server can't slow a booking.

Templates are in `modules/notifications/templates.js` (plain text plus simple HTML). Listing titles and usernames come from users, so the HTML is escaped.

## Setup (Gmail)

1. **Turn on 2-step verification:** Google Account → **Security** → **2-Step Verification**.
2. **Create an app password:** Google Account → **Security** → **App passwords**, name it `TravelByChance`, and copy the 16-character password. This is **not** your Gmail password, and it can be revoked any time.
3. **Set the environment variables:** locally in `.env`, and on Render under **Environment**:
   ```
   SMTP_USER=you@gmail.com
   SMTP_PASS=<the app password>
   MAIL_FROM=TravelByChance <you@gmail.com>
   PUBLIC_URL=https://travel-by-chance-main.onrender.com   (locally: http://localhost:8080)
   ```
4. **Check it's on:** after a restart, the log says `booking emails: on (SMTP)`.

Gmail allows about 500 emails a day, which is plenty for a portfolio site. A real business would use a transactional email service with its own domain (SPF/DKIM) so emails don't land in spam.

## Tests

`test/emails.test.js` (7) covers:
- an instant booking: the email is queued with the booking and sent once, with the right details and escaped HTML;
- the paid lifecycle: confirmed → refund started → refunded, one email each;
- a hold expiring: one "not charged" email;
- **a rolled-back change sends nothing**;
- SMTP failures: retried with backoff, then given up;
- no SMTP settings: emails skipped;
- every template.
