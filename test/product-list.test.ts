import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import type { ResultSetHeader, RowDataPacket } from 'mysql2'
import type { Pool } from 'mysql2/promise'
import type { AppInstance } from '../src/app.ts'
import type { ErrorBody, ListItem } from './helpers/api-types.ts'
import { closeSeededApp, createSeededApp } from './helpers/seeded-app.ts'

let pool: Pool
let app: AppInstance

before(async () => {
  ({ pool, app } = await createSeededApp())
})

after(async () => {
  await closeSeededApp({ pool, app })
})

interface ListBody {
  page: number
  pageSize: number
  total: number
  totalPages: number
  items: ListItem[]
}

async function list (query: Record<string, string | number> = {}): Promise<{
  status: number
  body: ListBody & ErrorBody
}> {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) search.set(key, String(value))
  const suffix = search.size === 0 ? '' : `?${search.toString()}`
  const response = await app.inject({ method: 'GET', url: `/api/products${suffix}` })
  return { status: response.statusCode, body: response.json() }
}

interface ListProbeOptions {
  slug: string
  categorySlug: string
  priceCents: number
  sales: number
  images?: number
}

/** 探针商品：与种子清单互不干扰，用于构造筛选与数据完整性的边界数据。 */
async function insertListProbe (options: ListProbeOptions): Promise<void> {
  await pool.query("INSERT IGNORE INTO categories (slug, name) VALUES (?, '列表探针')", [options.categorySlug])
  const [categoryRows] = await pool.query<RowDataPacket[]>(
    'SELECT id FROM categories WHERE slug = ?',
    [options.categorySlug],
  )
  const categoryId = Number(categoryRows[0]!.id)
  const [product] = await pool.query<ResultSetHeader>(
    `INSERT INTO products (slug, name, category_id, brand, model, rating, sales, detail, dimensions)
     VALUES (?, ?, ?, '探针品牌', 'PROBE', 4.5, ?, '[]', '[]')`,
    [options.slug, `探针商品 ${options.slug}`, categoryId, options.sales],
  )
  await pool.query(
    `INSERT INTO product_variants (product_id, sku, option1_value, option2_value, price, original_price, stock)
     VALUES (?, ?, 'A', 'B', ?, ?, 5)`,
    [product.insertId, `${options.slug}-SKU`, options.priceCents / 100, options.priceCents / 100 + 10],
  )
  for (let index = 1; index <= (options.images ?? 1); index += 1) {
    await pool.query(
      `INSERT INTO product_images (product_id, path, sort_order, alt) VALUES (?, ?, ?, ?)`,
      [product.insertId, `/images/products/${options.slug}/${index}.webp`, index, `探针封面 ${index}`],
    )
  }
}

/** 删除探针商品类型及其商品；规格组合与图片随商品级联删除。 */
async function deleteListProbeCategory (categorySlug: string): Promise<void> {
  await pool.query(
    'DELETE FROM products WHERE category_id IN (SELECT id FROM categories WHERE slug = ?)',
    [categorySlug],
  )
  await pool.query('DELETE FROM categories WHERE slug = ?', [categorySlug])
}

test('默认请求返回第一页 8 件，按销量降序并带齐卡片字段', async () => {
  const { status, body } = await list()
  assert.equal(status, 200)
  assert.equal(body.page, 1)
  assert.equal(body.pageSize, 8)
  assert.equal(body.total, 16)
  assert.equal(body.totalPages, 2)
  assert.deepEqual(body.items.map((item) => item.slug), [
    'apple-earpods',
    'sony-wh-1000xm3',
    'sony-wh-ch500',
    'apple-watch-series-8',
    'airpods-max',
    'apple-watch-ultra',
    'keychron-k8',
    'huawei-watch',
  ])

  assert.deepEqual(body.items[0], {
    slug: 'apple-earpods',
    name: 'Apple EarPods 有线耳机（Lightning）',
    brand: 'Apple',
    model: 'MMTN2',
    category: { slug: 'audio', name: '音频设备' },
    displayPriceCents: 12900,
    displayOriginalPriceCents: 14900,
    soldOut: false,
    rating: 4.5,
    sales: 5620,
    coverImage: {
      path: '/images/products/apple-earpods/1.webp',
      alt: 'Apple EarPods 包装盒与耳机俯视',
    },
  })

  for (const item of body.items) {
    assert.equal(Number.isInteger(item.displayPriceCents), true, `${item.slug} 的展示价应为整数分`)
    assert.equal(Number.isInteger(item.displayOriginalPriceCents), true, `${item.slug} 的展示原价应为整数分`)
  }
})

