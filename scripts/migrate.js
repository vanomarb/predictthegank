/**
 * Applies the SQL files in migrations/ to the database, once each, in order.
 *
 *   npm run migrate                  # apply everything still pending
 *   npm run migrate -- --status      # list applied/pending, touch nothing
 *   npm run migrate -- --dry-run     # say what would run, run none of it
 *   npm run migrate -- --baseline    # record every file as applied, run none
 *
 * Until this existed the migrations were applied by hand, and which ones a
 * given database had seen was worked out by reading information_schema and
 * comparing it against the files. That is fine for one database and one person
 * and stops being fine immediately after.
 *
 * What tracks the state is the schema_migrations table: one row per applied
 * file, written inside the same transaction as the migration itself, so a
 * failed migration leaves neither its DDL nor its row behind and re-running is
 * always safe. It is created on first use, which makes this script bootstrap
 * its own bookkeeping on an empty database.
 *
 * Order is filename order, which is why the numeric prefix matters. Two files
 * sharing a prefix (0006_alerts.sql and 0006_phase_history.sql both exist) are
 * still ordered deterministically — alphabetically, within the prefix — but a
 * duplicate is called out, because a prefix is supposed to be the answer to
 * "which ran first?" and a duplicated one cannot be.
 *
 * IMPORTANT — an existing database must be baselined before its first run.
 * These files are not all idempotent: 0004 opens with DROP TABLE IF EXISTS
 * smart_predictions, so replaying it against a live database throws away the
 * current prediction, and 0007 drops a column. On a database that already has
 * the schema but no schema_migrations table this refuses to run and asks for
 * --baseline, which records the files as applied without executing any of
 * them. Getting that wrong is a data-loss bug, not an inconvenience, so it is
 * a hard stop rather than a warning.
 *
 * Concurrency: everything happens under a Postgres advisory lock, so two
 * runners — two deploys, or a deploy and someone's terminal — queue instead of
 * racing to apply the same file twice.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../db');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');
// Any constant works as long as it never changes; this is "migrate" as an int.
const LOCK_KEY = 4113404;

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

// The bookkeeping table. Checksums are stored so an edit to a file that has
// already run can be reported: the database has the old version, the repo has
// the new one, and nothing will reconcile the two on its own.
async function ensureTrackingTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    TEXT PRIMARY KEY,
      checksum    TEXT NOT NULL,
      applied_at  BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM now())::bigint,
      duration_ms INTEGER NOT NULL DEFAULT 0
    )
  `);
}

async function trackingTableExists(client) {
  const { rows } = await client.query(
    `SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present`);
  return rows[0].present;
}

// "Has this database already been used?" — accounts is in 0001, so its
// presence means the schema predates this script and the applied set cannot be
// inferred. Deliberately not a count of rows: an empty accounts table on a
// migrated database still must not have 0004 replayed over it.
async function schemaAlreadyExists(client) {
  const { rows } = await client.query(
    `SELECT to_regclass('public.accounts') IS NOT NULL AS present`);
  return rows[0].present;
}

function readMigrations() {
  let names;
  try {
    names = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
  } catch (e) {
    fail(`cannot read ${MIGRATIONS_DIR}: ${e.message}`);
  }
  if (!names.length) fail(`no .sql files in ${MIGRATIONS_DIR}`);

  names.sort();
  return names.map((filename) => {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf8');
    return {
      filename,
      sql,
      checksum: crypto.createHash('sha256').update(sql).digest('hex'),
    };
  });
}

// A duplicated numeric prefix is not fatal — the sort is still stable — but it
// means the filenames no longer state the order. Only worth saying while one of
// the duplicates is still pending, i.e. while the order is about to matter:
// migrations/ has a long-applied 0006 pair, and warning about it on every run
// forever trains people to ignore the warnings that do matter.
function warnOnDuplicatePrefixes(migrations, applied) {
  const seen = new Map();
  for (const m of migrations) {
    const prefix = m.filename.slice(0, 4);
    if (!seen.has(prefix)) seen.set(prefix, []);
    seen.get(prefix).push(m.filename);
  }
  for (const [prefix, files] of seen) {
    if (files.length > 1 && files.some((f) => !applied.has(f))) {
      console.warn(`warning: ${files.length} migrations share the prefix ${prefix} `
        + `(${files.join(', ')}) — they run in the order listed`);
    }
  }
}

function reportDrift(migrations, applied) {
  for (const m of migrations) {
    const row = applied.get(m.filename);
    if (row && row.checksum !== m.checksum) {
      console.warn(`warning: ${m.filename} has changed since it was applied `
        + `(${new Date(row.applied_at * 1000).toISOString().slice(0, 10)}). The database has `
        + `the old version; editing an applied migration does not re-run it. `
        + `Write a new migration instead.`);
    }
  }
  for (const filename of applied.keys()) {
    if (!migrations.some((m) => m.filename === filename)) {
      console.warn(`warning: ${filename} is recorded as applied but is no longer in `
        + `migrations/ — the database has changes with no file describing them`);
    }
  }
}

async function loadApplied(client) {
  const { rows } = await client.query(
    'SELECT filename, checksum, applied_at FROM schema_migrations');
  return new Map(rows.map((r) => [r.filename, r]));
}

function printStatus(migrations, applied) {
  for (const m of migrations) {
    const row = applied.get(m.filename);
    const mark = row ? 'applied' : 'pending';
    const when = row ? new Date(row.applied_at * 1000).toISOString().replace('T', ' ').slice(0, 19) : '';
    console.log(`  ${mark.padEnd(8)} ${m.filename.padEnd(38)} ${when}`);
  }
}

// Each file gets its own transaction: one bad migration stops the run without
// rolling back the good ones before it, and without leaving a half-applied
// file recorded as done. Postgres runs DDL transactionally, so this holds for
// CREATE TABLE and DROP COLUMN alike.
async function applyOne(client, migration) {
  const started = Date.now();
  try {
    await client.query('BEGIN');
    await client.query(migration.sql);
    const durationMs = Date.now() - started;
    await client.query(
      `INSERT INTO schema_migrations (filename, checksum, duration_ms) VALUES ($1, $2, $3)`,
      [migration.filename, migration.checksum, durationMs]);
    await client.query('COMMIT');
    return { ok: true, durationMs };
  } catch (e) {
    await client.query('ROLLBACK');
    return { ok: false, message: e.message };
  }
}

async function main() {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => !['--status', '--dry-run', '--baseline'].includes(a));
  if (unknown.length) {
    fail(`unknown argument: ${unknown.join(', ')}\n`
      + `usage: npm run migrate [-- --status | --dry-run | --baseline]`);
  }
  const statusOnly = args.includes('--status');
  const dryRun = args.includes('--dry-run');
  const baseline = args.includes('--baseline');
  if (baseline && (statusOnly || dryRun)) fail('--baseline cannot be combined with other flags');

  const migrations = readMigrations();
  const client = await db.pool.connect();

  try {
    // Nothing below this point may run twice concurrently, including the
    // baseline check itself.
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);

    const tracked = await trackingTableExists(client);
    if (!tracked && !baseline && await schemaAlreadyExists(client)) {
      fail(`This database already has the schema but no schema_migrations table, so which\n`
        + `migrations it has seen is unknown, and some of them cannot safely be replayed\n`
        + `(0004 drops smart_predictions; 0007 drops a column).\n\n`
        + `If its schema is up to date with migrations/, record that and run nothing:\n`
        + `    npm run migrate -- --baseline\n\n`
        + `If it is not, apply the missing files by hand first, then baseline.`);
    }

    if (statusOnly && !tracked) {
      console.log(`schema_migrations does not exist yet — nothing has been recorded.`);
      console.log(`${migrations.length} migration file(s) on disk:`);
      for (const m of migrations) console.log(`  pending  ${m.filename}`);
      return;
    }

    if (!statusOnly) await ensureTrackingTable(client);
    const applied = await loadApplied(client);

    warnOnDuplicatePrefixes(migrations, applied);
    reportDrift(migrations, applied);

    if (statusOnly) {
      const pending = migrations.filter((m) => !applied.has(m.filename)).length;
      console.log(`${applied.size} applied, ${pending} pending:`);
      printStatus(migrations, applied);
      return;
    }

    const pending = migrations.filter((m) => !applied.has(m.filename));

    if (baseline) {
      if (!pending.length) {
        console.log('already baselined — every migration is recorded as applied');
        return;
      }
      for (const m of pending) {
        await client.query(
          `INSERT INTO schema_migrations (filename, checksum, duration_ms) VALUES ($1, $2, 0)
           ON CONFLICT (filename) DO NOTHING`,
          [m.filename, m.checksum]);
        console.log(`  baselined ${m.filename} (not executed)`);
      }
      console.log(`\nRecorded ${pending.length} migration(s) as applied without running them.`);
      return;
    }

    if (!pending.length) {
      console.log(`up to date — ${applied.size} migration(s) applied, none pending`);
      return;
    }

    console.log(`${applied.size} applied, ${pending.length} pending:\n`);
    for (const m of pending) {
      process.stdout.write(`  ${m.filename.padEnd(38)} `);
      if (dryRun) {
        console.log('would apply');
        continue;
      }
      const res = await applyOne(client, m);
      if (!res.ok) {
        console.log('FAILED (rolled back)');
        fail(`\n${m.filename}: ${res.message}\n\n`
          + `Nothing from this file was applied. Migrations before it stand.`);
      }
      console.log(`ok (${res.durationMs}ms)`);
    }

    console.log(dryRun
      ? `\n${pending.length} migration(s) would be applied. Re-run without --dry-run.`
      : `\nApplied ${pending.length} migration(s).`);
  } finally {
    // Releasing explicitly is tidiness, not necessity — the lock is session
    // scoped and the pool closes below either way.
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    client.release();
    await db.pool.end();
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
