// Concatenate src/*.js (in name order) into a single self-contained HTML page.
// usage: node tools/build.mjs [rootDir] [outFile]
import fs from 'fs';
import path from 'path';
const root = path.resolve(process.argv[2] || path.join(path.dirname(new URL(import.meta.url).pathname), '..'));
const out = process.argv[3] || path.join(root, 'dist', 'xacto.html');
const srcDir = path.join(root, 'src');
const files = fs.readdirSync(srcDir).filter((f) => /^\d\d_.*\.js$/.test(f)).sort();
const js = files.map((f) => `// ==== ${f} ====\n` + fs.readFileSync(path.join(srcDir, f), 'utf8')).join('\n');
const tpl = fs.readFileSync(path.join(srcDir, 'template.html'), 'utf8');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, tpl.replace('/*__SRC__*/', () => js));
console.log(`built ${out} (${(fs.statSync(out).size / 1024).toFixed(1)} KB) from ${files.length} modules`);