test('分页：页码与每页数量生效，超出末页返回空列表并保留请求页码与真实总数', async () => {
  const second = await list({ page: 2 })
  assert.equal(second.status, 200)
  assert.equal(second.body.page, 2)
  assert.equal(second.body.pageSize, 8)
  assert.equal(second.body.total, 16)
  assert.equal(second.body.totalPages, 2)
  assert.deepEqual(second.body.items.map((item) => item.slug), [
    'logitech-g613',
    'samsung-gear-s3',
    'cherry-g80-3850',
    'logitech-g15',
    'asus-pa246q',
    'dell-e2210f',
    'dell-p2212h',
    'dell-s3423dwc',
  ])

  const beyond = await list({ page: 3 })
  assert.equal(beyond.status, 200)
  assert.equal(beyond.body.page, 3)
  assert.equal(beyond.body.total, 16)
  assert.equal(beyond.body.totalPages, 2)
  assert.deepEqual(beyond.body.items, [])

  const customSize = await list({ page: 4, pageSize: 5 })
  assert.equal(customSize.status, 200)
  assert.equal(customSize.body.page, 4)
  assert.equal(customSize.body.pageSize, 5)
  assert.equal(customSize.body.totalPages, 4)
  assert.deepEqual(customSize.body.items.map((item) => item.slug), ['dell-s3423dwc'])
})

test('分页参数越界返回 400 与 VALIDATION_FAILED，明细指向具体字段', async () => {
  const outOfRange: Array<Record<string, number>> = [
    { page: 201 },
    { page: 0 },
    { pageSize: 51 },
    { pageSize: 0 },
  ]
  for (const query of outOfRange) {
    const { status, body } = await list(query)
    assert.equal(status, 400, `${JSON.stringify(query)} 应返回 400`)
    assert.equal(body.error.code, 'VALIDATION_FAILED')
    assert.equal(Array.isArray(body.error.details), true)
    assert.equal(body.error.details![0]!.path, `querystring/${Object.keys(query)[0]}`)
  }
})

/** 种子数据的字面期望次序（不按实现公式重算）：价格相同的一对按商品 id 升序。 */
const PRICE_ASC_SLUGS = [
  'apple-earpods',
  'logitech-g15',
  'dell-e2210f',
  'sony-wh-ch500',
  'cherry-g80-3850',
  'keychron-k8',
  'logitech-g613',
  'dell-p2212h',
  'asus-pa246q',
  'huawei-watch',
  'samsung-gear-s3',
  'sony-wh-1000xm3',
  'dell-s3423dwc',
  'apple-watch-series-8',
  'airpods-max',
  'apple-watch-ultra',
]

const PRICE_DESC_SLUGS = [
  'apple-watch-ultra',
  'airpods-max',
  'apple-watch-series-8',
  'dell-s3423dwc',
  'sony-wh-1000xm3',
  'samsung-gear-s3',
  'huawei-watch',
  'asus-pa246q',
  'dell-p2212h',
  'logitech-g613',
  'keychron-k8',
  'sony-wh-ch500',
  'cherry-g80-3850',
  'dell-e2210f',
  'logitech-g15',
  'apple-earpods',
]

test('三种排序次序正确：价格升序、价格降序、销量降序', async () => {
  const asc = await list({ sort: 'price_asc' })
  assert.equal(asc.status, 200)
  assert.deepEqual(asc.body.items.map((item) => item.slug), PRICE_ASC_SLUGS.slice(0, 8))

  const desc = await list({ sort: 'price_desc' })
  assert.equal(desc.status, 200)
  assert.deepEqual(desc.body.items.map((item) => item.slug), PRICE_DESC_SLUGS.slice(0, 8))

  const sales = await list({ sort: 'sales_desc' })
  assert.equal(sales.status, 200)
  assert.deepEqual(sales.body.items.map((item) => item.slug), [
    'apple-earpods',
    'sony-wh-1000xm3',
    'sony-wh-ch500',
    'apple-watch-series-8',
    'airpods-max',
    'apple-watch-ultra',
    'keychron-k8',
    'huawei-watch',
  ])

  const invalid = await list({ sort: 'unknown' })
  assert.equal(invalid.status, 400)
  assert.equal(invalid.body.error.code, 'VALIDATION_FAILED')
  assert.equal(invalid.body.error.details?.[0]?.path, 'querystring/sort')
})

