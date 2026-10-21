// Runs expireStaleHolds() periodically. Uses a setTimeout chain rather than
// setInterval so a slow run never overlaps the next one in the same process.
// Overlap ACROSS processes (several web instances, or web + worker.js) is fine:
// every expiry is a guarded transition, so duplicates are no-ops.
//
// Why a polling worker instead of a job queue (BullMQ/Redis) here? The work
// is "find rows past a deadline and move them", the deadline is already in
// MongoDB, and the database is the source of truth. If a worker crashes,
// nothing is lost: the next run finds the same rows. A queue would add Redis,
// and a delayed job that fires late or twice would still need the same guarded
// update. A queue becomes worthwhile for work with retries/backoff that isn't
// naturally a database query (emails, webhooks to third parties).
const { expireStaleHolds } = require("./lifecycle.js");

function startExpiryWorker({ intervalMs = 30_000, logger = console } = {}) {
  let timer = null;
  let running = null;
  let stopped = false;

  async function tick() {
    try {
      const result = await expireStaleHolds();
      if (result.expired > 0) logger.log(`[expiry] expired ${result.expired} unpaid hold(s)`);
    } catch (err) {
      logger.error("[expiry] run failed:", err.message);
    }
  }

  function schedule() {
    if (stopped) return;
    timer = setTimeout(async () => {
      running = tick();
      await running;
      running = null;
      schedule();
    }, intervalMs);
    timer.unref(); // never keeps the process alive on its own
  }

  schedule();

  return {
    // Resolves once any in-flight run has finished, for graceful shutdown.
    async stop() {
      stopped = true;
      clearTimeout(timer);
      if (running) await running;
    },
  };
}

module.exports = { startExpiryWorker };
