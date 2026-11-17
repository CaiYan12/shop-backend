import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import type { Pool } from 'mysql2/promise'
import type { RowDataPacket } from 'mysql2'
import { createDb, createPool, type Database } from '../src/db/client.ts'
import { runMigrations } from '../src/db/migrate.ts'
import { productVariants } from '../src/db/schema.ts'
import { seedDatabase } from '../src/db/seed.ts'
import { SEED_MANIFEST } from '../src/db/seed-data.ts'
import {
  SeedValidationError,
  validateManifest,
  type SeedManifest,
  type SeedProduct,
  type SeedVariant,
} from '../src/db/seed-manifest.ts'
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

const baseProduct = SEED_MANIFEST.products[0]!

function manifestWith (product: SeedProduct): SeedManifest {
  return { categories: SEED_MANIFEST.categories, products: [product] }
}

function productWithVariants (variants: SeedVariant[], product: SeedProduct = baseProduct): SeedProduct {
  return { ...product, variants }
}

const isSeedError = (error: unknown): boolean => error instanceof SeedValidationError

test('每件商品至少声明一个有效规格组合', () => {
  assert.doesNotThrow(() => validateManifest(SEED_MANIFEST), '种子清单应通过校验')

  assert.throws(
    () => validateManifest(manifestWith(productWithVariants([]))),
    isSeedError,
    '空组合列表应被拒绝',
  )

  const withoutVariants = { ...baseProduct } as Record<string, unknown>
  delete withoutVariants.variants
  assert.throws(
    () => validateManifest(manifestWith(withoutVariants as unknown as SeedProduct)),
    isSeedError,
    '缺少 variants 字段应被拒绝',
  )
})

test('组合的选项值必须精确引用商品声明的选项：大小写与首尾空白都不放过', () => {
  assert.doesNotThrow(() => validateManifest(manifestWith(baseProduct)))

  const [first, , third] = baseProduct.variants
  assert.ok(first !== undefined && third !== undefined)

  assert.throws(
    () => validateManifest(manifestWith(productWithVariants([
      { ...first, option1Value: '曜石灰' },
    ]))),
    isSeedError,
    '未声明的选项应被拒绝',
  )

  assert.throws(
    () => validateManifest(manifestWith(productWithVariants([
      { ...first, option1Value: `${first.option1Value} ` },
    ]))),
    isSeedError,
    '首尾空白应被拒绝',
  )

  // 仅大小写不同：商品声明 Black，组合写 black，必须被应用层拒绝（严格字符串比较）。
  const asciiProduct: SeedProduct = {
    ...baseProduct,
    dimensions: [
      { name: '颜色', options: ['Black', 'White'] },
      { name: '版本', options: ['STD', 'PRO'] },
    ],
    variants: [{ ...first, option1Value: 'black', option2Value: 'STD' }],
  }
  assert.throws(
    () => validateManifest(manifestWith(asciiProduct)),
    isSeedError,
    '仅大小写不同的选项值应被拒绝',
  )

  assert.doesNotThrow(
    () => validateManifest(manifestWith({
      ...asciiProduct,
      variants: [{ ...first, option1Value: 'Black', option2Value: 'STD' }],
    })),
    '精确引用声明选项的组合应通过',
  )
})

test('同一商品内重复组合与跨商品重复 sku 都被拒绝', () => {
  const [first, second] = baseProduct.variants
  assert.ok(first !== undefined && second !== undefined)

  assert.throws(
    () => validateManifest(manifestWith(productWithVariants([
      first,
      { ...second, option1Value: first.option1Value, option2Value: first.option2Value },
    ]))),
    isSeedError,
    '同一商品内重复组合应被拒绝',
  )

  const otherProduct = SEED_MANIFEST.products[1]!
  assert.throws(
    () => validateManifest({
      categories: SEED_MANIFEST.categories,
      products: [baseProduct, { ...otherProduct, variants: [{ ...otherProduct.variants[0]!, sku: first.sku }] }],
    }),
    isSeedError,
    '跨商品重复 sku 应被拒绝',
  )
})

