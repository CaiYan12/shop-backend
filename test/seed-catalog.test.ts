import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import type { Pool } from 'mysql2/promise'
import type { RowDataPacket } from 'mysql2'
import { createDb, createPool, type Database } from '../src/db/client.ts'
import { runMigrations } from '../src/db/migrate.ts'
import { seedDatabase } from '../src/db/seed.ts'
import { SEED_MANIFEST } from '../src/db/seed-data.ts'
import { selectProductSummaries } from '../src/db/product-summary.ts'
import type { DimensionMetadata } from '../src/db/schema.ts'
import { loadTestConfig } from './helpers/test-config.ts'

/**
 * T7 验收：种子清单的规格、价格与库存安排。
 * 断言落在数据库与派生查询上，不检查清单对象的内部结构。
 */
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
  await pool.end()
})

const manifestSlugs = SEED_MANIFEST.products.map((product) => product.slug)
const asJson = (value: unknown): unknown => (typeof value === 'string' ? JSON.parse(value) : value)

interface VariantRow extends RowDataPacket {
  slug: string
  sku: string
  option1_value: string
  option2_value: string
  price: string
  original_price: string
  stock: number
}

async function variantRows (): Promise<VariantRow[]> {
  const [rows] = await pool.query<VariantRow[]>(
    `SELECT p.slug, v.sku, v.option1_value, v.option2_value, v.price, v.original_price, v.stock
     FROM product_variants v JOIN products p ON p.id = v.product_id
     WHERE p.slug IN (?) ORDER BY p.slug, v.sku`,
    [manifestSlugs],
  )
  return rows
}

function groupBySlug (rows: VariantRow[]): Map<string, VariantRow[]> {
  const grouped = new Map<string, VariantRow[]>()
  for (const row of rows) {
    const list = grouped.get(row.slug) ?? []
    list.push(row)
    grouped.set(row.slug, list)
  }
  return grouped
}

test('每件商品两个规格维度、每维至少两个选项，组合逐件定义并精确引用声明选项', async () => {
  const grouped = groupBySlug(await variantRows())

  for (const product of SEED_MANIFEST.products) {
    const variants = grouped.get(product.slug)
    assert.ok(variants !== undefined && variants.length > 0, `${product.slug} 应有有效组合`)

    const [stored] = await pool.query<RowDataPacket[]>(
      'SELECT dimensions FROM products WHERE slug = ?',
      [product.slug],
    )
    const dimensions = asJson(stored[0]!.dimensions) as DimensionMetadata[]
    assert.equal(dimensions.length, 2, `${product.slug} 应恰好声明两个规格维度`)
    for (const dimension of dimensions) {
      assert.ok(dimension.options.length >= 2, `${product.slug} 的维度 ${dimension.name} 至少两个选项`)
    }

    const declared = dimensions.map((dimension) => new Set(dimension.options))
    const seen = new Set<string>()
    for (const variant of variants) {
      assert.ok(
        declared[0]!.has(variant.option1_value),
        `${variant.sku} 的 ${variant.option1_value} 应在维度 ${dimensions[0]!.name} 内`,
      )
      assert.ok(
        declared[1]!.has(variant.option2_value),
        `${variant.sku} 的 ${variant.option2_value} 应在维度 ${dimensions[1]!.name} 内`,
      )
      const combination = JSON.stringify([variant.option1_value, variant.option2_value])
      assert.ok(!seen.has(combination), `${product.slug} 不应出现重复组合 ${combination}`)
      seen.add(combination)

      assert.ok(Number(variant.price) > 0, `${variant.sku} 应有正的组合价`)
      assert.ok(
        Number(variant.original_price) >= Number(variant.price),
        `${variant.sku} 的原价不应低于组合价`,
      )
      assert.ok(Number(variant.stock) >= 0, `${variant.sku} 的库存应为非负整数`)
    }
  }
})

test('售罄演示集中在 dell-e2210f：全部组合库存为 0，展示价回退到最低有效组合价', async () => {
  const dellVariants = (await variantRows()).filter((row) => row.slug === 'dell-e2210f')
  assert.equal(dellVariants.length, 4, 'dell-e2210f 应有四个有效组合')
  assert.ok(
    dellVariants.every((row) => Number(row.stock) === 0),
    'dell-e2210f 的全部有效组合库存应为 0',
  )

  const [dell] = await selectProductSummaries(db, { slugs: ['dell-e2210f'] })
  assert.ok(dell !== undefined)
  assert.equal(dell.soldOut, true, 'dell-e2210f 应标记售罄')
  assert.equal(dell.displayPrice, 299, '售罄时展示价取全部有效组合的最低价')

  const others = await selectProductSummaries(db, {
    slugs: manifestSlugs.filter((slug) => slug !== 'dell-e2210f'),
  })
  assert.equal(others.length, manifestSlugs.length - 1)
  assert.deepEqual(
    others.filter((summary) => summary.soldOut).map((summary) => summary.slug),
    [],
    '除 dell-e2210f 外不应有售罄商品',
  )
})

test('种子同时覆盖缺货与不可选：缺货组合存在且库存 0，不可选组合没有行', async () => {
  const grouped = groupBySlug(await variantRows())

  const partiallyOut = SEED_MANIFEST.products.filter((product) => {
    const variants = grouped.get(product.slug) ?? []
    return variants.some((row) => Number(row.stock) === 0) && variants.some((row) => Number(row.stock) > 0)
  })
  assert.ok(partiallyOut.length >= 1, '应至少有一件商品含缺货组合（组合存在、库存 0）')

  const withGap = SEED_MANIFEST.products.filter((product) => {
    const present = new Set(
      (grouped.get(product.slug) ?? []).map((row) => JSON.stringify([row.option1_value, row.option2_value])),
    )
    return product.dimensions[0]!.options.some((option1) =>
      product.dimensions[1]!.options.some(
        (option2) => !present.has(JSON.stringify([option1, option2])),
      ),
    )
  })
  assert.ok(withGap.length >= 1, '应至少有一件商品含不可选组合（选项都存在，但没有对应行）')
})

test('展示价覆盖六个价格区间：最低低于 200 元，最高高于 3000 元', async () => {
  const summaries = await selectProductSummaries(db, { slugs: manifestSlugs })
  assert.equal(summaries.length, manifestSlugs.length, '每件种子商品都应有派生摘要')

  const prices = summaries.map((summary) => summary.displayPrice).sort((a, b) => a - b)
  assert.ok(prices[0]! < 200, `最低展示价应低于 200 元，实际 ${prices[0]}`)
  assert.ok(
    prices[prices.length - 1]! > 3000,
    `最高展示价应高于 3000 元，实际 ${prices[prices.length - 1]}`,
  )

  const bands = [
    { name: '200 元以下', match: (price: number) => price < 200 },
    { name: '200–499 元', match: (price: number) => price >= 200 && price < 500 },
    { name: '500–999 元', match: (price: number) => price >= 500 && price < 1000 },
    { name: '1000–1999 元', match: (price: number) => price >= 1000 && price < 2000 },
    { name: '2000–2999 元', match: (price: number) => price >= 2000 && price < 3000 },
    { name: '3000 元以上', match: (price: number) => price >= 3000 },
  ]
  const missing = bands.filter((band) => !prices.some((price) => band.match(price)))
  assert.deepEqual(missing.map((band) => band.name), [], '六个价格区间都应被覆盖')
})
