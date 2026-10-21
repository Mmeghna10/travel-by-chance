const Joi = require('joi');

module.exports.listingSchema =Joi.object({
    listing : Joi.object({
        title: Joi.string().required(),
        description: Joi.string().required(),
        location: Joi.string().required(),
        country: Joi.string().required(),
        price: Joi.number().required().min(0),
        image: Joi.string().allow("", null),
        category: Joi.string().valid("Trending", "Rooms", "Iconic Cities", "Mountains", "Castles", "Amazing Pools", "Camping", "Farms", "Arctic", "Domes", "Boats").required()
    }).required()
});

module.exports.reviewSchema = Joi.object({
    review : Joi.object({
        rating: Joi.number().required().min(1).max(5),
        comment: Joi.string().required().max(2000),

    }).required()
})

module.exports.signupSchema = Joi.object({
    username: Joi.string().trim().pattern(/^[a-zA-Z0-9_.-]+$/).min(3).max(30).required()
        .messages({ "string.pattern.base": "Username may only contain letters, numbers, dots, dashes and underscores" }),
    email: Joi.string().trim().lowercase().email().max(254).required(),
    password: Joi.string().min(8).max(128).required(),
})

