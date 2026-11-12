// The package is "type": "module", so Node.js would read dist/cjs/*.js as ES modules.
// This nested package.json makes it read them, and their .d.ts files, as CommonJS.
import {writeFileSync} from 'node:fs';

writeFileSync(new URL('../dist/cjs/package.json', import.meta.url), `${JSON.stringify({type: 'commonjs'}, undefined, '\t')}\n`);
