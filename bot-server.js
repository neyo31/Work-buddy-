'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const vm = require('node:vm');

const b64 = Array.from({ length: 8 }, (_, i) =>
  fs.readFileSync(path.join(__dirname, 'bf' + i + '.b64'), 'utf8').trim()
).join('');
const packed = Buffer.from(b64, 'base64');
let code = zlib.inflateSync(packed).toString('utf8');

new vm.Script(code, { filename: 'work-buddy-bot.bundle.js' });
const bundle = path.join(__dirname, '.bot.bundle.js');
fs.writeFileSync(bundle, code, 'utf8');
require(bundle);
