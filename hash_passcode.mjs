// node tools/hash_passcode.mjs <DELETE_SALT> <passcode>   -> prints DELETE_PASSCODE_HASH
import crypto from 'node:crypto';
const [salt, pass] = process.argv.slice(2);
console.log(crypto.createHash('sha256').update(salt + pass).digest('hex'));
