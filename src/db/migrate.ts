import { migrate } from 'drizzle-orm/mysql2/migrator'
import { resolve } from 'node:path'
import { BACKEND_ROOT } from '../backend-root.ts'
import type { Database } from './client.ts'

/** 迁移目录固定为仓库根的 ./drizzle（D53）。 */
export const MIGRATIONS_FOLDER = resolve(BACKEND_ROOT, 'drizzle')

/** 与 drizzle-kit migrate 使用同一套迁移记录表与时间戳水位线（D51）。 */
export async function runMigrations (db: Database): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER })
}
