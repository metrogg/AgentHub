import { migrate } from 'drizzle-orm/bun-sqlite/migrator'

process.env.AGENTHUB_SKIP_LEGACY_SCHEMA = '1'

const { db, migrationsPath } = await import('./index')

console.log('Running migrations...')
migrate(db, { migrationsFolder: migrationsPath })
console.log('Migrations complete.')
