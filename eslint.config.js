// ESLint flat config. `npm run lint` runs in CI and must pass.
const js = require("@eslint/js");
const globals = require("globals");

module.exports = [
  { ignores: ["node_modules/", "coverage/"] },
  js.configs.recommended,
  {
    // Server code, scripts and tests: Node, CommonJS.
    files: ["**/*.js"],
    languageOptions: { ecmaVersion: 2024, sourceType: "commonjs", globals: { ...globals.node } },
    rules: {
      // Unused function parameters are common in Express signatures (req, res, next).
      "no-unused-vars": ["error", { args: "none", caughtErrors: "none", ignoreRestSiblings: true }],
    },
  },
  {
    // Browser scripts served from /public. Globals come from <script> tags
    // (Mapbox, Razorpay Checkout) or from inline variables in the EJS page.
    files: ["public/js/**/*.js"],
    languageOptions: {
      sourceType: "script",
      globals: { ...globals.browser, mapboxgl: "readonly", Razorpay: "readonly", mapToken: "readonly", listing: "readonly" },
    },
  },
  {
    // k6 load scripts: ES modules running in k6, not Node.
    files: ["load/k6/**/*.js"],
    languageOptions: { sourceType: "module", globals: { __ENV: "readonly", __VU: "readonly" } },
  },
];
