const User = require("../models/user");

module.exports.renderSignupForm = (req, res) => {
  res.render("users/signup.ejs");
}

module.exports.signUp = async (req, res, next) => {
  try {
    let { username, email, password, role } = req.body;
    const newUser = new User({ email, username, role });
    const registeredUser = await User.register(newUser, password);
    console.log(registeredUser);
    req.login(registeredUser, (err) => {
      if(err){
        return next(err);
      }
      req.flash("success", "Welcome to TravelByChance!");
      if (registeredUser.role === "admin") {
        res.redirect("/admin");
      } else {
        res.redirect("/listings");
      }
    });
  
  } catch (e) {
    req.flash("error", e.message);
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
      next(err);
    }
    req.flash("success","you are logged out!");
    res.redirect("/listings");
  })
}