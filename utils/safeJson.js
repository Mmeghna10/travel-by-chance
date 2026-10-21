// Serialises data for embedding inside an inline <script> tag.
// JSON.stringify alone is not safe there: a string containing "</script>"
// would close the tag and let the rest run as HTML/JS. Escaping < > & and the
// JS line separators (U+2028/U+2029) keeps the output valid JSON and valid JavaScript.
const ESCAPES = { "<": "\\u003c", ">": "\\u003e", "&": "\\u0026" };
ESCAPES[String.fromCharCode(0x2028)] = "\\u2028";
ESCAPES[String.fromCharCode(0x2029)] = "\\u2029";

const UNSAFE = new RegExp(`[${Object.keys(ESCAPES).join("")}]`, "g");

module.exports = (data) => JSON.stringify(data).replace(UNSAFE, (ch) => ESCAPES[ch]);
