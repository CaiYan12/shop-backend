import type { DbConfig } from '../config.ts'

/** DbConfig → mysql2 连接参数的公共部分；时区取 Z，与 UTC 会话设置配合（D50）。 */
export function mysqlConnectionOptions (db: DbConfig): {
  host: string
  port: number
  user: string
  password: string
  timezone: 'Z'
} {
  return {
    host: db.host,
    port: db.port,
    user: db.user,
    password: db.password,
    timezone: 'Z',
  }
}
