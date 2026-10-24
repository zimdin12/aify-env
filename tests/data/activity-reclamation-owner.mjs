import fs from 'node:fs';
const release = process.argv[2];
const timer = setInterval(() => { if (fs.existsSync(release)) { clearInterval(timer); process.exit(0); } }, 10);
