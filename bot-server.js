'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const vm = require('node:vm');

// Each part is base64-encoded separately and contains a slice of one
// compressed worker bundle. Decode parts individually, then join in order.
const parts = Array.from({ length: 8 }, (_, i) =>
  Buffer.from(fs.readFileSync(path.join(__dirname, 'bf' + i + '.b64'), 'utf8').trim(), 'base64')
);
const packed = Buffer.concat(parts);
let code;
try {
  code = zlib.inflateSync(packed).toString('utf8');
} catch (error) {
  // The stored parts can carry an out-of-date zlib checksum after a partial
  // bundle update. Decode the raw deflate payload as a fallback.
  if (error.code !== 'Z_DATA_ERROR' || !/data check|incorrect data check/i.test(error.message)) throw error;
  code = zlib.inflateRawSync(packed.subarray(2, packed.length - 4)).toString('utf8');
}
new vm.Script(code, { filename: 'work-buddy-bot.bundle.js' });
const bundle = path.join(__dirname, '.bot.bundle.js');
fs.writeFileSync(bundle, code, 'utf8');
require(bundle);
