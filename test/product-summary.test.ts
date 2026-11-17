import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import type { Pool } from 'mysql2/promise'
import type { ResultSetHeader, RowDataPacket } from 'mysql2'
import { createDb, createPool, type Database } from '../src/db/client.ts'
import { runMigrations } from '../src/db/migrate.ts'
import { seedDatabase } from '../src/db/seed.ts'
import { SEED_MANIFEST } from '../src/db/seed-data.ts'
import { selectProductSummaries } from '../src/db/product-summary.ts'
import { loadTestConfig } from './helpers/test-config.ts'

const config = loadTestConfig()
let pool: Pool
let db: Database

before(async () => {
  pool = createPool(config)
  db = createDb(pool)
  await runMigrations(db)
  await seedDatabase(db)
})

after(async () => {
  await pool.query("DELETE FROM products WHERE slug LIKE 'summary-probe-%'")
  await pool.query("DELETE FROM categories WHERE slug = 'summary-probe'")
  await pool.end()
})

interface ProbeVariant {
  sku: string
  option1Value: string
  price: number
  stock: number
}

/** 探针商品：与种子清单互不干扰，用于构造派生规则的边界数据；原价固定为价格 + 100。 */
async function insertProbeProduct (slug: string, variants: ProbeVariant[]): Promise<number> {
  await pool.query("INSERT IGNORE INTO categories (slug, name) VALUES ('summary-probe', '展示价探针')")
  const [categories] = await pool.query<RowDataPacket[]>("SELECT id FROM categories WHERE slug = 'summary-probe'")
  const categoryId = Number(categories[0]!.id)
  const [inserted] = await pool.query<ResultSetHeader>(
    `INSERT INTO products (slug, name, category_id, brand, model, rating, sales, detail, dimensions)
     VALUES (?, ?, ?, '探针品牌', 'PROBE-1', 4.5, 0, '[]', '[]')`,
    [slug, `探针商品 ${slug}`, categoryId],
  )
  for (const variant of variants) {
    await pool.query(
      `INSERT INTO product_variants (product_id, sku, option1_value, option2_value, price, original_price, stock)
       VALUES (?, ?, ?, 'STD', ?, ?, ?)`,
      [inserted.insertId, variant.sku, variant.option1Value, variant.price, variant.price + 100, variant.stock],
    )
  }
  return inserted.insertId
}

test('有库存时展示价取最低可售组合价，忽略缺货的更低价格', async () => {
  const productId = await insertProbeProduct('summary-probe-cheapest-out', [
    { sku: 'SUMMARY-CHEAP-0', option1Value: 'A', price: 100, stock: 0 },
    { sku: 'SUMMARY-CHEAP-1', option1Value: 'B', price: 200, stock: 5 },
    { sku: 'SUMMARY-CHEAP-2', option1Value: 'C', price: 300, stock: 9 },
  ])

  const [summary] = await selectProductSummaries(db, { productIds: [productId] })
  assert.ok(summary !== undefined, '应返回该商品的派生摘要')
  assert.equal(typeof summary.displayPrice, 'number', '展示价应按 number 返回（D43）')
  assert.equal(summary.displayPrice, 200, '展示价应取有库存组合的最低价，而不是缺货的 100')
  assert.equal(summary.displayOriginalPrice, 300, '展示原价应取被选中组合（B）的原价')
  assert.equal(typeof summary.soldOut, 'boolean', '售罄状态应按 boolean 返回')
  assert.equal(summary.soldOut, false)
})

test('全部缺货时展示价取全部有效组合最低价，并标记售罄', async () => {
  const productId = await insertProbeProduct('summary-probe-sold-out', [
    { sku: 'SUMMARY-SOLD-0', option1Value: 'A', price: 100, stock: 0 },
    { sku: 'SUMMARY-SOLD-1', option1Value: 'B', price: 250, stock: 0 },
  ])

  const [summary] = await selectProductSummaries(db, { productIds: [productId] })
  assert.ok(summary !== undefined)
  assert.equal(typeof summary.displayPrice, 'number', '展示价应按 number 返回（D43）')
  assert.equal(summary.displayPrice, 100, '全部缺货时应回退到全部有效组合的最低价')
  assert.equal(summary.displayOriginalPrice, 200, '展示原价应取被选中组合（A）的原价')
  assert.equal(typeof summary.soldOut, 'boolean', '售罄状态应按 boolean 返回')
  assert.equal(summary.soldOut, true, '有效组合库存之和为 0 应标记售罄')
})

/**
 * 种子数据的字面期望值（不按实现公式重算）：
 * 展示价取「有库存优先、其次价格升序」选中的那条组合，展示原价与它同源。
 */
