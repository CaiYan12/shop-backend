import { migrate } from 'drizzle-orm/mysql2/migrator'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Database } from './client.ts'

/** 迁移目录固定为仓库根的 ./drizzle（D53）。 */
export const MIGRATIONS_FOLDER = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle')

/** 与 drizzle-kit migrate 使用同一套迁移记录表与时间戳水位线（D51）。 */
export async function runMigrations (db: Database): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER })
}
