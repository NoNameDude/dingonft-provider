const crypto = require('crypto');

console.log(`storagePrivateKey = ${crypto.randomBytes(32).toString('hex')}`);
console.log(`addressingSecret = ${crypto.randomBytes(64).toString('hex')}`);
console.log(`platformPrivateKey = ${crypto.randomBytes(32).toString('hex')}`);