test('负库存与非两位小数价格被拒绝，避免 decimal(10,2) 静默取整', () => {
  const [first] = baseProduct.variants
  assert.ok(first !== undefined)

  assert.throws(
    () => validateManifest(manifestWith(productWithVariants([{ ...first, stock: -1 }]))),
    isSeedError,
    '负库存应被应用层拒绝',
  )

  assert.throws(
    () => validateManifest(manifestWith(productWithVariants([{ ...first, stock: 1.5 }]))),
    isSeedError,
    '非整数库存应被拒绝',
  )

  assert.throws(
    () => validateManifest(manifestWith(productWithVariants([{ ...first, price: -0.01 }]))),
    isSeedError,
    '负价格应被拒绝',
  )

  assert.throws(
    () => validateManifest(manifestWith(productWithVariants([{ ...first, originalPrice: 1099.999 }]))),
    isSeedError,
    '超过两位小数的原价应被拒绝',
  )

  assert.throws(
    () => validateManifest(manifestWith(productWithVariants([{ ...first, price: 100000000 }]))),
    isSeedError,
    '超出 decimal(10,2) 范围的价格应被拒绝',
  )
})

const manifestSlugs = SEED_MANIFEST.products.map((product) => product.slug)
const expectedVariants = SEED_MANIFEST.products.reduce((total, product) => total + product.variants.length, 0)

async function variantSnapshot (): Promise<Record<string, unknown>[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT p.slug, v.sku, v.option1_value, v.option2_value, v.price, v.original_price, v.stock
     FROM product_variants v JOIN products p ON p.id = v.product_id
     WHERE p.slug IN (?) ORDER BY p.slug, v.sku`,
    [manifestSlugs],
  )
  return rows.map((row) => ({ ...row }))
}

/** 换 slug 并同步图片 / 详情图路径，用于构造与种子清单互不干扰的探针商品。 */
function renameProduct (product: SeedProduct, slug: string): SeedProduct {
  const from = `/images/products/${product.slug}/`
  const to = `/images/products/${slug}/`
  return {
    ...product,
    slug,
    images: product.images.map((image) => ({ ...image, path: image.path.replace(from, to) })),
    detail: product.detail.map((block) =>
      block.type === 'image' ? { ...block, path: block.path.replace(from, to) } : block,
    ),
  }
}

test('种子导入规格组合：逐件定义的有效组合入库，价格按 number 读回', async () => {
  const result = await seedDatabase(db)
  assert.equal(result.variants, expectedVariants, '导入结果应报告组合数')

  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT p.slug, v.sku, v.option1_value, v.option2_value, v.price, v.original_price, v.stock
     FROM product_variants v JOIN products p ON p.id = v.product_id
     WHERE p.slug IN (?) ORDER BY p.slug, v.sku`,
    [manifestSlugs],
  )
  assert.equal(rows.length, expectedVariants, '组合行数应等于清单组合总数')

  const bySku = new Map(rows.map((row) => [String(row.sku), row]))
  for (const product of SEED_MANIFEST.products) {
    for (const variant of product.variants) {
      const row = bySku.get(variant.sku)
      assert.ok(row !== undefined, `${variant.sku} 应已导入`)
      assert.equal(row.slug, product.slug)
      assert.equal(row.option1_value, variant.option1Value)
      assert.equal(row.option2_value, variant.option2Value)
      assert.equal(String(row.price), variant.price.toFixed(2))
      assert.equal(String(row.original_price), variant.originalPrice.toFixed(2))
      assert.equal(Number(row.stock), variant.stock)
    }
  }

  // D43：decimal(10,2) 取 number 模式，经 drizzle 读回应是 number 而不是字符串。
  const typed = await db
    .select({ sku: productVariants.sku, price: productVariants.price, originalPrice: productVariants.originalPrice })
    .from(productVariants)
  assert.ok(typed.length >= expectedVariants)
  for (const row of typed) {
    assert.equal(typeof row.price, 'number', `${row.sku} 的 price 应按 number 读回`)
    assert.equal(typeof row.originalPrice, 'number', `${row.sku} 的 originalPrice 应按 number 读回`)
  }
})

