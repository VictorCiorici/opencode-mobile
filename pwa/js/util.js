/* OpenForge – pure helpers (no DOM access).
   Works as a classic browser script (exposes window.OF) and under Node
   (module.exports) so it can be unit-tested with `node --test pwa/tests/`. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.OF = Object.assign(root.OF || {}, api);
})(typeof window !== "undefined" ? window : (typeof self !== "undefined" ? self : null), function () {
  "use strict";

  const ESC_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "`": "&#96;" };

  /** Escape text for safe use in HTML text AND quoted attribute values. */
  function esc(s) {
    return String(s ?? "").replace(/[&<>"'`]/g, (c) => ESC_MAP[c]);
  }

  /* ---------------- syntax highlighting ---------------- */

  const KW = {
    js: "const|let|var|function|return|if|else|for|while|class|new|import|from|export|default|async|await|try|catch|finally|throw|typeof|instanceof|switch|case|break|continue|null|undefined|true|false|this|extends|super",
    ts: "const|let|var|function|return|if|else|for|while|class|new|import|from|export|default|async|await|interface|type|enum|implements|public|private|readonly|try|catch|throw|null|undefined|true|false|this|string|number|boolean|any",
    py: "def|return|if|elif|else|for|while|import|from|as|class|try|except|raise|with|lambda|None|True|False|and|or|not|in|is|pass|yield|async|await|global|assert|del|self",
    sh: "echo|cd|ls|cat|grep|sed|awk|curl|wget|git|sudo|apt|pip|npm|export|source|if|then|fi|for|do|done|while|case|esac|function|return|local|set",
    sql: "SELECT|FROM|WHERE|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|TABLE|DROP|ALTER|JOIN|LEFT|RIGHT|INNER|ON|GROUP|ORDER|BY|LIMIT|AND|OR|NOT|NULL|AS|DISTINCT",
    go: "func|package|import|var|const|type|struct|interface|go|defer|chan|select|range|map|nil|true|false|if|else|for|return|switch|case|break",
    rust: "fn|let|mut|const|struct|enum|impl|trait|pub|use|mod|match|if|else|loop|while|for|in|return|Some|None|Ok|Err|self|Self|where|dyn|move",
  };

  function langKey(lang) {
    const l = String(lang || "").toLowerCase();
    if (["py", "python"].includes(l)) return "py";
    if (["js", "javascript", "jsx", "mjs", "node", "json"].includes(l)) return "js";
    if (["ts", "typescript", "tsx"].includes(l)) return "ts";
    if (["sh", "bash", "shell", "zsh", "console", "terminal"].includes(l)) return "sh";
    if (l === "sql") return "sql";
    if (l === "go" || l === "golang") return "go";
    if (l === "rust" || l === "rs") return "rust";
    return null;
  }

  // Per-language line-comment syntax (unknown languages accept // and #).
  const LINE_COMMENT = {
    js: "\\/\\/", ts: "\\/\\/", go: "\\/\\/", rust: "\\/\\/",
    py: "#", sh: "#", sql: "--",
  };
  const RE_CACHE = {};
  function tokenRe(key) {
    const k = key || "_";
    if (!RE_CACHE[k]) {
      const lc = key ? LINE_COMMENT[key] : "\\/\\/|#";
      RE_CACHE[k] = [
        `(${lc}[^\\n]*)`,
        "(\\/\\*[\\s\\S]*?\\*\\/)",
        "(\"(?:[^\"\\\\\\n]|\\\\.)*\"|'(?:[^'\\\\\\n]|\\\\.)*'|`(?:[^`\\\\]|\\\\.)*`)",
        "(\\b\\d+(?:\\.\\d+)?\\b)",
        "([A-Za-z_]\\w*)",
        "([\\s\\S])",
      ].join("|");
    }
    return new RegExp(RE_CACHE[k], "g");
  }

  /** Highlight RAW source (not pre-escaped). Returns safe HTML. */
  function hl(src, lang) {
    src = String(src ?? "");
    const key = langKey(lang);
    const kwSet = new Set(key ? KW[key].split("|") : []);
    const re = tokenRe(key);
    let out = "", m;
    while ((m = re.exec(src))) {
      const [tok, lineC, blockC, str, num, word] = m;
      let cls = "";
      if (lineC || blockC) cls = "c";
      else if (str) cls = "s";
      else if (num) cls = "n";
      else if (word && (kwSet.has(word) || (key === "sql" && kwSet.has(word.toUpperCase())))) cls = "k";
      out += cls ? `<span class="tk-${cls}">${esc(tok)}</span>` : esc(tok);
    }
    return out;
  }

  function codeBlock(code, lang) {
    const label = String(lang || "").replace(/[^\w+#.-]/g, "").slice(0, 16);
    return `<div class="codeblock"><div class="cb-head"><span class="cb-lang">${esc(label || "code")}</span>` +
      `<button type="button" class="cb-copy ghost" aria-label="Copy code">Copy</button></div>` +
      `<pre><code>${hl(code, label)}</code></pre></div>`;
  }

  // Only absolute http(s) URLs become links. The URL is already HTML-escaped, so it
  // cannot break out of the attribute. rel=noopener noreferrer; the Android shell
  // routes external links to the system browser (do not intercept in JS).
  function linkify(escaped) {
    return escaped
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s()]+)\)/g,
        '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
      .replace(/(^|[\s(])(https?:\/\/[^\s<>()"]+[^\s<>()".,;:!?'])/g,
        (m, pre, url) => /&#39;|&quot;/.test(url) ? m
          : pre + '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + url + '</a>');
  }

  function inline(text) {
    const parts = esc(text).split(/(&#96;(?:(?!&#96;)[^\n])+&#96;)/);
    return parts.map((p, i) => {
      if (i % 2 === 1) return "<code>" + p.slice(5, -5) + "</code>";
      return linkify(p.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>"));
    }).join("");
  }

  /** Minimal markdown: fenced code (highlighted, copyable), inline code, bold.
      Everything is escaped from the RAW text; unclosed fences (streaming) work. */
  function md(text) {
    text = String(text ?? "");
    let out = "", i = 0;
    const fence = /```([^\n`]*)\n?/g;
    while (i < text.length) {
      fence.lastIndex = i;
      const open = fence.exec(text);
      if (!open) { out += inline(text.slice(i)); break; }
      out += inline(text.slice(i, open.index));
      const bodyStart = open.index + open[0].length;
      const close = text.indexOf("```", bodyStart);
      const body = close < 0 ? text.slice(bodyStart) : text.slice(bodyStart, close);
      out += codeBlock(body.replace(/\n$/, ""), open[1].trim().split(/\s+/)[0]);
      if (close < 0) break;
      i = close + 3;
    }
    return out;
  }

  /* ---------------- diff ---------------- */

  function diffLineClass(l) {
    if (l.startsWith("@@")) return "dl-hunk";
    if (l.startsWith("+") && !l.startsWith("+++")) return "dl-add";
    if (l.startsWith("-") && !l.startsWith("---")) return "dl-del";
    return "dl-ctx";
  }

  function renderDiffLines(text) {
    return String(text ?? "").split("\n")
      .map((l) => `<span class="dl ${diffLineClass(l)}">${esc(l)}</span>`).join("");
  }

  function diffStats(text) {
    let add = 0, del = 0;
    for (const l of String(text ?? "").split("\n")) {
      const c = diffLineClass(l);
      if (c === "dl-add") add++; else if (c === "dl-del") del++;
    }
    return { add, del };
  }

  function looksLikeDiff(s) {
    s = String(s ?? "");
    return s.includes("@@") && (s.includes("\n+") || s.includes("\n-"));
  }

  /* ---------------- formatting ---------------- */

  function fmtTok(n) {
    if (n == null || Number.isNaN(Number(n))) return "–";
    n = Number(n);
    if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
    if (n >= 1000) return (n / 1000).toFixed(1) + "k";
    return String(n);
  }

  function fmtBytes(n) {
    n = Number(n) || 0;
    if (n >= 1 << 20) return (n / (1 << 20)).toFixed(1) + " MB";
    if (n >= 1024) return (n / 1024).toFixed(1) + " KB";
    return n + " B";
  }

  function fmtCost(c) {
    return c ? ` · $${Number(c).toFixed(3)}` : "";
  }

  /* ---------------- URL / token / paths ---------------- */

  /** Pick the API base. `loc` = {protocol, hostname, port}. */
  function apiBase(userUrl, loc) {
    const u = String(userUrl || "").trim();
    if (/^https?:\/\//i.test(u)) return u.replace(/\/+$/, "");
    loc = loc || {};
    if (loc.protocol === "file:" || loc.hostname === "appassets.androidplatform.net" || !loc.port) {
      return "http://127.0.0.1:8787";
    }
    return "";
  }

  /** EventSource cannot send headers, so the token rides in the query. */
  function sseUrl(base, pid, token) {
    let url = `${base}/oc/${encodeURIComponent(pid)}/event`;
    if (token) url += `?token=${encodeURIComponent(token)}`;
    return url;
  }

  function parentPath(p) {
    return String(p || "").split("/").filter(Boolean).slice(0, -1).join("/");
  }

  function joinPath(dir, name) {
    return dir ? `${dir}/${name}` : name;
  }

  /** Normalize server error JSON into a short message. */
  function errorMessage(status, body) {
    if (body && typeof body === "object") {
      const m = body.detail || body.error || body.message;
      if (m) return typeof m === "string" ? m : JSON.stringify(m);
    }
    if (status === 401 || status === 403) return "Unauthorized — check the bridge token in Settings";
    return `Request failed (${status})`;
  }

  /** Strip control characters / limit length for toasts. */
  function cleanToast(msg, max = 220) {
    const s = String(msg ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim();
    return s.length > max ? s.slice(0, max - 1) + "…" : s;
  }

  return {
    esc, langKey, hl, md, codeBlock, diffLineClass, renderDiffLines, diffStats,
    looksLikeDiff, fmtTok, fmtBytes, fmtCost, apiBase, sseUrl, parentPath,
    joinPath, errorMessage, cleanToast,
  };
});
