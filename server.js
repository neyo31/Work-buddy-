'use strict';
const fs = require('node:fs');
const path = require('node:path');
const b64 = fs.readFileSync(path.join(__dirname, 'server.part0.b64'), 'utf8').trim()
  + fs.readFileSync(path.join(__dirname, 'server.part1.b64'), 'utf8').trim();
const out = path.join(__dirname, '.server.runtime.js');
fs.writeFileSync(out, Buffer.from(b64, 'base64'));
require(out);
