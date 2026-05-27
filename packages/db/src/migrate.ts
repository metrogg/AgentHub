import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { db, migrationsPath } from './index'

console.log('Running migrations...')
migrate(db, { migrationsFolder: migrationsPath })
console.log('Migrations complete.')
