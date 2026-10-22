class ExpressError extends Error{
    // `code` is an optional machine-readable error code returned to JSON
    // clients (e.g. "SOLD_OUT"), so the frontend doesn't parse messages.
    constructor(statusCode, message, code){
        super(message);
        this.statusCode = statusCode;
        this.message = message;
        this.code = code;
    }
}

module.exports = ExpressError;
