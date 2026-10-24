const Joi = require('joi');
const { AMENITY_KEYS } = require("./modules/listings/amenities.js");
const { CATEGORY_NAMES } = require("./modules/listings/categories.js");

module.exports.listingSchema =Joi.object({
    listing : Joi.object({
        title: Joi.string().required(),
        description: Joi.string().required(),
        location: Joi.string().required(),
        // TravelByChance lists stays in India only (prices are in rupees).
        country: Joi.string().trim().valid("India").required().messages({ "any.only": "TravelByChance lists stays in India only." }),
        price: Joi.number().required().min(0),
        units: Joi.number().integer().min(1).max(100),
        // Checkboxes: one ticked box arrives as a string, several as an array.
        amenities: Joi.array().items(Joi.string().valid(...AMENITY_KEYS)).single(),
        checkInTime: Joi.string().pattern(/^([01]\d|2[0-3]):[0-5]\d$/).messages({ "string.pattern.base": "Check-in time must look like 14:00" }),
        image: Joi.string().allow("", null),
        category: Joi.string().valid(...CATEGORY_NAMES).required()
    }).required()
});

module.exports.reviewSchema = Joi.object({
    review : Joi.object({
        // The star widget's "no rating" option sends an empty value.
        rating: Joi.number().integer().required().min(1).max(5).messages({
            "number.base": "Please choose a star rating (1-5).",
            "any.required": "Please choose a star rating (1-5).",
        }),
        comment: Joi.string().required().max(2000),

    }).required()
})

module.exports.signupSchema = Joi.object({
    username: Joi.string().trim().pattern(/^[a-zA-Z0-9_.-]+$/).min(3).max(30).required()
        .messages({ "string.pattern.base": "Username may only contain letters, numbers, dots, dashes and underscores" }),
    email: Joi.string().trim().lowercase().email().max(254).required(),
    password: Joi.string().min(8).max(128).required(),
})

