import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closePool, pool } from './pool.js';

// Numbered .sql files applied in filename order, each in its own transaction,
// recorded in schema_migrations. Forward-only: nothing here rolls back, and
// Phase 2.4's ALTER TABLE stays readable verbatim in the repo.
const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../migrations',
);

async function migrate() {
  if (!pool) {
    console.error('DATABASE_URL is not set');
    process.exitCode = 1;
    return;
  }

  await pool.query(`
    create table if not exists schema_migrations (
      version    text primary key,
      applied_at timestamptz not null default now()
    )
  `);

  const files = (await fs.readdir(migrationsDir))
    .filter((name) => name.endsWith('.sql'))
    .sort();

  const { rows } = await pool.query('select version from schema_migrations');
  const applied = new Set(rows.map((row) => row.version));

  let appliedNow = 0;

  for (const file of files) {
    if (applied.has(file)) {
      console.log(`skipped  ${file}`);
      continue;
    }

    const sql = await fs.readFile(path.join(migrationsDir, file), 'utf8');
    const client = await pool.connect();

    try {
      await client.query('begin');
      await client.query(sql);
      await client.query('insert into schema_migrations (version) values ($1)', [file]);
      await client.query('commit');
      appliedNow += 1;
      console.log(`applied  ${file}`);
    } catch (err) {
      await client.query('rollback').catch(() => {});
      console.error(`failed   ${file}`);
      console.error(err.message);
      process.exitCode = 1;
      return;
    } finally {
      client.release();
    }
  }

  console.log(`${appliedNow} applied, ${files.length - appliedNow} skipped`);
}

try {
  await migrate();
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await closePool();
}
