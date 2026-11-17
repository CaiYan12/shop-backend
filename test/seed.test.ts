import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import type { Pool } from 'mysql2/promise'
import type { RowDataPacket } from 'mysql2'
import { createDb, createPool, type Database } from '../src/db/client.ts'
import { runMigrations } from '../src/db/migrate.ts'
import { seedDatabase } from '../src/db/seed.ts'
import { SEED_MANIFEST } from '../src/db/seed-data.ts'
import { SeedValidationError, validateManifest, type SeedManifest, type SeedProduct } from '../src/db/seed-manifest.ts'
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

const asJson = (value: unknown): unknown => (typeof value === 'string' ? JSON.parse(value) : value)

const manifestSlugs = SEED_MANIFEST.products.map((product) => product.slug)

function normalizeRow (row: RowDataPacket): Record<string, unknown> {
  const normalized: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(row)) {
    normalized[key] = value instanceof Date ? value.toISOString() : value
  }
  return normalized
}

async function datasetSnapshot (): Promise<{ products: Record<string, unknown>[], images: Record<string, unknown>[] }> {
  const [productRows] = await pool.query<RowDataPacket[]>(
    `SELECT id, slug, name, category_id, brand, model, rating, sales, detail, dimensions, created_at, updated_at
     FROM products WHERE slug IN (?) ORDER BY slug`,
    [manifestSlugs],
  )
  // 图片按商品整体替换（D52），代理主键 id 会重新分配，因此比较内容列。
  const [imageRows] = await pool.query<RowDataPacket[]>(
    `SELECT i.product_id, i.path, i.sort_order, i.alt
     FROM product_images i JOIN products p ON p.id = i.product_id
     WHERE p.slug IN (?) ORDER BY p.slug, i.sort_order`,
    [manifestSlugs],
  )
  return {
    products: productRows.map(normalizeRow),
    images: imageRows.map(normalizeRow),
  }
}

/** 素材清单（shop-frontend docs/assets/product-images.json）的 10 个 slug，按字母序。 */
const CATALOG_SLUGS = [
  'airpods-max',
  'apple-earpods',
  'apple-watch-series-8',
  'dell-e2210f',
  'huawei-watch',
  'keychron-k8',
  'logitech-g15',
  'logitech-g613',
  'sony-wh-1000xm3',
  'sony-wh-ch500',
]

