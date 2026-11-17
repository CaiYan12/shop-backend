import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import type { ResultSetHeader, RowDataPacket } from 'mysql2'
import type { Pool } from 'mysql2/promise'
import { createApp, type AppInstance } from '../src/app.ts'
import { createDb, createPool, type Database } from '../src/db/client.ts'
import { runMigrations } from '../src/db/migrate.ts'
import { seedDatabase } from '../src/db/seed.ts'
import { loadTestConfig } from './helpers/test-config.ts'

const config = loadTestConfig()
let pool: Pool
let db: Database
let app: AppInstance

/** 购买校验探针：价格与库存都取可精确断言的值，不与种子清单耦合。 */
const PROBE_CATEGORY_SLUG = 'purchase-check-probe'
const PROBE_PRODUCT_SLUG = 'purchase-check-probe-a'
const PROBE_OTHER_PRODUCT_SLUG = 'purchase-check-probe-b'
const PROBE_SKU = 'PURCHASE-PROBE-A1'
const PROBE_OTHER_SKU = 'PURCHASE-PROBE-B1'
/** 探针单价 100.00 元 = 10000 分；库存 5 件。 */
const PROBE_PRICE_CENTS = 10_000
const PROBE_STOCK = 5

before(async () => {
  pool = createPool(config)
  db = createDb(pool)
  await runMigrations(db)
  await seedDatabase(db)
  await insertPurchaseProbes()
  app = await createApp({ db, config })
  await app.ready()
})

after(async () => {
  await app.close()
  await deletePurchaseProbes()
  await pool.end()
})

interface PurchaseProductBody {
  slug: string
  name: string
}

interface PurchaseVariantBody {
  sku: string
  option1Value: string
  option2Value: string
}

interface PurchaseCheckBody {
  result: 'purchasable' | 'blocked'
  reason?: 'INSUFFICIENT_STOCK' | 'PRICE_CHANGED'
  product: PurchaseProductBody
  variant: PurchaseVariantBody
  quantity: number
  unitPriceCents: number
  subtotalCents: number
  stock: number
  priceChanged: boolean
  requestedUnitPriceCents?: number
}

interface ErrorBody {
  error: {
    code: string
    message: string
    details?: Array<{ path: string, message: string }>
  }
}

