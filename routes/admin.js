const express = require("express");
const router = express.Router();
const wrapAsync = require("../utils/wrapAsync.js");
const { isLoggedIn, isAdmin } = require("../middleware.js");
const adminController = require("../controllers/admin.js");

router.use(isLoggedIn, isAdmin);

router.get("/", wrapAsync(adminController.dashboard));

module.exports = router;