test('种子导入 10 件真实商品：四类齐全、每件至少 4 张图片且路径符合约定', async () => {
  const result = await seedDatabase(db)
  assert.equal(SEED_MANIFEST.products.length, 10, '最终规模为 10 件（C26）')
  assert.deepEqual(
    SEED_MANIFEST.products.map((product) => product.slug).sort(),
    CATALOG_SLUGS,
    '商品 slug 取自素材清单',
  )
  assert.deepEqual(
    SEED_MANIFEST.categories.map((category) => category.slug).sort(),
    ['audio', 'displays', 'peripherals', 'wearables'],
    '四个商品类型齐全',
  )
  const perCategory = new Map<string, number>()
  for (const product of SEED_MANIFEST.products) {
    perCategory.set(product.categorySlug, (perCategory.get(product.categorySlug) ?? 0) + 1)
  }
  assert.deepEqual(
    [...perCategory.entries()].sort(),
    [['audio', 4], ['displays', 1], ['peripherals', 3], ['wearables', 2]],
    '四类分布为 audio 4 / peripherals 3 / displays 1 / wearables 2',
  )
  assert.equal(result.products, SEED_MANIFEST.products.length)

  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT p.id, p.slug, p.name, p.brand, p.model, p.rating, p.sales, p.detail, p.dimensions,
            c.slug AS category_slug
     FROM products p JOIN categories c ON c.id = p.category_id
     WHERE p.slug IN (?) ORDER BY p.slug`,
    [manifestSlugs],
  )
  assert.equal(rows.length, manifestSlugs.length, '本次清单中的商品应全部入库')

  const bySlug = new Map(rows.map((row) => [String(row.slug), row]))
  for (const product of SEED_MANIFEST.products) {
    const row = bySlug.get(product.slug)
    assert.ok(row !== undefined, `${product.slug} 应已导入`)
    assert.equal(row.name, product.name)
    assert.equal(row.category_slug, product.categorySlug)
    assert.equal(row.brand, product.brand)
    assert.equal(row.model, product.model)
    assert.equal(Number(row.rating), product.rating)
    assert.equal(Number(row.sales), product.sales)
    assert.deepEqual(asJson(row.detail), product.detail)
    assert.deepEqual(asJson(row.dimensions), product.dimensions)

    const [images] = await pool.query<RowDataPacket[]>(
      'SELECT path, sort_order, alt FROM product_images WHERE product_id = ? ORDER BY sort_order',
      [row.id],
    )
    assert.ok(images.length >= 4, `${product.slug} 至少应有 4 张图片`)
    assert.equal(images.length, product.images.length)
    images.forEach((image, index) => {
      assert.equal(image.path, `/images/products/${product.slug}/${index + 1}.webp`)
      assert.equal(Number(image.sort_order), index + 1)
      assert.ok(String(image.alt).length > 0, '图片 alt 不应为空')
    })
  }
})

test('种子连续执行两次：数据集一致且无重复行', async () => {
  await seedDatabase(db)
  const first = await datasetSnapshot()

  await seedDatabase(db)
  const second = await datasetSnapshot()

  assert.deepEqual(second, first, '第二次执行后的数据集应与第一次完全一致')

  const expectedImages = SEED_MANIFEST.products.reduce((total, product) => total + product.images.length, 0)
  assert.equal(first.products.length, SEED_MANIFEST.products.length, '商品行数应等于清单件数')
  assert.equal(first.images.length, expectedImages, '图片行数应等于清单图片总数')

  const [duplicateProducts] = await pool.query<RowDataPacket[]>(
    'SELECT slug, COUNT(*) AS count FROM products GROUP BY slug HAVING COUNT(*) > 1',
  )
  assert.deepEqual(duplicateProducts, [], 'products 不应出现重复 slug')

  const [duplicateImages] = await pool.query<RowDataPacket[]>(
    'SELECT product_id, path, COUNT(*) AS count FROM product_images GROUP BY product_id, path HAVING COUNT(*) > 1',
  )
  assert.deepEqual(duplicateImages, [], 'product_images 不应出现重复 (product_id, path)')
})

function manifestWithDetail (path: string): SeedManifest {
  const product = SEED_MANIFEST.products[0]!
  return {
    categories: SEED_MANIFEST.categories,
    products: [{ ...product, detail: [{ type: 'image', path, alt: '详情图' }] }],
  }
}

function manifestWithFirstImage (path: string): SeedManifest {
  const product = SEED_MANIFEST.products[0]!
  return {
    categories: SEED_MANIFEST.categories,
    products: [{
      ...product,
      images: product.images.map((image, index) => (index === 0 ? { ...image, path } : image)),
    }],
  }
}

test('详情图片路径规范化后必须仍在该商品目录内，拒绝 .. 与跨商品引用', () => {
  const slug = SEED_MANIFEST.products[0]!.slug
  const otherSlug = SEED_MANIFEST.products[1]!.slug

  assert.doesNotThrow(() => validateManifest(manifestWithDetail(`/images/products/${slug}/2.webp`)))

  const rejected = [
    `/images/products/${slug}/../${otherSlug}/1.webp`,
    `/images/products/${slug}/1.webp/../../1.webp`,
    `/images/products/${otherSlug}/1.webp`,
    `/images/products/${slug}/1.png`,
    `/images/products/${slug}/0.webp`,
    `/images/products/${slug}/1.webp/`,
  ]
  for (const path of rejected) {
    assert.throws(
      () => validateManifest(manifestWithDetail(path)),
      (error: unknown) => error instanceof SeedValidationError,
      `详情图片路径应被拒绝：${path}`,
    )
  }

  assert.throws(
    () => validateManifest(manifestWithFirstImage(`/images/products/${slug}/../other/1.webp`)),
    (error: unknown) => error instanceof SeedValidationError,
    '轮播图片路径同样拒绝 ..',
  )
})

test('详情块只接受文本与图片两型，且每件商品至少 4 张图片', () => {
  const product = SEED_MANIFEST.products[0]!

  assert.doesNotThrow(() => validateManifest(SEED_MANIFEST))

  assert.throws(
    () => validateManifest({
      categories: SEED_MANIFEST.categories,
      products: [{ ...product, detail: [{ type: 'video', url: 'x' }] as never }],
    }),
    (error: unknown) => error instanceof SeedValidationError,
    '未知详情块类型应被拒绝',
  )

  assert.throws(
    () => validateManifest({
      categories: SEED_MANIFEST.categories,
      products: [{ ...product, images: product.images.slice(0, 3) }],
    }),
    (error: unknown) => error instanceof SeedValidationError,
    '少于 4 张图片应被拒绝',
  )
})

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

test('未出现在本次清单里的商品与分类保留，支持分批导入', async () => {
  await pool.query("INSERT INTO categories (slug, name) VALUES ('legacy-cat', '历史分类')")
  await pool.query(
    `INSERT INTO products (slug, name, category_id, brand, model, rating, sales, detail, dimensions)
     VALUES ('legacy-product', '历史商品', (SELECT id FROM categories WHERE slug = 'legacy-cat'),
             '旧品牌', 'OLD-1', 4.0, 10, '[]', '[]')`,
  )
  const [legacyRows] = await pool.query<RowDataPacket[]>(
    "SELECT id FROM products WHERE slug = 'legacy-product'",
  )
  const legacyId = Number(legacyRows[0]!.id)
  await pool.query(
    "INSERT INTO product_images (product_id, path, sort_order, alt) VALUES (?, '/images/products/legacy-product/1.webp', 1, '历史图片')",
    [legacyId],
  )

  const batch: SeedManifest = {
    categories: [SEED_MANIFEST.categories[0]!],
    products: [SEED_MANIFEST.products[0]!],
  }
  await seedDatabase(db, batch)

  const [legacyCategories] = await pool.query<RowDataPacket[]>(
    "SELECT id FROM categories WHERE slug = 'legacy-cat'",
  )
  assert.equal(legacyCategories.length, 1, '清单外的分类应保留')

  const [legacyProducts] = await pool.query<RowDataPacket[]>(
    "SELECT id FROM products WHERE slug = 'legacy-product'",
  )
  assert.equal(legacyProducts.length, 1, '清单外的商品应保留')

  const [legacyImages] = await pool.query<RowDataPacket[]>(
    'SELECT path FROM product_images WHERE product_id = ?',
    [legacyId],
  )
  assert.deepEqual(legacyImages.map((row) => row.path), ['/images/products/legacy-product/1.webp'], '清单外商品的图片应保留')

  const [batchProducts] = await pool.query<RowDataPacket[]>(
    'SELECT slug FROM products WHERE slug = ?',
    [SEED_MANIFEST.products[0]!.slug],
  )
  assert.equal(batchProducts.length, 1, '本批商品应已导入')

  const [otherCategories] = await pool.query<RowDataPacket[]>(
    'SELECT slug FROM categories WHERE slug = ?',
    [SEED_MANIFEST.categories[1]!.slug],
  )
  assert.equal(otherCategories.length, 1, '未列入本批的分类应保留')
})

test('普通导入使用单事务：中途失败不留下部分写入', async () => {
  const validProduct = renameProduct(SEED_MANIFEST.products[0]!, 'tx-valid-product')
  const brokenProduct = {
    ...renameProduct(SEED_MANIFEST.products[1]!, 'tx-broken-product'),
    categorySlug: 'tx-missing-category',
  }
  const manifest: SeedManifest = {
    categories: [{ slug: 'tx-new-category', name: '事务测试分类' }],
    products: [validProduct, brokenProduct],
  }

  await assert.rejects(
    seedDatabase(db, manifest),
    (error: unknown) => String((error as Error).message).includes('tx-missing-category'),
    '引用缺失商品类型时应失败',
  )

  const [categories] = await pool.query<RowDataPacket[]>(
    "SELECT id FROM categories WHERE slug = 'tx-new-category'",
  )
  assert.equal(categories.length, 0, '事务回滚后不应留下新分类')

  const [products] = await pool.query<RowDataPacket[]>(
    "SELECT id FROM products WHERE slug IN ('tx-valid-product', 'tx-broken-product')",
  )
  assert.equal(products.length, 0, '事务回滚后不应留下任何商品')
})
