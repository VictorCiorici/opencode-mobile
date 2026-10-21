"use strict";
/* Node >= 22 treats `node --test pwa/tests/` as a module path, resolving to this
   index.js. Load every *.test.js here so that command works on all versions. */
const fs = require("node:fs");
const path = require("node:path");
{
  for (const f of fs.readdirSync(__dirname).sort()) {
    if (f.endsWith(".test.js")) require(path.join(__dirname, f));
  }
}
