import { createConnection } from 'mysql2/promise'
import type { RowDataPacket } from 'mysql2'
import type { AppConfig } from '../config.ts'
import { mysqlConnectionOptions } from './connection-options.ts'

const DATABASE_NAME_PATTERN = /^[A-Za-z0-9_$]+$/

export interface DatabaseDefinition {
  name: string
  characterSet: string
  collation: string
}

/** 以 utf8mb4 + utf8mb4_0900_ai_ci 创建数据库；drop 为 true 时先删除（测试重建用）。 */
export async function createDatabase (
  config: AppConfig,
  options: { drop?: boolean } = {},
): Promise<DatabaseDefinition> {
  const name = config.db.database
  if (!DATABASE_NAME_PATTERN.test(name)) {
    throw new Error(`数据库名只允许字母、数字、下划线与 $：${name}`)
  }

  const connection = await createConnection(mysqlConnectionOptions(config.db))

  try {
    if (options.drop === true) {
      await connection.query(`DROP DATABASE IF EXISTS \`${name}\``)
    }
    await connection.query(
      `CREATE DATABASE IF NOT EXISTS \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
    )

    const [rows] = await connection.query<RowDataPacket[]>(
      'SELECT DEFAULT_CHARACTER_SET_NAME, DEFAULT_COLLATION_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?',
      [name],
    )
    const row = rows[0]
    if (row === undefined) {
      throw new Error(`数据库 ${name} 创建后未在 information_schema 中找到`)
    }
    return {
      name,
      characterSet: String(row.DEFAULT_CHARACTER_SET_NAME),
      collation: String(row.DEFAULT_COLLATION_NAME),
    }
  } finally {
    await connection.end()
  }
}