test('同值按固定次序：逐页取回不重复、不遗漏', async () => {
  const collected: string[] = []
  for (let page = 1; page <= 16; page += 1) {
    const { status, body } = await list({ sort: 'price_asc', page, pageSize: 1 })
    assert.equal(status, 200)
    assert.equal(body.total, 16)
    collected.push(...body.items.map((item) => item.slug))
  }
  assert.deepEqual(collected, PRICE_ASC_SLUGS)
  assert.equal(new Set(collected).size, collected.length, '逐页结果不应重复')
})

test('商品类型筛选只返回该类型，未知类型返回空结果且 totalPages 为 0', async () => {
  const displays = await list({ category: 'displays' })
  assert.equal(displays.status, 200)
  assert.equal(displays.body.total, 4)
  assert.equal(displays.body.totalPages, 1)
  assert.deepEqual(displays.body.items.map((item) => item.slug), [
    'asus-pa246q',
    'dell-e2210f',
    'dell-p2212h',
    'dell-s3423dwc',
  ])
  for (const item of displays.body.items) {
    assert.deepEqual(item.category, { slug: 'displays', name: '显示设备' })
  }

  const unknown = await list({ category: 'no-such-category' })
  assert.equal(unknown.status, 200)
  assert.equal(unknown.body.total, 0)
  assert.equal(unknown.body.totalPages, 0)
  assert.deepEqual(unknown.body.items, [])
})

test('价格区间含端点：19999 / 20000 / 20001 分探针分别命中正确区间', async () => {
  const categorySlug = 'list-probe-price'
  try {
    await insertListProbe({ slug: 'list-probe-19999', categorySlug, priceCents: 19999, sales: 0 })
    await insertListProbe({ slug: 'list-probe-20000', categorySlug, priceCents: 20000, sales: 0 })
    await insertListProbe({ slug: 'list-probe-20001', categorySlug, priceCents: 20001, sales: 0 })

    const exactMin = await list({ priceMinCents: 19999, priceMaxCents: 19999 })
    assert.deepEqual(exactMin.body.items.map((item) => item.slug), ['list-probe-19999'])

    const exactMiddle = await list({ priceMinCents: 20000, priceMaxCents: 20000 })
    assert.deepEqual(exactMiddle.body.items.map((item) => item.slug), ['list-probe-20000'])

    const exactMax = await list({ priceMinCents: 20001, priceMaxCents: 20001 })
    assert.deepEqual(exactMax.body.items.map((item) => item.slug), ['list-probe-20001'])

    const lowerEndpoint = await list({ priceMinCents: 19999, priceMaxCents: 20000 })
    assert.deepEqual(lowerEndpoint.body.items.map((item) => item.slug), [
      'list-probe-19999',
      'list-probe-20000',
    ])

    const upperEndpoint = await list({ priceMinCents: 20000, priceMaxCents: 20001 })
    assert.deepEqual(upperEndpoint.body.items.map((item) => item.slug), [
      'list-probe-20000',
      'list-probe-20001',
    ])
  } finally {
    await deleteListProbeCategory(categorySlug)
  }
})

test('最低销量含端点：等于下限的商品命中', async () => {
  const inclusive = await list({ minSales: 1280 })
  assert.equal(inclusive.status, 200)
  assert.equal(inclusive.body.total, 5)
  assert.deepEqual(inclusive.body.items.map((item) => item.slug), [
    'apple-earpods',
    'sony-wh-1000xm3',
    'sony-wh-ch500',
    'apple-watch-series-8',
    'airpods-max',
  ])

  const exclusive = await list({ minSales: 1281 })
  assert.equal(exclusive.body.total, 4)
  assert.deepEqual(exclusive.body.items.map((item) => item.slug), [
    'apple-earpods',
    'sony-wh-1000xm3',
    'sony-wh-ch500',
    'apple-watch-series-8',
  ])
})

