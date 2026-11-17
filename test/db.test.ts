import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import type { Pool, PoolConnection } from 'mysql2/promise'
import type { RowDataPacket } from 'mysql2'
import { createDb, createPool, type Database } from '../src/db/client.ts'
import { runMigrations } from '../src/db/migrate.ts'
import { loadTestConfig } from './helpers/test-config.ts'

const config = loadTestConfig()
let pool: Pool
let db: Database

before(async () => {
  pool = createPool(config)
  db = createDb(pool)
  await runMigrations(db)
})

after(async () => {
  await pool.end()
})

async function schemaSnapshot (): Promise<{ migrationCount: number, createTable: string }> {
  const [migrations] = await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS count FROM __drizzle_migrations')
  const [createTable] = await pool.query<RowDataPacket[]>('SHOW CREATE TABLE categories')
  return {
    migrationCount: Number(migrations[0]!.count),
    createTable: String(createTable[0]!['Create Table']),
  }
}

test('空库执行迁移后建立商品类型表，slug 有唯一索引', async () => {
  const [tables] = await pool.query<RowDataPacket[]>("SHOW TABLES LIKE 'categories'")
  assert.equal(tables.length, 1, '迁移后应存在 categories 表')

  const [indexes] = await pool.query<RowDataPacket[]>(
    `SELECT INDEX_NAME, COLUMN_NAME FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'categories' AND NON_UNIQUE = 0`,
    [config.db.database],
  )
  assert.ok(
    indexes.some((row) => row.COLUMN_NAME === 'slug'),
    'categories.slug 应有唯一索引',
  )
})

test('重复 slug 被数据库拒绝', async () => {
  await pool.query("INSERT INTO categories (slug, name) VALUES ('demo-category', '演示商品类型')")
  await assert.rejects(
    pool.query("INSERT INTO categories (slug, name) VALUES ('demo-category', '另一个商品类型')"),
    (error: unknown) => (error as { code?: string }).code === 'ER_DUP_ENTRY',
  )
})

test('再执行一次迁移为 no-op：迁移记录数与表结构不变', async () => {
  const beforeRun = await schemaSnapshot()
  assert.ok(beforeRun.migrationCount >= 1, '首次迁移应写入迁移记录')

  await runMigrations(db)

  const afterRun = await schemaSnapshot()
  assert.deepEqual(afterRun, beforeRun)
})

test('库与表使用 utf8mb4，实际定义经查询确认', async () => {
  const [schemas] = await pool.query<RowDataPacket[]>(
    'SELECT DEFAULT_CHARACTER_SET_NAME, DEFAULT_COLLATION_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?',
    [config.db.database],
  )
  assert.equal(schemas[0]!.DEFAULT_CHARACTER_SET_NAME, 'utf8mb4')
  assert.equal(schemas[0]!.DEFAULT_COLLATION_NAME, 'utf8mb4_0900_ai_ci')

  const [tables] = await pool.query<RowDataPacket[]>(
    `SELECT TABLE_NAME, TABLE_COLLATION FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN ('categories', 'products', 'product_images', 'product_variants')
     ORDER BY TABLE_NAME`,
    [config.db.database],
  )
  assert.deepEqual(
    tables.map((row) => [row.TABLE_NAME, row.TABLE_COLLATION]),
    [
      ['categories', 'utf8mb4_0900_ai_ci'],
      ['product_images', 'utf8mb4_0900_ai_ci'],
      ['product_variants', 'utf8mb4_0900_ai_ci'],
      ['products', 'utf8mb4_0900_ai_ci'],
    ],
    '四张表的默认字符集与排序规则应由迁移锁定',
  )

  const [columns] = await pool.query<RowDataPacket[]>(
    `SELECT COLUMN_NAME, CHARACTER_SET_NAME, COLLATION_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'categories' AND CHARACTER_SET_NAME IS NOT NULL`,
    [config.db.database],
  )
  assert.ok(columns.length >= 2, 'slug 与 name 应为字符列')
  for (const column of columns) {
    assert.equal(column.CHARACTER_SET_NAME, 'utf8mb4', `${String(column.COLUMN_NAME)} 的字符集`)
    assert.equal(column.COLLATION_NAME, 'utf8mb4_0900_ai_ci', `${String(column.COLUMN_NAME)} 的排序规则`)
  }
})

test('新连接的会话时区为 UTC', async () => {
  const connections: PoolConnection[] = await Promise.all(
    Array.from({ length: 3 }, () => pool.getConnection()),
  )
  try {
    const results = await Promise.all(
      connections.map((connection) =>
        connection.query<RowDataPacket[]>('SELECT CONNECTION_ID() AS id, @@session.time_zone AS tz'),
      ),
    )
    const observed = new Map<number, string>()
    for (const [rows] of results) {
      observed.set(Number(rows[0]!.id), String(rows[0]!.tz))
    }
    assert.equal(observed.size, connections.length, '应观察到互不相同的实际连接')
    for (const [id, tz] of observed) {
      assert.equal(tz, '+00:00', `连接 ${id} 的会话时区应为 UTC`)
    }
  } finally {
    for (const connection of connections) connection.release()
  }
})

test('时间往返无偏移：默认时间与显式时间写入后读回一致', async () => {
  const connection = await pool.getConnection()
  try {
    await connection.query(
      'CREATE TEMPORARY TABLE time_probe (id INT PRIMARY KEY, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)',
    )
    const beforeInsert = Date.now()
    await connection.query('INSERT INTO time_probe (id) VALUES (1)')
    const explicit = new Date('2020-01-02T03:04:05.000Z')
    await connection.query('INSERT INTO time_probe (id, created_at) VALUES (2, ?)', [explicit])

    const [rows] = await connection.query<RowDataPacket[]>(
      'SELECT id, created_at, UNIX_TIMESTAMP(created_at) AS epoch FROM time_probe ORDER BY id',
    )
    const afterInsert = Date.now()

    const defaultEpochMs = Number(rows[0]!.epoch) * 1000
    assert.ok(Math.abs(defaultEpochMs - beforeInsert) < 5000, '默认时间与系统时间差应在秒级以内')
    assert.ok(defaultEpochMs <= afterInsert + 1000, '默认时间不应晚于系统时间')

    assert.equal(Number(rows[1]!.epoch), Math.floor(explicit.getTime() / 1000), '显式时间写入后读回不应偏移')
    assert.equal((rows[1]!.created_at as Date).getTime(), explicit.getTime(), '客户端按 Z 解析时间')
  } finally {
    connection.release()
  }
})
test('drizzle-kit 配置与运行时初始化共用 snake_case casing', async () => {
  const { DB_CASING } = await import('../src/db/casing.ts')
  const { default: drizzleConfig } = await import('../drizzle.config.ts')
  assert.equal(drizzleConfig.casing, DB_CASING)
})
