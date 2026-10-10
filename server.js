'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const parts = [0,1,2].map((i) => fs.readFileSync(path.join(__dirname, 'server.part' + i + '.b64'), 'utf8'));
const code = zlib.inflateSync(Buffer.from(parts.join(''), 'base64')).toString('utf8');
const bundle = path.join(__dirname, '.server.bundle.js');
fs.writeFileSync(bundle, code);
require(bundle);
