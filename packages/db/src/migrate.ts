import { migrate } from 'drizzle-orm/bun-sqlite/migrator'

const { db, migrationsPath } = await import('./index')

console.log('Running migrations...')
migrate(db, { migrationsFolder: migrationsPath })
console.log('Migrations complete.')
