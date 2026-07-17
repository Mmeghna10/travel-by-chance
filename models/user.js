const mongoose = require("mongoose");
const Schema = mongoose.Schema;

// IMPORTANT FIX ⬇️
const plm = require("passport-local-mongoose");
const passportLocalMongoose = plm.default || plm; 

const userSchema = new Schema({
  email: {
    type: String,
    required: true,
    unique: true
  },
  role: {
    type: String,
    enum: ["customer", "admin"],
    default: "customer",
    required: true
  }
});

// apply plugin
userSchema.plugin(passportLocalMongoose);

module.exports = mongoose.model("User", userSchema);
