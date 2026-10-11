'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const vm = require('node:vm');

const parts = Array.from({ length: 8 }, (_, i) =>
  Buffer.from(fs.readFileSync(path.join(__dirname, 'bf' + i + '.b64'), 'utf8').trim(), 'base64')
);
const packed = Buffer.concat(parts);
let code;
try {
  code = zlib.inflateSync(packed).toString('utf8');
} catch (error) {
  if (error.code !== 'Z_DATA_ERROR' || !/data check|incorrect data check/i.test(error.message)) throw error;
  code = zlib.inflateRawSync(packed.subarray(2, packed.length - 4)).toString('utf8');
}

// Repair the known malformed label fallback at the boundary between the
// stored bundle fragments. Keep this narrow so unrelated code is untouched.
code = code.replace(
  "f.label || a'Item ' + (i + 1)))",
  "f.label || ('Item ' + (i + 1)))"
);
new vm.Script(code, { filename: 'work-buddy-bot.bundle.js' });
const bundle = path.join(__dirname, '.bot.bundle.js');
fs.writeFileSync(bundle, code, 'utf8');
require(bundle);
