'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

// Each repository part is base64-encoded separately; decode each part first,
// then concatenate the compressed bytes in numeric order.
const parts = Array.from({ length: 8 }, (_, i) =>
  Buffer.from(fs.readFileSync(path.join(__dirname, 'bf' + i + '.b64'), 'utf8').trim(), 'base64')
);
const code = zlib.inflateSync(Buffer.concat(parts)).toString('utf8');
const bundle = path.join(__dirname, '.bot.bundle.js');
fs.writeFileSync(bundle, code, 'utf8');
require(bundle);
