// dax-sql as vendored (scripts/vendor.mjs), at the pin in core/vendored.js, and the YAML parser beside it: what
// page/semantic.js reads models with, in the shape the panel and the command line hand it (compilerBundle).
// semantic.js is a thin layer over dax-sql, so its tests read the real one, never a stand-in.
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const { PINS } = createRequire(import.meta.url)("../../core/vendored.js");
const VENDOR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "vendor", "npm");
const load = (pkg, f) => import(pathToFileURL(join(VENDOR, pkg, f)).href);
export const [c, t, o, m, d, y] = await Promise.all([
  load(PINS.daxSql, "src/index.js"), load(PINS.daxSql, "formats/tmsl.js"), load(PINS.daxSql, "formats/ossie.js"),
  load(PINS.daxSql, "formats/model.js"), load(PINS.daxSql, "formats/tmdl.js"), load(PINS.yaml, "+esm.js"),
]);
export const semantic = await import("../../page/semantic.js");
export const bundle = semantic.compilerBundle(c, t, o, m, d, y);
semantic.useModules(bundle);
