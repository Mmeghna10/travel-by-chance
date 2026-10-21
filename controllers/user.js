const User = require("../models/user");
const { signupSchema } = require("../schema.js");

module.exports.renderSignupForm = (req, res) => {
  res.render("users/signup.ejs");
}

module.exports.signUp = async (req, res, next) => {
  const { error, value } = signupSchema.validate(req.body, { stripUnknown: true });
  if (error) {
    req.flash("error", error.details.map((el) => el.message).join(", "));
    return res.redirect("/signup");
  }
  try {
    const { username, email, password } = value;
    // Role is never taken from the request: public signup always creates a
    // customer. Admins are created with `npm run create-admin`.
    const newUser = new User({ email, username, role: "customer" });
    const registeredUser = await User.register(newUser, password);
    req.login(registeredUser, (err) => {
      if(err){
        return next(err);
      }
      req.flash("success", "Welcome to TravelByChance!");
      res.redirect("/listings");
    });
  } catch (e) {
    // Duplicate email surfaces as a Mongo E11000 error; give a readable message.
    req.flash("error", e.code === 11000 ? "An account with that email already exists." : e.message);
    res.redirect("/signup");
  }
};

module.exports.renderLoginForm = (req, res) => {
  res.render("users/login.ejs");
}

module.exports.login =  async (req, res) => {
    req.flash("success","Welcome Back to TravelByChance! ");
    if (req.user && req.user.role === "admin") {
      return res.redirect("/admin");
    }
    const redirectUrl = res.locals.redirectUrl || "/listings";
    res.redirect(redirectUrl);
  }

  module.exports.logout =  (req, res, next) => {
  req.logout((err) => {
    if(err){
      return next(err);
    }
    req.flash("success","you are logged out!");
    res.redirect("/listings");
  })
}
