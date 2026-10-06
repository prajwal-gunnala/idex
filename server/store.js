/* ==========================================================================
   JSON document store — the whole database lives in one file.
   Held in memory; writes are batched and made atomic (temp file + rename)
   so a crash mid-write never leaves a half-written database behind.
   Sized for a ship's company: hundreds of users, thousands of sessions.
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

class Store {
  constructor(file, seed) {
    this.file = file;
    this.timer = null;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) {
      this.data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } else {
      this.data = seed();
      this.flush();
    }
  }

  /* Schedule a write; many changes in quick succession become one write. */
  save() {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, 120);
  }

  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1));
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { Store };
