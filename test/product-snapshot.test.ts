import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import type { ResultSetHeader, RowDataPacket } from 'mysql2'
import type { Pool } from 'mysql2/promise'
import type { AppInstance } from '../src/app.ts'
import type { Database } from '../src/db/client.ts'
import { selectProductSummaries } from '../src/db/product-summary.ts'
import { yuanToCents } from '../src/money.ts'
import { loadProductSnapshot } from '../src/search/product-snapshot.ts'
import { closeSeededApp, createSeededApp } from './helpers/seeded-app.ts'

let pool: Pool
let db: Database
let app: AppInstance

before(async () => {
  ({ pool, db, app } = await createSeededApp())
})

after(async () => {
  await closeSeededApp({ pool, app })
})

test('快照覆盖 MySQL 全量 16 件商品，展示价与既有派生规则一致', async () => {
  const documents = await loadProductSnapshot(db)
  assert.equal(documents.length, 16)
  assert.equal(new Set(documents.map((document) => document.slug)).size, 16)
  assert.deepEqual(
    documents.map((document) => document.productId),
    [...documents.map((document) => document.productId)].sort((left, right) => left - right),
  )

  const summaries = await selectProductSummaries(db)
  const summaryByProductId = new Map(summaries.map((summary) => [summary.productId, summary]))
  for (const document of documents) {
    const summary = summaryByProductId.get(document.productId)
    assert.ok(summary !== undefined, `缺少商品 ${document.slug} 的摘要`)
    assert.equal(document.displayPriceCents, yuanToCents(summary.displayPrice))
    assert.equal(Number.isInteger(document.displayPriceCents), true)
    assert.equal(Number.isInteger(document.sales), true)
    assert.ok(document.categorySlug.length > 0)
    assert.ok(document.categoryName.length > 0)
  }
})

test('展示价超过 32 位上限时仍以整数分进入快照', async () => {
  await pool.query(
    "INSERT IGNORE INTO categories (slug, name) VALUES ('snapshot-probe', '快照探针')",
  )
  const [categoryRows] = await pool.query<RowDataPacket[]>(
    'SELECT id FROM categories WHERE slug = ?',
    ['snapshot-probe'],
  )
  const categoryId = Number(categoryRows[0]!.id)
  const [product] = await pool.query<ResultSetHeader>(
    `INSERT INTO products (slug, name, category_id, brand, model, rating, sales, detail, dimensions)
     VALUES ('snapshot-huge-price', '快照超上限金额探针', ?, 'Probe', 'PROBE', 4.0, 1, '[]', '[]')`,
    [categoryId],
  )

  try {
    await pool.query(
      `INSERT INTO product_variants
         (product_id, sku, option1_value, option2_value, price, original_price, stock)
       VALUES (?, 'SNAPSHOT-HUGE-SKU', 'A', 'B', 99999999.99, 99999999.99, 1)`,
      [product.insertId],
    )

    const documents = await loadProductSnapshot(db)
    const probe = documents.find((document) => document.slug === 'snapshot-huge-price')
    assert.ok(probe !== undefined)
    assert.equal(probe.displayPriceCents, 9_999_999_999)
    assert.ok(probe.displayPriceCents > 2_147_483_647)
  } finally {
    await pool.query('DELETE FROM products WHERE slug = ?', ['snapshot-huge-price'])
    await pool.query('DELETE FROM categories WHERE slug = ?', ['snapshot-probe'])
  }
})
