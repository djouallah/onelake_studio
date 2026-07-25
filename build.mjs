// Static "build" for Fabric static hosting: publish the contents of site/ to dist/.
// The app is plain HTML + DuckDB-WASM (loaded from CDN) that reads OneLake Iceberg tables
// directly in the browser — no bundler, so we just copy site/ -> dist/.
import { rm, cp } from "node:fs/promises";

const dist = new URL("./dist/", import.meta.url);
const site = new URL("./site/", import.meta.url);

await rm(dist, { recursive: true, force: true });
await cp(site, dist, { recursive: true });
console.log("Published site/ -> dist/");
