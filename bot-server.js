'use strict';
const fs = require('node:fs');
const path = require('node:path');
const code = [0,1,2,3,4,5].map((i) => fs.readFileSync(path.join(__dirname, 'bfj' + i + '.js'), 'utf8')).join('');
const bundle = path.join(__dirname, '.bot.bundle.js');
fs.writeFileSync(bundle, code);
require(bundle);
