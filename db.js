const { Pool, types } = require('pg');

// int8/bigint (OID 20) comes back from pg as a string by default since JS numbers
// can't safely hold the full range. Every bigint column here (id, ts, created_at,
// logged_at) fits safely in a JS number for this app's scale, so coerce it back
// to keep the existing JSON contract with the frontend unchanged.
types.setTypeParser(20, (val) => parseInt(val, 10));

const CONNECTION_STRING = process.env.SUPABASE_DB_URL;
if (!CONNECTION_STRING) {
  throw new Error('SUPABASE_DB_URL must be set in the environment (see .env.example)');
}

const pool = new Pool({
  connectionString: CONNECTION_STRING,
  ssl: { rejectUnauthorized: false },
  max: process.env.VERCEL ? 3 : 10,
});

module.exports = {
  pool,
  query: (text, params) => pool.query(text, params),
  one: async (text, params) => (await pool.query(text, params)).rows[0] || null,
  many: async (text, params) => (await pool.query(text, params)).rows,
};