test('种子连续执行两次：规格组合无重复行且数据集一致', async () => {
  await seedDatabase(db)
  const first = await variantSnapshot()
  await seedDatabase(db)
  const second = await variantSnapshot()

  assert.deepEqual(second, first, '第二次执行后的组合数据集应与第一次完全一致')

  const [duplicates] = await pool.query<RowDataPacket[]>(
    `SELECT product_id, option1_value, option2_value, COUNT(*) AS count FROM product_variants
     GROUP BY product_id, option1_value, option2_value HAVING COUNT(*) > 1`,
  )
  assert.deepEqual(duplicates, [], 'product_variants 不应出现重复组合')
})

test('种子删除本次清单中已移除的规格组合', async () => {
  const product = SEED_MANIFEST.products[0]!
  const kept = product.variants.slice(0, 3)
  const removed = product.variants[3]!
  assert.ok(removed !== undefined)

  await seedDatabase(db, {
    categories: SEED_MANIFEST.categories,
    products: [{ ...product, variants: kept }],
  })

  const skusOf = async (): Promise<string[]> => {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT v.sku FROM product_variants v JOIN products p ON p.id = v.product_id
       WHERE p.slug = ? ORDER BY v.sku`,
      [product.slug],
    )
    return rows.map((row) => String(row.sku))
  }

  assert.deepEqual(await skusOf(), kept.map((variant) => variant.sku).sort(), '只剩本次清单中的组合')
  assert.ok(!(await skusOf()).includes(removed.sku), `已移除的 ${removed.sku} 应被删除`)

  await seedDatabase(db)
  assert.deepEqual(await skusOf(), product.variants.map((variant) => variant.sku).sort(), '恢复完整清单后组合应回归')
})

test('缺货（组合存在、库存 0）与不可选（组合不存在）可区分', async () => {
  const demo = renameProduct(SEED_MANIFEST.products[0]!, 'variant-stock-demo')
  const demoWithGap: SeedProduct = {
    ...demo,
    dimensions: [
      { name: '颜色', options: ['Black', 'White'] },
      { name: '版本', options: ['STD', 'PRO'] },
    ],
    variants: [
      { sku: 'DEMO-BLK-STD', option1Value: 'Black', option2Value: 'STD', price: 899, originalPrice: 1099, stock: 0 },
      { sku: 'DEMO-BLK-PRO', option1Value: 'Black', option2Value: 'PRO', price: 1099, originalPrice: 1299, stock: 12 },
      { sku: 'DEMO-WHT-STD', option1Value: 'White', option2Value: 'STD', price: 899, originalPrice: 1099, stock: 7 },
      // White / PRO 两个选项都存在，但该组合未定义 → 不可选。
    ],
  }
  await seedDatabase(db, { categories: SEED_MANIFEST.categories, products: [demoWithGap] })

  const [productRows] = await pool.query<RowDataPacket[]>('SELECT id FROM products WHERE slug = ?', [demoWithGap.slug])
  const productId = Number(productRows[0]!.id)

  const lookup = async (option1Value: string, option2Value: string): Promise<RowDataPacket[]> => {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT stock FROM product_variants
       WHERE product_id = ? AND option1_value = ? AND option2_value = ?`,
      [productId, option1Value, option2Value],
    )
    return rows
  }

  const soldOut = await lookup('Black', 'STD')
  assert.equal(soldOut.length, 1, '缺货组合在库中存在')
  assert.equal(Number(soldOut[0]!.stock), 0, '缺货组合库存为 0')

  const available = await lookup('Black', 'PRO')
  assert.equal(available.length, 1, '有货组合在库中存在')
  assert.ok(Number(available[0]!.stock) > 0, '有货组合库存大于 0')

  const unavailable = await lookup('White', 'PRO')
  assert.equal(unavailable.length, 0, '不可选组合在库中没有行')
})
