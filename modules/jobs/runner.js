// Runs the background jobs periodically. A setTimeout chain (not
// setInterval) means a slow pass never overlaps the next one in the same
// process. Overlap ACROSS processes (several web instances, or web +
// worker.js) is fine: every job is safe to run concurrently (guarded
// transitions, leases, idempotent handlers).
//
// Why polling instead of a job queue (BullMQ/Redis)? Each job is "find rows
// in MongoDB that need attention and act on them". The rows ARE the queue,
// they live in the source of truth, and a crashed worker loses nothing: the
// next pass finds the same rows. Retries with exponential backoff and a
// dead-letter state are implemented on the rows themselves (see
// modules/payments/refunds.js). A broker would add infrastructure without
// removing any of that logic.
const { expireStaleHolds } = require("../bookings/lifecycle.js");
const { paymentsEnabled } = require("../payments/gateway.js");
const { processRefundQueue } = require("../payments/refunds.js");
const { reconcilePayments } = require("../payments/reconcile.js");
const crypto = require("crypto");
const { logger: defaultLogger, withContext } = require("../observability/logger.js");
const { jobDuration } = require("../observability/metrics.js");
const { reportError } = require("../observability/errors.js");

function defaultJobs() {
  const jobs = [{ name: "expiry", run: expireStaleHolds }];
  if (paymentsEnabled()) {
    jobs.push({ name: "refunds", run: processRefundQueue });
    jobs.push({ name: "reconcile", run: reconcilePayments });
  }
  return jobs;
}

function startBackgroundJobs({ intervalMs = 30_000, jobs = defaultJobs(), logger = defaultLogger } = {}) {
  let timer = null;
  let running = null;
  let stopped = false;

  async function tick() {
    for (const job of jobs) {
      if (stopped) return;
      // Each pass gets its own correlation ID, so all log lines it causes
      // (transitions, refunds, ...) can be grouped like a request's.
      const end = jobDuration.startTimer({ job: job.name });
      await withContext(`job-${job.name}-${crypto.randomUUID().slice(0, 8)}`, async () => {
        try {
          const result = await job.run();
          end({ result: "ok" });
          const busy =
            (job.name === "expiry" && result.expired > 0) ||
            (job.name === "refunds" && result.length > 0) ||
            (job.name === "reconcile" && (result.confirmed > 0 || result.errors > 0));
          if (busy) logger.info({ job: job.name, result }, `job ${job.name} did work`);
        } catch (err) {
          // One failing job must not stop the others.
          end({ result: "error" });
          reportError(err, { message: `job ${job.name} failed`, job: job.name });
        }
      });
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
  logger.info({ jobs: jobs.map((j) => j.name), intervalMs }, "background jobs started");

  return {
    // Resolves once an in-flight pass has finished, for graceful shutdown.
    async stop() {
      stopped = true;
      clearTimeout(timer);
      if (running) await running;
    },
  };
}

module.exports = { startBackgroundJobs };
