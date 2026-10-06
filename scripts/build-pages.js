/* ==========================================================================
   Builds the GitHub Pages version into _site/ — the same pages as public/,
   with the API running in the browser instead of on a server.

     node scripts/build-pages.js        (or: npm run build:pages)

   Adds to each page, before js/api.js:
     js/server-defaults.js   reference data from server/defaults.js
     js/server-app.js        the API (server/app.js)
     js/demo-sessions.js     demo drills for a first visit (server/demo-sessions.js)
     js/local-server.js      answers /api/… in the browser (pages/local-server.js)
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, '_site');
const SCRIPTS = ['server-defaults.js', 'server-app.js', 'demo-sessions.js', 'local-server.js'];

fs.rmSync(OUT, { recursive: true, force: true });
fs.cpSync(path.join(ROOT, 'public'), OUT, { recursive: true });

const js = path.join(OUT, 'js');
fs.writeFileSync(path.join(js, 'server-defaults.js'),
  '/* Generated from server/defaults.js by scripts/build-pages.js */\nself.EPBDefaults = ' + JSON.stringify(require('../server/defaults')) + ';\n');
fs.copyFileSync(path.join(ROOT, 'server', 'app.js'), path.join(js, 'server-app.js'));
fs.copyFileSync(path.join(ROOT, 'server', 'demo-sessions.js'), path.join(js, 'demo-sessions.js'));
fs.copyFileSync(path.join(ROOT, 'pages', 'local-server.js'), path.join(js, 'local-server.js'));

const tag = '<script src="js/api.js"></script>';
for (const f of fs.readdirSync(OUT).filter(f => f.endsWith('.html'))) {
  const file = path.join(OUT, f);
  const html = fs.readFileSync(file, 'utf8');
  if (!html.includes(tag)) throw new Error(f + ' does not load js/api.js — cannot add the browser back end.');
  fs.writeFileSync(file, html.replace(tag, SCRIPTS.map(s => `<script src="js/${s}"></script>\n`).join('') + tag));
}

console.log('Built ' + path.relative(ROOT, OUT) + '/ for GitHub Pages.');
