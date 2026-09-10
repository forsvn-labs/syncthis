#!/usr/bin/env bun
// Produces the published artifact: a single self-contained, Node-runnable bundle.
//
// syncthis is written in TypeScript and run directly by Bun in development
// (`bun bin/syncthis.ts`). For distribution we bundle everything — all runtime
// deps inlined — into dist/syncthis.mjs and rewrite the shebang to `node`, so
// `npx @forsvn/syncthis` works for any Node >=22 user without Bun installed and
// without installing a single transitive dependency. The runtime deps therefore
// live in devDependencies; they're compiled in here, not shipped as node_modules.
import { $ } from "bun";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";

const OUT = "dist/syncthis.mjs";

await rm("dist", { recursive: true, force: true });
await $`bun build ./bin/syncthis.ts --target=node --outfile ${OUT}`;

let code = await readFile(OUT, "utf8");
code = code.replace(/^#!.*\r?\n/, ""); // drop the dev `#!/usr/bin/env bun` shebang
code = `#!/usr/bin/env node\n${code}`;
await writeFile(OUT, code);
await chmod(OUT, 0o755);

console.log(`built ${OUT} (node-runnable, self-contained)`);
