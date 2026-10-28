// Writes the names of the environment this file was started with to $ENV_NAMES_OUT, one per line.
// Run under tests/run-in-a-temp-root.mjs by the test that checks what the runner hands a test file.
import fs from 'node:fs';

fs.writeFileSync(process.env.ENV_NAMES_OUT, Object.keys(process.env).join('\n'));