async function insertProbeProduct (
  slug: string,
  name: string,
  sku: string,
  option1Value: string,
  option2Value: string,
  price: number,
  stock: number,
): Promise<void> {
  const [categoryRows] = await pool.query<RowDataPacket[]>(
    'SELECT id FROM categories WHERE slug = ?',
    [PROBE_CATEGORY_SLUG],
  )
  const categoryId = Number(categoryRows[0]!.id)

  const [product] = await pool.query<ResultSetHeader>(
    `INSERT INTO products (slug, name, category_id, brand, model, rating, sales, detail, dimensions)
     VALUES (?, ?, ?, '探针品牌', 'PROBE', 4.5, 0, '[]', ?)`,
    [
      slug,
      name,
      categoryId,
      JSON.stringify([
        { name: '颜色', options: [option1Value] },
        { name: '版本', options: [option2Value] },
      ]),
    ],
  )
  await pool.query(
    `INSERT INTO product_variants (product_id, sku, option1_value, option2_value, price, original_price, stock)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [product.insertId, sku, option1Value, option2Value, price, price + 10, stock],
  )
  // 详情接口要求封面图必填（D67）；这里补一张，供「只校验不写库」用详情接口观察。
  await pool.query(
    'INSERT INTO product_images (product_id, path, sort_order, alt) VALUES (?, ?, 0, ?)',
    [product.insertId, `/images/products/${slug}/1.webp`, `${name} 封面`],
  )
}

/** 探针商品：A 用于正常路径，B 用于「规格组合不属于该商品」。 */
async function insertPurchaseProbes (): Promise<void> {
  await pool.query("INSERT IGNORE INTO categories (slug, name) VALUES (?, '购买校验探针')", [
    PROBE_CATEGORY_SLUG,
  ])
  await insertProbeProduct(
    PROBE_PRODUCT_SLUG,
    '购买校验探针 A',
    PROBE_SKU,
    '黑',
    '标准',
    PROBE_PRICE_CENTS / 100,
    PROBE_STOCK,
  )
  await insertProbeProduct(
    PROBE_OTHER_PRODUCT_SLUG,
    '购买校验探针 B',
    PROBE_OTHER_SKU,
    '白',
    '标准',
    50,
    2,
  )
}

/** 删除探针商品类型及其商品；规格组合随商品级联删除。 */
async function deletePurchaseProbes (): Promise<void> {
  await pool.query(
    'DELETE FROM products WHERE category_id IN (SELECT id FROM categories WHERE slug = ?)',
    [PROBE_CATEGORY_SLUG],
  )
  await pool.query('DELETE FROM categories WHERE slug = ?', [PROBE_CATEGORY_SLUG])
}

async function check (payload: Record<string, unknown>): Promise<{
  status: number
  body: PurchaseCheckBody & ErrorBody
}> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/purchase-check',
    payload,
  })
  return { status: response.statusCode, body: response.json() }
}

test('可购买分支返回 200，并带齐商品、规格组合、数量、单价、小计与库存', async () => {
  const { status, body } = await check({
    slug: PROBE_PRODUCT_SLUG,
    sku: PROBE_SKU,
    quantity: 2,
  })

  assert.equal(status, 200)
  assert.deepEqual(body, {
    result: 'purchasable',
    product: { slug: PROBE_PRODUCT_SLUG, name: '购买校验探针 A' },
    variant: { sku: PROBE_SKU, option1Value: '黑', option2Value: '标准' },
    quantity: 2,
    unitPriceCents: PROBE_PRICE_CENTS,
    subtotalCents: PROBE_PRICE_CENTS * 2,
    stock: PROBE_STOCK,
    priceChanged: false,
  })
})

test('库存不足分支返回 blocked + INSUFFICIENT_STOCK 与剩余库存，金额仍按当前库价计算', async () => {
  const quantity = PROBE_STOCK + 1
  const { status, body } = await check({
    slug: PROBE_PRODUCT_SLUG,
    sku: PROBE_SKU,
    quantity,
  })

  assert.equal(status, 200)
  assert.deepEqual(body, {
    result: 'blocked',
    reason: 'INSUFFICIENT_STOCK',
    product: { slug: PROBE_PRODUCT_SLUG, name: '购买校验探针 A' },
    variant: { sku: PROBE_SKU, option1Value: '黑', option2Value: '标准' },
    quantity,
    unitPriceCents: PROBE_PRICE_CENTS,
    subtotalCents: PROBE_PRICE_CENTS * quantity,
    stock: PROBE_STOCK,
    priceChanged: false,
  })
})

test('价格变化分支返回 blocked + PRICE_CHANGED、请求价与当前价', async () => {
  const requestedUnitPriceCents = PROBE_PRICE_CENTS - 100
  const { status, body } = await check({
    slug: PROBE_PRODUCT_SLUG,
    sku: PROBE_SKU,
    quantity: 1,
    expectedUnitPriceCents: requestedUnitPriceCents,
  })

  assert.equal(status, 200)
  assert.deepEqual(body, {
    result: 'blocked',
    reason: 'PRICE_CHANGED',
    product: { slug: PROBE_PRODUCT_SLUG, name: '购买校验探针 A' },
    variant: { sku: PROBE_SKU, option1Value: '黑', option2Value: '标准' },
    quantity: 1,
    unitPriceCents: PROBE_PRICE_CENTS,
    subtotalCents: PROBE_PRICE_CENTS,
    stock: PROBE_STOCK,
    priceChanged: true,
    requestedUnitPriceCents,
  })
})

test('库存不足且价格变化同时发生时，原因为 INSUFFICIENT_STOCK 且 priceChanged 为 true', async () => {
  const quantity = PROBE_STOCK + 1
  const { status, body } = await check({
    slug: PROBE_PRODUCT_SLUG,
    sku: PROBE_SKU,
    quantity,
    expectedUnitPriceCents: PROBE_PRICE_CENTS - 100,
  })

  assert.equal(status, 200)
  assert.equal(body.result, 'blocked')
  assert.equal(body.reason, 'INSUFFICIENT_STOCK')
  assert.equal(body.priceChanged, true)
  assert.equal(body.stock, PROBE_STOCK)
  // 价格变化分支才必带请求价；库存不足分支不应带出该字段。
  assert.equal('requestedUnitPriceCents' in body, false)
})

test('预期价与当前价一致时仍可购买，且 priceChanged 为 false', async () => {
  const { status, body } = await check({
    slug: PROBE_PRODUCT_SLUG,
    sku: PROBE_SKU,
    quantity: 1,
    expectedUnitPriceCents: PROBE_PRICE_CENTS,
  })

  assert.equal(status, 200)
  assert.equal(body.result, 'purchasable')
  assert.equal(body.priceChanged, false)
  assert.equal(body.unitPriceCents, PROBE_PRICE_CENTS)
  assert.equal(body.subtotalCents, PROBE_PRICE_CENTS)
})

test('预期价 0 分是合法输入：按价格变化阻止，并原样回显请求价', async () => {
  const { status, body } = await check({
    slug: PROBE_PRODUCT_SLUG,
    sku: PROBE_SKU,
    quantity: 1,
    expectedUnitPriceCents: 0,
  })

  assert.equal(status, 200)
  assert.equal(body.result, 'blocked')
  assert.equal(body.reason, 'PRICE_CHANGED')
  assert.equal(body.priceChanged, true)
  assert.equal(body.requestedUnitPriceCents, 0)
})

test('数量等于库存时仍可购买（边界含端点）', async () => {
  const { status, body } = await check({
    slug: PROBE_PRODUCT_SLUG,
    sku: PROBE_SKU,
    quantity: PROBE_STOCK,
  })

  assert.equal(status, 200)
  assert.equal(body.result, 'purchasable')
  assert.equal(body.stock, PROBE_STOCK)
})

test('商品不存在返回 404 与 PRODUCT_NOT_FOUND', async () => {
  const { status, body } = await check({
    slug: 'no-such-product',
    sku: PROBE_SKU,
    quantity: 1,
  })

  assert.equal(status, 404)
  assert.deepEqual(body, {
    error: {
      code: 'PRODUCT_NOT_FOUND',
      message: '商品不存在。',
    },
  })
})

test('规格组合不存在返回 404 与 VARIANT_NOT_FOUND', async () => {
  const { status, body } = await check({
    slug: PROBE_PRODUCT_SLUG,
    sku: 'NO-SUCH-SKU',
    quantity: 1,
  })

  assert.equal(status, 404)
  assert.deepEqual(body, {
    error: {
      code: 'VARIANT_NOT_FOUND',
      message: '规格组合不存在。',
    },
  })
})

test('规格组合不属于该商品返回 409 与 VARIANT_NOT_IN_PRODUCT，且先于库存判定', async () => {
  // 数量超过两件商品的库存：若先判库存会返回 blocked，归属错误必须优先暴露。
  const { status, body } = await check({
    slug: PROBE_PRODUCT_SLUG,
    sku: PROBE_OTHER_SKU,
    quantity: 999,
  })

  assert.equal(status, 409)
  assert.deepEqual(body, {
    error: {
      code: 'VARIANT_NOT_IN_PRODUCT',
      message: '规格组合不属于该商品。',
    },
  })
})

test('数量越界返回 400 与 VALIDATION_FAILED，明细指向 body/quantity', async () => {
  const outOfRange = [0, 1000, 1.5]
  for (const quantity of outOfRange) {
    const { status, body } = await check({
      slug: PROBE_PRODUCT_SLUG,
      sku: PROBE_SKU,
      quantity,
    })
    assert.equal(status, 400, `quantity=${quantity} 应返回 400`)
    assert.equal(body.error.code, 'VALIDATION_FAILED')
    assert.equal(body.error.details?.[0]?.path, 'body/quantity')
  }
})

test('校验前后库存与价格不变（只校验不写库）', async () => {
  const before = await detailVariants(PROBE_PRODUCT_SLUG)

  await check({ slug: PROBE_PRODUCT_SLUG, sku: PROBE_SKU, quantity: 2 })
  await check({ slug: PROBE_PRODUCT_SLUG, sku: PROBE_SKU, quantity: PROBE_STOCK + 1 })
  await check({
    slug: PROBE_PRODUCT_SLUG,
    sku: PROBE_SKU,
    quantity: 1,
    expectedUnitPriceCents: PROBE_PRICE_CENTS - 100,
  })

  const after = await detailVariants(PROBE_PRODUCT_SLUG)
  assert.deepEqual(after, before)
})

/** 通过详情接口观察探针商品的规格组合，避免测试直接读库断言实现细节。 */
async function detailVariants (slug: string): Promise<Array<Record<string, unknown>>> {
  const response = await app.inject({ method: 'GET', url: `/api/products/${slug}` })
  assert.equal(response.statusCode, 200)
  return response.json().variants as Array<Record<string, unknown>>
}


