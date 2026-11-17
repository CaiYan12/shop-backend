import { drizzle } from 'drizzle-orm/mysql2'
import { createPool as createMysqlPool } from 'mysql2/promise'
import type { Pool } from 'mysql2/promise'
import type { PoolConnection as CallbackPoolConnection } from 'mysql2'
import type { AppConfig } from '../config.ts'
import { DB_CASING } from './casing.ts'
import * as schema from './schema.ts'

/** 每个实际连接在首次业务查询前执行的会话设置：统一 UTC（D50）。 */
export const UTC_SESSION_SQL = "SET time_zone = '+00:00'"

/**
 * 连接池：客户端时区取 Z；新连接创建时排队执行 UTC 会话设置，
 * 同一连接上的第一条业务查询必然排在其后。
 *
 * 注意：mysql2 的 'connection' 事件给出的是回调式连接（不是 promise 包装），
 * 因此这里用回调式 query；用 .catch 会被 mysql2 判为编程错误。
 */
export function createPool (config: AppConfig): Pool {
  const pool = createMysqlPool({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
    charset: 'UTF8MB4_0900_AI_CI',
    timezone: 'Z',
    waitForConnections: true,
    connectionLimit: 10,
  })

  pool.on('connection', (connection) => {
    const callbackConnection = connection as unknown as CallbackPoolConnection
    callbackConnection.query(UTC_SESSION_SQL, (error) => {
      if (error === null) return
      callbackConnection.destroy()
      console.error('[db] UTC 会话设置失败，已丢弃该连接：', error.message)
    })
  })

  return pool
}

/** 运行时 drizzle 实例；casing 与 drizzle-kit 配置共用同一常量（D53）。 */
export function createDb (pool: Pool) {
  return drizzle(pool, { schema, casing: DB_CASING, mode: 'default' })
}

export type Database = ReturnType<typeof createDb>
