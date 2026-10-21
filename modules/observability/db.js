// Database query monitoring via the MongoDB driver's command monitoring events
// (requires connecting with { monitorCommands: true }). Every command's
// duration goes into a histogram; slow ones are logged; failures are counted
// by error code. WriteConflict failures are the visible cost of contention:
// concurrent transactions touching the same night, retried by the driver.
const { logger } = require("./logger.js");
const { dbCommandDuration, dbCommandFailures } = require("./metrics.js");

// Handshake/heartbeat commands would drown the real ones.
const IGNORED = new Set(["hello", "isMaster", "ismaster", "ping", "saslStart", "saslContinue", "endSessions", "buildInfo", "getParameter"]);

function instrumentMongo(connection, { slowMs = Number(process.env.SLOW_QUERY_MS) || 200 } = {}) {
  const client = connection.getClient();
  if (client.__travelbychanceInstrumented) return;
  client.__travelbychanceInstrumented = true;

  const collections = new Map(); // requestId -> collection, from commandStarted

  client.on("commandStarted", (e) => {
    if (IGNORED.has(e.commandName)) return;
    const collection = e.command && typeof e.command[e.commandName] === "string" ? e.command[e.commandName] : undefined;
    collections.set(e.requestId, collection);
  });

  client.on("commandSucceeded", (e) => {
    if (IGNORED.has(e.commandName)) return;
    const collection = collections.get(e.requestId);
    collections.delete(e.requestId);
    dbCommandDuration.observe({ command: e.commandName }, e.duration / 1000);
    if (e.duration >= slowMs) {
      // Only the command name, collection and timing; never the query values.
      logger.warn({ db: { command: e.commandName, collection, durationMs: e.duration } }, "slow MongoDB command");
    }
  });

  client.on("commandFailed", (e) => {
    collections.delete(e.requestId);
    if (IGNORED.has(e.commandName)) return;
    const codeName = (e.failure && (e.failure.codeName || e.failure.name)) || "unknown";
    dbCommandFailures.inc({ command: e.commandName, code_name: codeName });
  });
}

module.exports = { instrumentMongo };