test('筛选条件可组合：商品类型与最低销量同时生效', async () => {
  const { status, body } = await list({ category: 'audio', minSales: 2000 })
  assert.equal(status, 200)
  assert.equal(body.total, 2)
  assert.deepEqual(body.items.map((item) => item.slug), ['apple-earpods', 'sony-wh-1000xm3'])
})

test('价格下限大于上限返回 400 与 VALIDATION_FAILED，明细指向价格下限', async () => {
  const { status, body } = await list({ priceMinCents: 20000, priceMaxCents: 19999 })
  assert.equal(status, 400)
  assert.equal(body.error.code, 'VALIDATION_FAILED')
  assert.equal(body.error.details?.[0]?.path, 'querystring/priceMinCents')
})

test('请求校验先于服务不可用：跨字段价格错误与非法关键词同时出现时返回 400', async () => {
  const { status, body } = await list({
    keyword: '蓝牙',
    priceMinCents: 20000,
    priceMaxCents: 19999,
  })
  assert.equal(status, 400, '可修正的请求校验应排在 503 之前')
  assert.equal(body.error.code, 'VALIDATION_FAILED')
  assert.equal(body.error.details?.[0]?.path, 'querystring/priceMinCents')
})

test('非空关键词返回 503 与 SEARCH_NOT_AVAILABLE', async () => {
  const { status, body } = await list({ keyword: '蓝牙' })
  assert.equal(status, 503)
  assert.equal(body.error.code, 'SEARCH_NOT_AVAILABLE')
  assert.equal(typeof body.error.message, 'string')
})

test('空串、纯空白与超长空白关键词都按无关键词处理', async () => {
  const baseline = await list()
  assert.equal(baseline.status, 200)

  for (const keyword of ['', '   ', ' '.repeat(101)]) {
    const { status, body } = await list({ keyword })
    assert.equal(status, 200, `关键词 ${JSON.stringify(keyword)} 应按无关键词处理`)
    assert.equal(body.total, baseline.body.total)
    assert.deepEqual(body.items.map((item) => item.slug), baseline.body.items.map((item) => item.slug))
  }
})

test('关键词 trim 后超过 100 字符返回 400 与 VALIDATION_FAILED', async () => {
  const { status, body } = await list({ keyword: `  ${'a'.repeat(101)}  ` })
  assert.equal(status, 400)
  assert.equal(body.error.code, 'VALIDATION_FAILED')
  assert.equal(body.error.details?.[0]?.path, 'querystring/keyword')
})

test('封面图取 sort_order 最小的图片，售罄标记与展示价来自派生查询', async () => {
  const { status, body } = await list({ page: 2 })
  assert.equal(status, 200)

  for (const item of body.items) {
    assert.match(item.coverImage.path, new RegExp(`^/images/products/${item.slug}/\\d+\\.webp$`))
    assert.equal(item.coverImage.alt.length > 0, true, `${item.slug} 的封面图应有替代文本`)
  }

  const soldOut = body.items.find((item) => item.slug === 'dell-e2210f')
  assert.ok(soldOut !== undefined, '第二页应包含售罄商品')
  assert.equal(soldOut.soldOut, true)
  assert.equal(soldOut.displayPriceCents, 29900)
  assert.equal(soldOut.displayOriginalPriceCents, 39900)

  const inStock = body.items.find((item) => item.slug === 'logitech-g613')
  assert.ok(inStock !== undefined)
  assert.equal(inStock.soldOut, false)
})

test('商品缺少封面图时返回 500 与 INTERNAL_ERROR，响应体不泄露内部细节', async () => {
  const categorySlug = 'list-probe-no-cover'
  try {
    await insertListProbe({
      slug: 'list-probe-no-cover',
      categorySlug,
      priceCents: 10000,
      sales: 0,
      images: 0,
    })

    const { status, body } = await list({ category: categorySlug })
    assert.equal(status, 500)
    assert.deepEqual(body, {
      error: { code: 'INTERNAL_ERROR', message: '服务内部错误。' },
    })
    assert.equal(JSON.stringify(body).includes('list-probe-no-cover'), false)
  } finally {
    await deleteListProbeCategory(categorySlug)
  }
})
