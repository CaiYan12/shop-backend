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

type RecommendationsBody = { items: ListItem[] } & ErrorBody

async function recommendations (slug: string): Promise<{
  status: number
  body: RecommendationsBody
}> {
  const response = await app.inject({
    method: 'GET',
    url: `/api/products/${slug}/recommendations`,
  })
  return { status: response.statusCode, body: response.json() }
}

interface RecommendationProbeOptions {
  slug: string
  categorySlug: string
  sales: number
  stock?: number
}

/** 探针商品：与种子清单互不干扰，用于构造同销量与同类优先的边界数据。 */
async function insertRecommendationProbe (options: RecommendationProbeOptions): Promise<void> {
  await pool.query("INSERT IGNORE INTO categories (slug, name) VALUES (?, '推荐探针')", [options.categorySlug])
  const [categoryRows] = await pool.query<RowDataPacket[]>(
    'SELECT id FROM categories WHERE slug = ?',
    [options.categorySlug],
  )
  const categoryId = Number(categoryRows[0]!.id)

  const dimensions = JSON.stringify([
    { name: '颜色', options: ['A'] },
    { name: '版本', options: ['B'] },
  ])
  const [product] = await pool.query<ResultSetHeader>(
    `INSERT INTO products (slug, name, category_id, brand, model, rating, sales, detail, dimensions)
     VALUES (?, ?, ?, '探针品牌', 'PROBE', 4.5, ?, '[]', ?)`,
    [options.slug, `探针商品 ${options.slug}`, categoryId, options.sales, dimensions],
  )
  await pool.query(
    `INSERT INTO product_variants (product_id, sku, option1_value, option2_value, price, original_price, stock)
     VALUES (?, ?, 'A', 'B', 100, 110, ?)`,
    [product.insertId, `${options.slug}-SKU`, options.stock ?? 3],
  )
  await pool.query(
    'INSERT INTO product_images (product_id, path, sort_order, alt) VALUES (?, ?, 0, ?)',
    [product.insertId, `/images/products/${options.slug}/1.webp`, `探针封面 ${options.slug}`],
  )
}

/** 删除探针商品类型及其商品；规格组合与图片随商品级联删除。 */
async function deleteRecommendationProbeCategory (categorySlug: string): Promise<void> {
  await pool.query(
    'DELETE FROM products WHERE category_id IN (SELECT id FROM categories WHERE slug = ?)',
    [categorySlug],
  )
  await pool.query('DELETE FROM categories WHERE slug = ?', [categorySlug])
}

test('不存在的 slug 返回 404 与 PRODUCT_NOT_FOUND', async () => {
  const { status, body } = await recommendations('no-such-product')
  assert.equal(status, 404)
  assert.deepEqual(body, {
    error: {
      code: 'PRODUCT_NOT_FOUND',
      message: '商品不存在。',
    },
  })
})

test('返回恰好 4 件，排除当前商品且无重复，字段与列表项一致', async () => {
  const listResponse = await app.inject({
    method: 'GET',
    url: '/api/products?pageSize=50',
  })
  const listBody = listResponse.json() as { items: ListItem[] }
  const listItems = new Map(listBody.items.map((item) => [item.slug, item]))

  const { status, body } = await recommendations('apple-earpods')
  assert.equal(status, 200)
  assert.equal(body.items.length, 4)
  assert.equal(body.items.some((item) => item.slug === 'apple-earpods'), false, '不含当前商品')
  assert.equal(new Set(body.items.map((item) => item.slug)).size, 4, '结果无重复')

  for (const item of body.items) {
    assert.deepEqual(item, listItems.get(item.slug), `${item.slug} 的字段应与列表项一致`)
  }
})

test('同类优先，按销量降序，同类不足时从其他商品类型补足', async () => {
  const { status, body } = await recommendations('apple-earpods')
  assert.equal(status, 200)
  assert.deepEqual(body.items.map((item) => item.slug), [
    'sony-wh-1000xm3', // audio，销量 2140
    'sony-wh-ch500', // audio，销量 1870
    'airpods-max', // audio，销量 1280
    'apple-watch-series-8', // wearables，销量 1540，其他类型中最高
  ])
  assert.deepEqual(body.items.map((item) => item.category.slug), [
    'audio',
    'audio',
    'audio',
    'wearables',
  ])
})

test('售罄商品可以出现在相关推荐中', async () => {
  const { status, body } = await recommendations('asus-pa246q')
  assert.equal(status, 200)
  assert.equal(body.items.length, 4)

  const soldOut = body.items.find((item) => item.slug === 'dell-e2210f')
  assert.ok(soldOut, '售罄商品应可入选')
  assert.equal(soldOut.soldOut, true)
  assert.equal(soldOut.displayPriceCents, 29900)
  assert.equal(soldOut.displayOriginalPriceCents, 39900)
})

test('同销量按 id 升序；同类商品销量更低时仍排在其他类型之前', async () => {
  const categorySlug = 'recommendation-probe-tie'
  try {
    await insertRecommendationProbe({ slug: 'probe-current', categorySlug, sales: 0 })
    await insertRecommendationProbe({ slug: 'probe-tie-first', categorySlug, sales: 500 })
    await insertRecommendationProbe({ slug: 'probe-tie-second', categorySlug, sales: 500 })

    const { status, body } = await recommendations('probe-current')
    assert.equal(status, 200)
    assert.deepEqual(body.items.map((item) => item.slug), [
      'probe-tie-first', // 同类，销量 500，id 更小
      'probe-tie-second', // 同类，销量 500，id 更大
      'apple-earpods', // 其他类型，销量 5620
      'sony-wh-1000xm3', // 其他类型，销量 2140
    ])
  } finally {
    await deleteRecommendationProbeCategory(categorySlug)
  }
})

test('非法 slug 格式返回 400 与 VALIDATION_FAILED，明细指向路径参数', async () => {
  const { status, body } = await recommendations('Apple-EarPods')
  assert.equal(status, 400)
  assert.equal(body.error.code, 'VALIDATION_FAILED')
  assert.equal(body.error.details?.[0]?.path, 'params/slug')
})