const EXPECTED_SUMMARIES: Record<string, { displayPrice: number, displayOriginalPrice: number, soldOut: boolean }> = {
  'airpods-max': { displayPrice: 3999, displayOriginalPrice: 4399, soldOut: false },
  'apple-earpods': { displayPrice: 129, displayOriginalPrice: 149, soldOut: false },
  'sony-wh-1000xm3': { displayPrice: 2299, displayOriginalPrice: 2899, soldOut: false },
  'sony-wh-ch500': { displayPrice: 499, displayOriginalPrice: 599, soldOut: false },
  'keychron-k8': { displayPrice: 599, displayOriginalPrice: 699, soldOut: false },
  'logitech-g15': { displayPrice: 199, displayOriginalPrice: 299, soldOut: false },
  'logitech-g613': { displayPrice: 649, displayOriginalPrice: 749, soldOut: false },
  'dell-e2210f': { displayPrice: 299, displayOriginalPrice: 399, soldOut: true },
  'apple-watch-series-8': { displayPrice: 2999, displayOriginalPrice: 3199, soldOut: false },
  'huawei-watch': { displayPrice: 1299, displayOriginalPrice: 1499, soldOut: false },
  'dell-p2212h': { displayPrice: 699, displayOriginalPrice: 899, soldOut: false },
  'asus-pa246q': { displayPrice: 999, displayOriginalPrice: 1299, soldOut: false },
  'dell-s3423dwc': { displayPrice: 2799, displayOriginalPrice: 3299, soldOut: false },
  'samsung-gear-s3': { displayPrice: 1499, displayOriginalPrice: 1799, soldOut: false },
  'apple-watch-ultra': { displayPrice: 6199, displayOriginalPrice: 6699, soldOut: false },
  'cherry-g80-3850': { displayPrice: 499, displayOriginalPrice: 599, soldOut: false },
}

test('种子数据逐件核对展示价、展示原价与售罄：至少一件售罄商品被正确识别', async () => {
  const manifestSlugs = SEED_MANIFEST.products.map((product) => product.slug)
  const summaries = await selectProductSummaries(db, { slugs: manifestSlugs })
  assert.equal(summaries.length, SEED_MANIFEST.products.length, '每件种子商品都应有一行派生摘要')

  const bySlug = new Map(summaries.map((summary) => [summary.slug, summary]))
  for (const [slug, expected] of Object.entries(EXPECTED_SUMMARIES)) {
    const summary = bySlug.get(slug)
    assert.ok(summary !== undefined, `${slug} 应有派生摘要`)
    assert.deepEqual(
      {
        displayPrice: summary.displayPrice,
        displayOriginalPrice: summary.displayOriginalPrice,
        soldOut: summary.soldOut,
      },
      expected,
      `${slug} 的派生摘要`,
    )
  }

  const soldOutCount = summaries.filter((summary) => summary.soldOut).length
  assert.equal(soldOutCount, 1, '种子数据只有 dell-e2210f 售罄')
})

test('派生查询不落列：规格库存与价格变更后结果立即反映', async () => {
  const productId = await insertProbeProduct('summary-probe-live', [
    { sku: 'SUMMARY-LIVE-0', option1Value: 'A', price: 100, stock: 0 },
    { sku: 'SUMMARY-LIVE-1', option1Value: 'B', price: 200, stock: 5 },
  ])

  const read = async () => {
    const [summary] = await selectProductSummaries(db, { productIds: [productId] })
    assert.ok(summary !== undefined)
    return summary
  }

  const initial = await read()
  assert.equal(initial.displayPrice, 200)
  assert.equal(initial.displayOriginalPrice, 300)

  await pool.query("UPDATE product_variants SET price = 150 WHERE sku = 'SUMMARY-LIVE-1'")
  const repriced = await read()
  assert.equal(repriced.displayPrice, 150, '价格变更后展示价应立即反映')
  assert.equal(repriced.displayOriginalPrice, 300, '原价未变时展示原价保持 300')

  await pool.query("UPDATE product_variants SET stock = 3 WHERE sku = 'SUMMARY-LIVE-0'")
  const restocked = await read()
  assert.equal(restocked.displayPrice, 100, '库存变更后展示价应立即反映')
  assert.equal(restocked.displayOriginalPrice, 200, '展示原价应跟随被选中组合切换')

  await pool.query('UPDATE product_variants SET stock = 0 WHERE product_id = ?', [productId])
  const soldOut = await read()
  assert.equal(soldOut.displayPrice, 100, '全部缺货时展示价应回退到全部有效组合最低价')
  assert.equal(soldOut.displayOriginalPrice, 200, '全部缺货时展示原价取最低价组合的原价')
  assert.equal(soldOut.soldOut, true, '库存清零后应立即标记售罄')

  const [columns] = await pool.query<RowDataPacket[]>(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN ('products', 'product_variants')
       AND COLUMN_NAME IN ('display_price', 'display_original_price', 'sold_out')`,
    [config.db.database],
  )
  assert.deepEqual(columns, [], '展示价、展示原价与售罄状态不应落列')
})
