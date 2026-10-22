const { test } = require("node:test");
const assert = require("node:assert/strict");
const safeJson = require("../../utils/safeJson.js");
const escapeRegex = require("../../utils/escapeRegex.js");

test("safeJson cannot close a <script> tag and still round-trips", () => {
  const data = { title: "</script><script>alert(1)</script>", amp: "a & b", ls: "x" + String.fromCharCode(0x2028) + "y" };
  const out = safeJson(data);
  assert.ok(!out.includes("</script>"));
  assert.ok(!out.includes("<"));
  assert.deepEqual(JSON.parse(out), data);
  // Must also be valid JavaScript, since it's emitted as `const x = <json>;`
  assert.deepEqual(new Function(`return ${out};`)(), data);
});

test("escapeRegex makes metacharacters literal", () => {
  for (const input of ["(", "a.b", "(a+)+$", "[x]", "\\", "^*?{}|"]) {
    const re = new RegExp(escapeRegex(input));
    assert.ok(re.test(input), `should match itself: ${input}`);
  }
  assert.ok(!new RegExp(escapeRegex("a.b")).test("axb"));
});
