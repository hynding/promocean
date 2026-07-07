import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import type { Db } from './index.js'

export async function runMigrations(db: Db): Promise<void> {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations')
  await migrate(db, { migrationsFolder: dir })
}
