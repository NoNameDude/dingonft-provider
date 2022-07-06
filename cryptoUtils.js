const crypto = require("crypto");
const secp256k1 = require("secp256k1");
const bs58 = require("bs58");

const isBs58 = (x) => {
  return x.match(/^[1-9A-HJ-NP-Za-km-z]+$/);
};

// Helper SHA256.
const sha256 = (x) => {
  return crypto.createHash("sha256").update(x).digest();
};

// Heper HMAC-SHA256.
const hmacsha256 = (x, k) => {
  return crypto.createHmac("sha256", k).update(x).digest();
};

// Helper RIPEMD160.
const ripemd160 = (x) => {
  return crypto.createHash("ripemd160").update(x).digest();
};

// Creates a random Dingocoin private key.
const randomPrivateKey = () => {
  return crypto.randomBytes(32);
};

// Validate WIF.
const isWif = (wif) => {
  if (!isBs58(wif)) {
    return false;
  }
  const raw = bs58.decode(wif);
  if (raw.length !== 37 && raw.length !== 38) {
    return false;
  }
  if (raw[0] !== 0x9e) {
    return false;
  }
  const checksum = sha256(sha256(raw.slice(0, raw.length - 4)));
  return raw.slice(raw.length - 4, raw.length).equals(checksum.slice(0, 4));
};

// Export private key to WIF.
const toWif = (privKey) => {
  const header = Buffer.from([0x9e]);
  const data = privKey;
  const extra = Buffer.from([0x01]);
  const checksum = sha256(sha256(Buffer.concat([header, data, extra])));
  return bs58.encode(
    Buffer.concat([header, data, extra, checksum.slice(0, 4)])
  );
};

// Import private key from WIF.
const fromWif = (wif) => {
  if (!isWif(wif)) {
    throw new Error("Incorrect or unsupported format");
  }
  return bs58.decode(wif).slice(1, 1 + 32);
};

// Validate Dingocoin address.
const isAddress = (address) => {
  if (!isBs58(address)) {
    return false;
  }
  const raw = bs58.decode(address);

  if (raw.length !== 25) {
    return false;
  }
  if (raw[0] !== 0x16 && raw[0] !== 0x1e) {
    return false;
  }
  const checksum = sha256(sha256(raw.slice(0, 21)));
  return raw.slice(21, 25).equals(checksum.slice(0, 4));
};

// SECP256k1 private key to public key.
const privateKeyToPublicKey = (privKey) => {
  const pubKey = secp256k1.publicKeyCreate(
    new Uint8Array(privKey),
    (compressed = true)
  );
  return Buffer.from(pubKey);
};

// Create Dingocoin address from public key.
const publicKeyToAddress = (pubKey) => {
  const data = ripemd160(sha256(pubKey));
  const header = Buffer.from([0x1e]);
  const checksum = sha256(sha256(Buffer.concat([header, data]))).slice(0, 4);
  return bs58.encode(Buffer.concat([header, data, checksum]));
};

// Create Dingocoin address from secp256k1 priv key.
const privateKeyToAddress = (privKey) => {
  return publicKeyToAddress(privateKeyToPublicKey(privKey));
};

const sign = (data, privateKey) => {
  return Buffer.from(secp256k1.ecdsaSign(data, privateKey).signature);
};

const verify = (data, signature, publicKey) => {
  return secp256k1.ecdsaVerify(signature, data, publicKey);
};

const recover = (data, signature) => {
  const results = [];
  for (let i = 0; i < 4; i++) {
    try {
      results.push(Buffer.from(secp256k1.ecdsaRecover(signature, i, data)));
    } catch {}
  }
  return results;
};

// Encrypts data with random PBKDF2 salt and AES-256-CBC IV parameters.
var encrypt = (data, key) => {
  // Cipher.
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  cipher.setAutoPadding(true);
  const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);

  return {
    iv: iv,
    ciphertext: ciphertext,
  };
};

// Decrypts data with given parameters.
var decrypt = (ciphertext, key, iv) => {
  // Cipher.
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  decipher.setAutoPadding(true);
  const data = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  return data;
};

module.exports = {
  isWif,
  toWif,
  fromWif,
  randomPrivateKey,
  sha256,
  hmacsha256,
  isAddress,
  privateKeyToPublicKey,
  publicKeyToAddress,
  privateKeyToAddress,
  sign,
  verify,
  recover,
  encrypt,
  decrypt,
};
