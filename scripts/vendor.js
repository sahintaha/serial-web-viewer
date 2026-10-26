// Copies the browser libraries and fonts the app uses from node_modules into
// public/vendor/, so the page works without a CDN (offline installs, Pages, Docker).
// Run after changing their versions:  npm run vendor   (the output is committed)

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'public', 'vendor');
const nm = (...p) => path.join(root, 'node_modules', ...p);

const FONTS = [
  { pkg: '@fontsource/ibm-plex-sans', weights: [400, 500, 600] },
  { pkg: '@fontsource/ibm-plex-mono', weights: [400, 500, 600] },
];
const SUBSETS = ['latin', 'latin-ext']; // Turkish needs latin-ext (ğ, ş, ı, İ)

function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

fs.rmSync(out, { recursive: true, force: true });

// Chart.js ships its UMD bundle already minified
copy(nm('chart.js', 'dist', 'chart.umd.js'), path.join(out, 'chart.umd.js'));
copy(nm('chart.js', 'LICENSE.md'), path.join(out, 'licenses', 'chart.js.md'));
copy(nm('sortablejs', 'Sortable.min.js'), path.join(out, 'Sortable.min.js'));
copy(nm('sortablejs', 'LICENSE'), path.join(out, 'licenses', 'sortablejs.txt'));

let css = '/* IBM Plex Sans / Mono (SIL Open Font License 1.1), latin + latin-ext subsets */\n';
for (const { pkg, weights } of FONTS) {
  copy(nm(pkg, 'LICENSE'), path.join(out, 'licenses', `${path.basename(pkg)}.txt`));
  for (const weight of weights) {
    const source = fs.readFileSync(nm(pkg, `${weight}.css`), 'utf8');
    // Each subset is a block that starts with a comment like "/* ibm-plex-sans-latin-400-normal */"
    for (const block of source.split('/*').slice(1)) {
      const name = block.slice(0, block.indexOf('*/')).trim();
      const subset = SUBSETS.find((s) => name.endsWith(`-${s}-${weight}-normal`));
      if (!subset) continue;
      const file = `${name}.woff2`;
      copy(nm(pkg, 'files', file), path.join(out, 'fonts', file));
      const face = block
        .slice(block.indexOf('*/') + 2)
        .replace(/src:[^;]+;/, `src: url(./${file}) format('woff2');`)
        .trim();
      css += `/* ${name} */\n${face}\n`;
    }
  }
}
fs.writeFileSync(path.join(out, 'fonts', 'fonts.css'), css);

const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else files.push(path.relative(out, p));
  }
})(out);
console.log(`public/vendor: ${files.length} dosya`);
