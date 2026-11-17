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
}

async function columnsOf (table: string): Promise<Map<string, ColumnRow>> {
  const [rows] = await pool.query<ColumnRow[]>(
    `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
    [config.db.database, table],
  )
  return new Map(rows.map((row) => [row.COLUMN_NAME, row]))
}

async function uniqueIndexColumns (table: string): Promise<string[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT INDEX_NAME, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS cols
     FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND NON_UNIQUE = 0
     GROUP BY INDEX_NAME`,
    [config.db.database, table],
  )
  return rows.map((row) => String(row.cols))
}

function isCheckViolation (error: unknown): boolean {
  return (error as { code?: string }).code === 'ER_CHECK_CONSTRAINT_VIOLATED'
}

test('迁移后建立商品表：字段、唯一 slug 与商品类型外键齐全', async () => {
  const columns = await columnsOf('products')
  assert.deepEqual([...columns.keys()], [
    'id', 'slug', 'name', 'category_id', 'brand', 'model',
    'rating', 'sales', 'detail', 'dimensions', 'created_at', 'updated_at',
  ])
  assert.equal(columns.get('rating')!.COLUMN_TYPE, 'decimal(2,1)')
  assert.equal(columns.get('sales')!.COLUMN_TYPE, 'int')
  assert.equal(columns.get('detail')!.COLUMN_TYPE, 'json')
  assert.equal(columns.get('dimensions')!.COLUMN_TYPE, 'json')
  assert.equal(columns.get('created_at')!.COLUMN_TYPE, 'timestamp')
  assert.equal(columns.get('updated_at')!.COLUMN_TYPE, 'timestamp')

  for (const name of ['slug', 'name', 'category_id', 'brand', 'model', 'rating', 'sales', 'detail', 'dimensions']) {
    assert.equal(columns.get(name)!.IS_NULLABLE, 'NO', `products.${name} 应为 NOT NULL`)
  }

  assert.ok((await uniqueIndexColumns('products')).includes('slug'), 'products.slug 应有唯一索引')

  const [foreignKeys] = await pool.query<RowDataPacket[]>(
    `SELECT COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
     FROM information_schema.KEY_COLUMN_USAGE
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'products' AND REFERENCED_TABLE_NAME IS NOT NULL`,
    [config.db.database],
  )
  assert.deepEqual(
    foreignKeys.map((row) => [row.COLUMN_NAME, row.REFERENCED_TABLE_NAME, row.REFERENCED_COLUMN_NAME]),
    [['category_id', 'categories', 'id']],
  )
})

test('迁移后建立商品图片表：字段、商品外键与 (product_id, path) 唯一', async () => {
  const columns = await columnsOf('product_images')
  assert.deepEqual([...columns.keys()], ['id', 'product_id', 'path', 'sort_order', 'alt'])
  for (const name of ['product_id', 'path', 'sort_order', 'alt']) {
    assert.equal(columns.get(name)!.IS_NULLABLE, 'NO', `product_images.${name} 应为 NOT NULL`)
  }
  assert.equal(columns.get('sort_order')!.COLUMN_TYPE, 'int')
  assert.equal(columns.get('path')!.COLUMN_TYPE, 'varchar(255)')

  assert.ok(
    (await uniqueIndexColumns('product_images')).includes('product_id,path'),
    'product_images 应有 (product_id, path) 唯一索引',
  )

  const [foreignKeys] = await pool.query<RowDataPacket[]>(
    `SELECT COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
     FROM information_schema.KEY_COLUMN_USAGE
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'product_images' AND REFERENCED_TABLE_NAME IS NOT NULL`,
    [config.db.database],
  )
  assert.deepEqual(
    foreignKeys.map((row) => [row.COLUMN_NAME, row.REFERENCED_TABLE_NAME, row.REFERENCED_COLUMN_NAME]),
    [['product_id', 'products', 'id']],
  )
})

test('数据库 CHECK 拒绝越界评分、负销量与负排序', async () => {
  const [category] = await pool.query<ResultSetHeader>(
    "INSERT INTO categories (slug, name) VALUES ('schema-check', '约束检查')",
  )
  const categoryId = category.insertId

  const insertProduct = (rating: number, sales: number) => pool.query<ResultSetHeader>(
    `INSERT INTO products (slug, name, category_id, brand, model, rating, sales, detail, dimensions)
     VALUES (?, '约束检查商品', ?, '品牌', '型号', ?, ?, '[]', '[]')`,
    [`schema-check-${rating}-${sales}`, categoryId, rating, sales],
  )

  await assert.rejects(insertProduct(5.1, 0), isCheckViolation, '评分 5.1 应被 CHECK 拒绝')
  await assert.rejects(insertProduct(4.5, -1), isCheckViolation, '负销量应被 CHECK 拒绝')

  const [product] = await insertProduct(4.5, 0)
  await assert.rejects(
    pool.query(
      `INSERT INTO product_images (product_id, path, sort_order, alt)
       VALUES (?, '/images/products/schema-check/1.webp', -1, '图片')`,
      [product.insertId],
    ),
    isCheckViolation,
    '负排序应被 CHECK 拒绝',
  )
})
