// Run once, before anyone has registered: node scripts/init-admin.js
// Prints an invite code you use to register the first (admin) account.
require('dotenv').config();
const crypto = require('crypto');
const db = require('../db');

const accountCount = db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n;
if (accountCount > 0) {
  console.log('Accounts already exist — use an admin account to generate more invites via the app instead.');
  process.exit(0);
}

const code = crypto.randomBytes(6).toString('hex');
db.prepare('INSERT INTO invites (code) VALUES (?)').run(code);
console.log('First invite code (this account will become admin):');
console.log(code);
