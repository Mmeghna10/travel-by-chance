// Escapes user input so it is matched literally inside a MongoDB $regex.
// Without this, "(" throws a 500 and patterns like "(a+)+$" can hang the query.
module.exports = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
