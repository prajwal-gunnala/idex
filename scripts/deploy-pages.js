/* ==========================================================================
   Publishes the GitHub Pages demo: builds _site/ and force-pushes it as the
   only commit on the gh-pages branch of origin. GitHub serves that branch at
   https://<user>.github.io/<repo>/ (Settings → Pages → Branch: gh-pages).

     npm run deploy:pages
   ========================================================================== */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const git = (args, cwd = ROOT) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

require('./build-pages');

const remote = git(['remote', 'get-url', 'origin']);
const rev = git(['rev-parse', '--short', 'HEAD']);
const dirty = git(['status', '--porcelain']) ? ' (with uncommitted changes)' : '';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epb-pages-'));
try {
  fs.cpSync(path.join(ROOT, '_site'), tmp, { recursive: true });
  fs.writeFileSync(path.join(tmp, '.nojekyll'), '');      // serve files as they are
  git(['init', '-q', '-b', 'gh-pages'], tmp);
  git(['add', '-A'], tmp);
  git(['-c', 'user.name=' + git(['config', 'user.name']), '-c', 'user.email=' + git(['config', 'user.email']),
       'commit', '-q', '-m', 'Build GitHub Pages demo from ' + rev + dirty], tmp);
  execFileSync('git', ['push', '-q', '-f', remote, 'gh-pages'], { cwd: tmp, stdio: 'inherit' });
  console.log('Pushed to gh-pages; GitHub publishes it in a minute or two.');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
