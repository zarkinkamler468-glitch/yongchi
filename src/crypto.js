'use strict';

const crypto = require('node:crypto');

// 密码哈希（scrypt + 随机盐）
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(String(password), salt, 32);
  const expected = Buffer.from(hash, 'hex');
  return test.length === expected.length && crypto.timingSafeEqual(test, expected);
}

// 随机令牌
function createToken() {
  return crypto.randomBytes(24).toString('hex');
}

module.exports = { hashPassword, verifyPassword, createToken };
