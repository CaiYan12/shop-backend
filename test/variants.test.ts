import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import type { Pool } from 'mysql2/promise'
import type { ResultSetHeader, RowDataPacket } from 'mysql2'
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

interface ColumnRow extends RowDataPacket {
  COLUMN_NAME: string
  COLUMN_TYPE: string
  IS_NULLABLE: string
  COLLATION_NAME: string | null
}

async function columnsOf (table: string): Promise<Map<string, ColumnRow>> {
  const [rows] = await pool.query<ColumnRow[]>(
    `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLLATION_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
    [config.db.database, table],
  )
  return new Map(rows.map((row) => [row.COLUMN_NAME, row]))
}

test('迁移后建立规格组合表：字段、商品外键与价格类型齐全', async () => {
  const columns = await columnsOf('product_variants')
  assert.deepEqual([...columns.keys()], [
    'id', 'product_id', 'sku', 'option1_value', 'option2_value', 'price', 'original_price', 'stock',
  ])

  for (const name of ['product_id', 'sku', 'option1_value', 'option2_value', 'price', 'original_price', 'stock']) {
    assert.equal(columns.get(name)!.IS_NULLABLE, 'NO', `product_variants.${name} 应为 NOT NULL`)
  }
  assert.equal(columns.get('id')!.COLUMN_TYPE, 'int')
  assert.equal(columns.get('price')!.COLUMN_TYPE, 'decimal(10,2)', '价格应为 decimal(10,2)')
  assert.equal(columns.get('original_price')!.COLUMN_TYPE, 'decimal(10,2)', '原价应为 decimal(10,2)')
  assert.equal(columns.get('stock')!.COLUMN_TYPE, 'int')

  const [foreignKeys] = await pool.query<RowDataPacket[]>(
    `SELECT COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
     FROM information_schema.KEY_COLUMN_USAGE
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'product_variants' AND REFERENCED_TABLE_NAME IS NOT NULL`,
    [config.db.database],
  )
  assert.deepEqual(
    foreignKeys.map((row) => [row.COLUMN_NAME, row.REFERENCED_TABLE_NAME, row.REFERENCED_COLUMN_NAME]),
    [['product_id', 'products', 'id']],
  )
})

test('两个选项值列使用 utf8mb4_0900_bin，其余列沿用库默认排序规则', async () => {
  const columns = await columnsOf('product_variants')
  assert.equal(columns.get('option1_value')!.COLLATION_NAME, 'utf8mb4_0900_bin', 'option1_value 应按码值比较')
  assert.equal(columns.get('option2_value')!.COLLATION_NAME, 'utf8mb4_0900_bin', 'option2_value 应按码值比较')

  for (const name of ['sku']) {
    assert.equal(columns.get(name)!.COLLATION_NAME, 'utf8mb4_0900_ai_ci', `product_variants.${name} 沿用库默认排序规则`)
  }

  const [tables] = await pool.query<RowDataPacket[]>(
    'SELECT TABLE_COLLATION FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
    [config.db.database, 'product_variants'],
  )
  assert.equal(tables[0]!.TABLE_COLLATION, 'utf8mb4_0900_ai_ci', '表默认排序规则仍为 utf8mb4_0900_ai_ci（D55）')
})

function isDuplicate (error: unknown): boolean {
  return (error as { code?: string }).code === 'ER_DUP_ENTRY'
}

function isCheckViolation (error: unknown): boolean {
  return (error as { code?: string }).code === 'ER_CHECK_CONSTRAINT_VIOLATED'
}

/** 探针商品：与种子清单无关，避免与种子用例互相影响。 */
async function probeProductId (slug: string): Promise<number> {
  await pool.query("INSERT IGNORE INTO categories (slug, name) VALUES ('variant-probe', '规格组合探针')")
  const [categories] = await pool.query<RowDataPacket[]>("SELECT id FROM categories WHERE slug = 'variant-probe'")
  const categoryId = Number(categories[0]!.id)

  const [existing] = await pool.query<RowDataPacket[]>('SELECT id FROM products WHERE slug = ?', [slug])
  if (existing.length > 0) return Number(existing[0]!.id)

  const [inserted] = await pool.query<ResultSetHeader>(
    `INSERT INTO products (slug, name, category_id, brand, model, rating, sales, detail, dimensions)
     VALUES (?, '规格组合探针商品', ?, '品牌', 'MODEL', 4.5, 0, '[]', '[]')`,
    [slug, categoryId],
  )
  return inserted.insertId
}

function insertVariant (
  productId: number,
  sku: string,
  option1Value: string,
  option2Value: string,
  stock = 10,
): Promise<unknown> {
  return pool.query(
    `INSERT INTO product_variants (product_id, sku, option1_value, option2_value, price, original_price, stock)
     VALUES (?, ?, ?, ?, 899.00, 1099.00, ?)`,
    [productId, sku, option1Value, option2Value, stock],
  )
}

test('唯一 sku 与 (product_id, option1_value, option2_value) 联合唯一生效', async () => {
  const productId = await probeProductId('variant-unique-a')
  const otherProductId = await probeProductId('variant-unique-b')

  await insertVariant(productId, 'PROBE-UNI-1', 'Black', 'STD')

  await assert.rejects(
    insertVariant(otherProductId, 'PROBE-UNI-1', 'White', 'STD'),
    isDuplicate,
    'sku 全局唯一：另一件商品上的同 sku 应被拒绝',
  )

  await assert.rejects(
    insertVariant(productId, 'PROBE-UNI-2', 'Black', 'STD'),
    isDuplicate,
    '同一商品上的重复组合应被拒绝',
  )
})

test('组合唯一性按码值比较：仅大小写或尾随空格不同的组合互不合并', async () => {
  const productId = await probeProductId('variant-binary')

  await insertVariant(productId, 'PROBE-BIN-1', 'Black', 'STD')
  // utf8mb4_0900_bin 下 'black' 与 'Black' 是不同值；若落成 ai_ci 这里会被判重复。
  await insertVariant(productId, 'PROBE-BIN-2', 'black', 'STD')
  // 0900 系列为 NO PAD：尾随空格是有效字符，不参与填充比较（D42）。
  await insertVariant(productId, 'PROBE-BIN-3', 'Black ', 'STD')

  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT sku, option1_value FROM product_variants WHERE product_id = ? ORDER BY sku',
    [productId],
  )
  assert.deepEqual(
    rows.map((row) => [String(row.sku), String(row.option1_value)]),
    [['PROBE-BIN-1', 'Black'], ['PROBE-BIN-2', 'black'], ['PROBE-BIN-3', 'Black ']],
    '大小写与尾随空格不同的组合应各自成行',
  )
})

test('数据库 CHECK 拒绝负库存', async () => {
  const productId = await probeProductId('variant-stock-check')
  await assert.rejects(
    insertVariant(productId, 'PROBE-STOCK-NEG', 'Black', 'STD', -1),
    isCheckViolation,
    '负库存应被 CHECK 拒绝',
  )
  await insertVariant(productId, 'PROBE-STOCK-ZERO', 'Black', 'STD', 0)
})
