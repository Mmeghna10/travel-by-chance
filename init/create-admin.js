// Creates an admin (host) account, or promotes an existing user to admin.
// Public signup can only create customers, so this is the only way to get an admin.
//
//   Create:  set ADMIN_PASSWORD, then: npm run create-admin -- --username host1 --email host1@example.com
//   Promote: npm run create-admin -- --promote someuser
//   List:    npm run create-admin -- --list
//
// The password is read from the ADMIN_PASSWORD environment variable rather
// than a CLI flag so it doesn't end up in shell history or process listings.
const { config, assertRequired } = require("../config/env.js");
const mongoose = require("mongoose");
const { parseArgs } = require("node:util");
const User = require("../models/user.js");

async function main() {
  const { values } = parseArgs({
    options: {
      username: { type: "string" },
      email: { type: "string" },
      promote: { type: "string" },
      list: { type: "boolean" },
    },
  });

  assertRequired();
  await mongoose.connect(config.dbUrl, { serverSelectionTimeoutMS: 10_000 });

  if (values.list) {
    const admins = await User.find({ role: "admin" }).select("username email");
    console.log(admins.length ? admins.map((u) => `${u.username} <${u.email}>`).join("\n") : "No admin users.");
    return;
  }

  if (values.promote) {
    const user = await User.findOneAndUpdate({ username: values.promote }, { role: "admin" }, { new: true });
    if (!user) throw new Error(`No user named "${values.promote}"`);
    console.log(`Promoted ${user.username} to admin.`);
    return;
  }

  const password = process.env.ADMIN_PASSWORD;
  if (!values.username || !values.email || !password) {
    throw new Error("Usage: ADMIN_PASSWORD=... npm run create-admin -- --username <name> --email <email>");
  }
  if (password.length < 8) throw new Error("ADMIN_PASSWORD must be at least 8 characters");

  const user = await User.register(new User({ username: values.username, email: values.email, role: "admin" }), password);
  console.log(`Created admin ${user.username}.`);
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
