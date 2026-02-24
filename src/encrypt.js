const crypto = require('crypto');
const os = require('os');

/** @param {string} salt @returns {Buffer} */
function deriveKey(salt) {
  const material = `${os.hostname()}:${process.getuid()}`;
  return crypto.pbkdf2Sync(material, salt, 100_000, 32, 'sha256');
}

/** @param {string} text @param {Buffer} key @returns {string} */
function encrypt(text, key) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

/** @param {string} encrypted @param {Buffer} key @returns {string} */
function decrypt(encrypted, key) {
  const [ivHex, authTagHex, cipherHex] = encrypted.split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(cipherHex, 'hex')), decipher.final()]).toString('utf8');
}

module.exports = { deriveKey, encrypt, decrypt };
