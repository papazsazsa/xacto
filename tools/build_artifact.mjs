// Build the artifact variant: the Artifact host supplies <!doctype>/<html>/<head>/<body> and charset/viewport metas.
import fs from 'fs'; import path from 'path'; import { execFileSync } from 'child_process';
const root = path.resolve(process.argv[2] || '.');
const full = path.join(root, 'dist', 'xacto.html');
execFileSync('node', [path.join(root, 'tools', 'build.mjs'), root], { stdio: 'inherit' });
let s = fs.readFileSync(full, 'utf8');
s = s.replace(/<!doctype html>\s*/i, '').replace(/<html[^>]*>\s*/i, '').replace(/<\/html>\s*/i, '')
  .replace(/<head>\s*/i, '').replace(/<\/head>\s*/i, '').replace(/<body>\s*/i, '').replace(/<\/body>\s*/i, '')
  .replace(/<meta charset[^>]*>\s*/i, '').replace(/<meta name="viewport"[^>]*>\s*/i, '');
// title first so the host scanner finds it
s = s.replace(/<title>[^<]*<\/title>\s*/i, ''); s = '<title>XACTO</title>\n' + s;
const out = path.join(root, 'dist', 'xacto_artifact.html'); fs.writeFileSync(out, s);
console.log('artifact page', out, (fs.statSync(out).size / 1024).toFixed(1) + ' KB');
// the two published pages, built from the same source: web (detects touch by itself) and mobile (touch
// layout forced on, lighter rendering)
const web = s.replace(/^<title>[^<]*<\/title>/, '<title>XACTO Web</title>');
const mobile = s.replace(/^<title>[^<]*<\/title>/, '<title>XACTO Mobile</title>\n<script>window.XACTO_MOBILE = 1;</script>');
fs.writeFileSync(path.join(root, 'dist', 'xacto_web.html'), web);
fs.writeFileSync(path.join(root, 'dist', 'xacto_mobile.html'), mobile);
console.log('web page dist/xacto_web.html, mobile page dist/xacto_mobile.html');
// the public page on GitHub Pages (served from /docs on main): the full standalone build
fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
fs.copyFileSync(full, path.join(root, 'docs', 'index.html'));
fs.writeFileSync(path.join(root, 'docs', '.nojekyll'), '');   // serve the page as is (no Jekyll pass)
console.log('GitHub Pages page docs/index.html');
