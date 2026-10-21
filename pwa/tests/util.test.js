"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const U = require("../js/util.js");

const PAYLOADS = [
  "<script>alert(1)</script>",
  '"><img src=x onerror=alert(1)>',
  "' onmouseover='alert(1)",
  "<svg/onload=alert(1)>",
  "`<b>x</b>`",
  "&lt;already&gt;",
  "javascript:alert(1)",
];

// Any raw '<' left in output must belong to one of our own known tags.
function onlyKnownTags(html) {
  const tags = html.match(/<\/?[a-zA-Z][^>]*>/g) || [];
  const ok = /^<\/?(span|div|pre|code|b|button|a)(\s[^<>]*)?>$/;
  return tags.every((t) => ok.test(t));
}

test("esc escapes all dangerous characters", () => {
  assert.equal(U.esc(`<a href="x" title='y'>&\``), "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&#96;");
  assert.equal(U.esc(null), "");
  assert.equal(U.esc(undefined), "");
  assert.equal(U.esc(42), "42");
});

test("esc output never contains raw angle brackets or quotes", () => {
  for (const p of PAYLOADS) {
    const e = U.esc(p);
    assert.ok(!/[<>"'`]/.test(e), p);
  }
});

test("esc is safe in attribute context", () => {
  const html = `<a title="${U.esc('" onclick="alert(1)')}">`;
  assert.ok(!html.includes('" onclick'));
});

test("md escapes HTML in plain text", () => {
  for (const p of PAYLOADS) {
    const out = U.md(p);
    assert.ok(!out.includes("<script"), p);
    assert.ok(!out.includes("<img"), p);
    assert.ok(!out.includes("<svg"), p);
    assert.ok(onlyKnownTags(out), out);
  }
});

test("md escapes HTML inside fenced code and does not double-escape", () => {
  const out = U.md("```js\nconst a = '<b>' && 1 < 2;\n```");
  assert.ok(out.includes("&lt;b&gt;"));
  assert.ok(!out.includes("&amp;lt;"));
  assert.ok(!out.includes("<b>"));
  assert.ok(out.includes("&amp;&amp;"));
  assert.ok(onlyKnownTags(out));
});

test("md fence info string cannot inject markup", () => {
  const out = U.md('```"><script>alert(1)</script>\ncode\n```');
  assert.ok(!out.includes("<script"));
  assert.ok(onlyKnownTags(out));
});

test("md handles unclosed fence (streaming) and escapes it", () => {
  const out = U.md("text\n```py\nprint('<x>')");
  assert.ok(out.includes('class="codeblock"'));
  assert.ok(out.includes("&lt;x&gt;"));
  assert.ok(!out.includes("<x>"));
});

test("md renders inline code and bold, escaped", () => {
  assert.equal(U.md("use `a<b` now"), "use <code>a&lt;b</code> now");
  assert.equal(U.md("**<i>**"), "<b>&lt;i&gt;</b>");
});

test("md code block has copy button and language label", () => {
  const out = U.md("```bash\nls\n```");
  assert.ok(out.includes("cb-copy"));
  assert.ok(out.includes("bash"));
});

test("md of null/empty is empty string", () => {
  assert.equal(U.md(null), "");
  assert.equal(U.md(""), "");
});

test("hl highlights keywords, strings, numbers, comments", () => {
  const out = U.hl("const x = 'a'; // hi\nlet y = 42", "js");
  assert.ok(out.includes('<span class="tk-k">const</span>'));
  assert.ok(out.includes('<span class="tk-s">&#39;a&#39;</span>'));
  assert.ok(out.includes('<span class="tk-c">// hi</span>'));
  assert.ok(out.includes('<span class="tk-n">42</span>'));
});

test("hl does not treat -- / # as comments in JS", () => {
  const out = U.hl("i--; x = a # b", "js");
  assert.ok(!out.includes("tk-c"));
});

test("hl: sh flags are not comments, # is", () => {
  const out = U.hl("rm --force # note", "sh");
  assert.ok(out.includes('<span class="tk-c"># note</span>'));
  assert.ok(!out.includes("--force</span>"));
});

test("hl escapes markup in code and unknown language", () => {
  const out = U.hl("<script>alert('x')</script>", "weird");
  assert.ok(!out.includes("<script"));
  assert.ok(out.includes("&lt;script&gt;"));
});

test("langKey maps aliases", () => {
  assert.equal(U.langKey("Python"), "py");
  assert.equal(U.langKey("tsx"), "ts");
  assert.equal(U.langKey("zsh"), "sh");
  assert.equal(U.langKey("nope"), null);
  assert.equal(U.langKey(undefined), null);
});

test("renderDiffLines classifies and escapes", () => {
  const out = U.renderDiffLines("@@ -1 +1 @@\n+<b>add</b>\n-del\n ctx\n--- a/f\n+++ b/f");
  assert.ok(out.includes('dl-hunk'));
  assert.ok(out.includes('dl dl-add">+&lt;b&gt;add&lt;/b&gt;'));
  assert.ok(out.includes('dl dl-del">-del'));
  assert.ok(!out.includes("<b>"));
  // file headers are context, not add/del
  assert.ok(out.includes('dl dl-ctx">--- a/f'));
  assert.ok(out.includes('dl dl-ctx">+++ b/f'));
});

test("diffStats counts additions/deletions only", () => {
  assert.deepEqual(U.diffStats("--- a\n+++ b\n@@ -1 +1 @@\n+a\n+b\n-c\n x"), { add: 2, del: 1 });
  assert.deepEqual(U.diffStats(""), { add: 0, del: 0 });
});

test("looksLikeDiff", () => {
  assert.ok(U.looksLikeDiff("@@ -1 +1 @@\n+a"));
  assert.ok(!U.looksLikeDiff("plain output"));
});

test("fmtTok / fmtBytes / fmtCost", () => {
  assert.equal(U.fmtTok(null), "–");
  assert.equal(U.fmtTok(999), "999");
  assert.equal(U.fmtTok(1500), "1.5k");
  assert.equal(U.fmtTok(2_500_000), "2.5M");
  assert.equal(U.fmtBytes(512), "512 B");
  assert.equal(U.fmtBytes(2048), "2.0 KB");
  assert.equal(U.fmtCost(0), "");
  assert.equal(U.fmtCost(0.1234), " · $0.123");
});

test("apiBase", () => {
  assert.equal(U.apiBase("https://x.example/", {}), "https://x.example");
  assert.equal(U.apiBase("", { protocol: "file:" }), "http://127.0.0.1:8787");
  assert.equal(U.apiBase("", { protocol: "https:", hostname: "appassets.androidplatform.net", port: "" }), "http://127.0.0.1:8787");
  assert.equal(U.apiBase("", { protocol: "http:", hostname: "h", port: "8787" }), "");
  assert.equal(U.apiBase("javascript:alert(1)", { protocol: "http:", hostname: "h", port: "8787" }), "");
});

test("sseUrl encodes token and project id", () => {
  assert.equal(U.sseUrl("http://h", "p1", ""), "http://h/oc/p1/event");
  assert.equal(U.sseUrl("http://h", "p1", "a b&c"), "http://h/oc/p1/event?token=a%20b%26c");
  assert.equal(U.sseUrl("", "a/b", "t"), "/oc/a%2Fb/event?token=t");
});

test("parentPath / joinPath", () => {
  assert.equal(U.parentPath("a/b/c"), "a/b");
  assert.equal(U.parentPath("a"), "");
  assert.equal(U.parentPath(""), "");
  assert.equal(U.joinPath("", "f"), "f");
  assert.equal(U.joinPath("d", "f"), "d/f");
});

test("errorMessage", () => {
  assert.equal(U.errorMessage(400, { detail: "bad" }), "bad");
  assert.equal(U.errorMessage(500, { error: "boom" }), "boom");
  assert.match(U.errorMessage(401, null), /Unauthorized/);
  assert.equal(U.errorMessage(502, null), "Request failed (502)");
});

test("cleanToast strips control chars and truncates", () => {
  assert.equal(U.cleanToast("a\u0000b\u001bc"), "abc");
  assert.equal(U.cleanToast("x".repeat(500)).length, 220);
  assert.equal(U.cleanToast(null), "");
});

test("md links: only http(s), noopener, attribute cannot be broken out of", () => {
  const ok = U.md("[site](https://example.com/a?x=1&y=2)");
  assert.ok(ok.includes('href="https://example.com/a?x=1&amp;y=2"'));
  assert.ok(ok.includes('rel="noopener noreferrer"'));
  const bare = U.md("go to https://example.com/path.");
  assert.ok(bare.includes('href="https://example.com/path"'));
  const js = U.md("[x](javascript:alert(1))");
  assert.ok(!js.includes("<a "));
  const brk = U.md('[x](https://e.com/" onmouseover="alert(1))');
  assert.ok(!/onmouseover=/.test(brk.replace(/&quot;onmouseover=&quot;/g, "")) || !brk.includes('" onmouseover'));
  assert.ok(onlyKnownTags(brk));
  // no links inside inline code
  assert.ok(!U.md("`https://e.com`").includes("<a "));
});

test("md: HTML tags in link text and url are escaped", () => {
  const out = U.md("[<img src=x onerror=alert(1)>](https://e.com/<script>)");
  assert.ok(!out.includes("<img"));
  assert.ok(!out.includes("<script"));
});
