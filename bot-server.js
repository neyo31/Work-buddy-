'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

// The worker bundle is stored as consecutive base64 chunks in the repository.
// Join the chunks before decoding: they are slices of one compressed stream.
const encoded = Array.from({ length: 8 }, (_, i) =>
  fs.readFileSync(path.join(__dirname, 'bf' + i + '.b64'), 'utf8').trim()
).join('');
const code = zlib.inflateSync(Buffer.from(encoded, 'base64')).toString('utf8');
const bundle = path.join(__dirname, '.bot.bundle.js');
fs.writeFileSync(bundle, code, 'utf8');
require(bundle);
