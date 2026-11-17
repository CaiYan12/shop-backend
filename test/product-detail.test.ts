import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import type { ResultSetHeader, RowDataPacket } from 'mysql2'
import type { Pool } from 'mysql2/promise'
import type { AppInstance } from '../src/app.ts'
import type { ErrorBody } from './helpers/api-types.ts'
import { closeSeededApp, createSeededApp } from './helpers/seeded-app.ts'

let pool: Pool
let app: AppInstance

before(async () => {
  ({ pool, app } = await createSeededApp())
})

after(async () => {
  await closeSeededApp({ pool, app })
})

interface DetailImage {
  path: string
  alt: string
}

interface DetailVariant {
  sku: string
  option1Value: string
  option2Value: string
  priceCents: number
  originalPriceCents: number
  stock: number
}

type DetailBlockBody =
  | { type: 'text', text: string }
  | { type: 'image', path: string, alt: string }

interface DetailBody {
  slug: string
  name: string
  brand: string
  model: string
  category: { slug: string, name: string }
  displayPriceCents: number
  displayOriginalPriceCents: number
  soldOut: boolean
  rating: number
  sales: number
  coverImage: DetailImage
  stock: number
  images: DetailImage[]
  dimensions: Array<{ name: string, options: string[] }>
  variants: DetailVariant[]
  detail: DetailBlockBody[]
}

async function detail (slug: string): Promise<{
  status: number
  body: DetailBody & ErrorBody
}> {
  const response = await app.inject({ method: 'GET', url: `/api/products/${slug}` })
  return { status: response.statusCode, body: response.json() }
}

/** 只取列表项字段，便于与列表接口的卡片字段逐项比对。 */
function listItemFields (body: DetailBody): Record<string, unknown> {
  return {
    slug: body.slug,
    name: body.name,
    brand: body.brand,
    model: body.model,
    category: body.category,
    displayPriceCents: body.displayPriceCents,
    displayOriginalPriceCents: body.displayOriginalPriceCents,
    soldOut: body.soldOut,
    rating: body.rating,
    sales: body.sales,
    coverImage: body.coverImage,
  }
}

interface DetailProbeOptions {
  slug: string
  categorySlug: string
  images: Array<{ path: string, sortOrder: number, alt: string }>
}

/** 探针商品：与种子清单互不干扰，用于构造排序与数据完整性的边界数据。 */
async function insertDetailProbe (options: DetailProbeOptions): Promise<void> {
  await pool.query("INSERT IGNORE INTO categories (slug, name) VALUES (?, '详情探针')", [options.categorySlug])
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
     VALUES (?, ?, ?, '探针品牌', 'PROBE', 4.5, 0, '[]', ?)`,
    [options.slug, `探针商品 ${options.slug}`, categoryId, dimensions],
  )
  await pool.query(
    `INSERT INTO product_variants (product_id, sku, option1_value, option2_value, price, original_price, stock)
     VALUES (?, ?, 'A', 'B', 100, 110, 3)`,
    [product.insertId, `${options.slug}-SKU`],
  )
  for (const image of options.images) {
    await pool.query(
      'INSERT INTO product_images (product_id, path, sort_order, alt) VALUES (?, ?, ?, ?)',
      [product.insertId, image.path, image.sortOrder, image.alt],
    )
  }
}

/** 删除探针商品类型及其商品；规格组合与图片随商品级联删除。 */
async function deleteDetailProbeCategory (categorySlug: string): Promise<void> {
  await pool.query(
    'DELETE FROM products WHERE category_id IN (SELECT id FROM categories WHERE slug = ?)',
    [categorySlug],
  )
  await pool.query('DELETE FROM categories WHERE slug = ?', [categorySlug])
}

test('不存在的 slug 返回 404 与 PRODUCT_NOT_FOUND', async () => {
  const { status, body } = await detail('no-such-product')
  assert.equal(status, 404)
  assert.deepEqual(body, {
    error: {
      code: 'PRODUCT_NOT_FOUND',
      message: '商品不存在。',
    },
  })
})

test('存在的商品返回 200，并带齐列表项字段', async () => {
  const { status, body } = await detail('apple-earpods')
  assert.equal(status, 200)
  assert.deepEqual(listItemFields(body), {
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
})

test('详情带齐图片、规格维度、规格组合、图文详情与商品级库存', async () => {
  const { status, body } = await detail('apple-earpods')
  assert.equal(status, 200)
  assert.deepEqual(body, {
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
    stock: 460,
    images: [
      { path: '/images/products/apple-earpods/1.webp', alt: 'Apple EarPods 包装盒与耳机俯视' },
      { path: '/images/products/apple-earpods/2.webp', alt: 'Apple EarPods 包装盒正面与耳机' },
      { path: '/images/products/apple-earpods/3.webp', alt: 'Apple EarPods 耳机与线控平铺' },
      { path: '/images/products/apple-earpods/4.webp', alt: 'Apple EarPods 开盒竖构图，线材盘绕' },
      { path: '/images/products/apple-earpods/5.webp', alt: 'Apple EarPods 耳机 3/4 特写' },
    ],
    dimensions: [
      { name: '接口', options: ['Lightning', '3.5mm'] },
      { name: '包装', options: ['盒装', '简装'] },
    ],
    variants: [
      {
        sku: 'EARPODS-LTN-BOX',
        option1Value: 'Lightning',
        option2Value: '盒装',
        priceCents: 14900,
        originalPriceCents: 17900,
        stock: 200,
      },
      {
        sku: 'EARPODS-LTN-SIMPLE',
        option1Value: 'Lightning',
        option2Value: '简装',
        priceCents: 12900,
        originalPriceCents: 14900,
        stock: 120,
      },
      {
        sku: 'EARPODS-35-BOX',
        option1Value: '3.5mm',
        option2Value: '盒装',
        priceCents: 14900,
        originalPriceCents: 17900,
        stock: 60,
      },
      {
        sku: 'EARPODS-35-SIMPLE',
        option1Value: '3.5mm',
        option2Value: '简装',
        priceCents: 12900,
        originalPriceCents: 14900,
        stock: 80,
      },
    ],
    detail: [
      { type: 'text', text: '有线入耳式耳机，线控集成麦克风与音量按键，接听与切歌不必掏出手机。' },
      {
        type: 'image',
        path: '/images/products/apple-earpods/2.webp',
        alt: 'Apple EarPods 包装盒正面与耳机',
      },
      { type: 'text', text: '提供 Lightning 与 3.5mm 两种接头，包装分盒装与简装两档。' },
    ],
  })
})

test('图片按 sort_order 升序、同序按 id 升序，封面图取第一张', async () => {
  const categorySlug = 'detail-probe-images'
  try {
    await insertDetailProbe({
      slug: categorySlug,
      categorySlug,
      images: [
        { path: `/images/products/${categorySlug}/1.webp`, sortOrder: 5, alt: '同序第一张' },
        { path: `/images/products/${categorySlug}/2.webp`, sortOrder: 5, alt: '同序第二张' },
        { path: `/images/products/${categorySlug}/3.webp`, sortOrder: 1, alt: '排序最前' },
      ],
    })

    const { status, body } = await detail(categorySlug)
    assert.equal(status, 200)
    assert.deepEqual(body.images.map((image) => image.path), [
      `/images/products/${categorySlug}/3.webp`,
      `/images/products/${categorySlug}/1.webp`,
      `/images/products/${categorySlug}/2.webp`,
    ])
    assert.deepEqual(body.coverImage, {
      path: `/images/products/${categorySlug}/3.webp`,
      alt: '排序最前',
    })
  } finally {
    await deleteDetailProbeCategory(categorySlug)
  }
})

test('规格维度保持存储顺序；规格组合按 id 升序，未提供的组合不返回', async () => {
  const { status, body } = await detail('logitech-g15')
  assert.equal(status, 200)
  assert.deepEqual(body.dimensions, [
    { name: '版本', options: ['初代', 'v2'] },
    { name: '成色', options: ['全新', '二手'] },
  ])
  assert.deepEqual(body.variants.map((variant) => variant.sku), [
    'G15-V1-NEW',
    'G15-V1-USED',
    'G15-V2-NEW',
  ])
  assert.deepEqual(body.variants[1], {
    sku: 'G15-V1-USED',
    option1Value: '初代',
    option2Value: '二手',
    priceCents: 19900,
    originalPriceCents: 29900,
    stock: 12,
  })
  assert.equal(body.stock, 23)
})

test('缺货组合仍返回且库存为 0；商品级库存等于各组合库存之和', async () => {
  const { status, body } = await detail('airpods-max')
  assert.equal(status, 200)
  assert.equal(body.soldOut, false)
  assert.equal(body.stock, 35)
  assert.deepEqual(body.variants.map((variant) => [variant.sku, variant.stock]), [
    ['APM-SG-LTN', 12],
    ['APM-SG-USBC', 8],
    ['APM-SI-LTN', 0],
    ['APM-SI-USBC', 15],
  ])
})

test('售罄商品的商品级库存为 0，展示价与展示原价仍取最低组合', async () => {
  const { status, body } = await detail('dell-e2210f')
  assert.equal(status, 200)
  assert.equal(body.soldOut, true)
  assert.equal(body.stock, 0)
  assert.equal(body.displayPriceCents, 29900)
  assert.equal(body.displayOriginalPriceCents, 39900)
  assert.equal(body.variants.length, 4)
  for (const variant of body.variants) {
    assert.equal(variant.stock, 0, `${variant.sku} 的库存应为 0`)
  }
})

test('非法 slug 格式返回 400 与 VALIDATION_FAILED，明细指向路径参数', async () => {
  const invalidSlugs = [
    'Apple-EarPods',
    'apple_earpods',
    'apple--earpods',
    '-apple-earpods',
    'a'.repeat(65),
  ]
  for (const slug of invalidSlugs) {
    const { status, body } = await detail(slug)
    assert.equal(status, 400, `${slug} 应返回 400`)
    assert.equal(body.error.code, 'VALIDATION_FAILED')
    assert.equal(body.error.details?.[0]?.path, 'params/slug')
  }
})

test('商品缺少封面图时返回 500 与 INTERNAL_ERROR，响应体不泄露内部细节', async () => {
  const categorySlug = 'detail-probe-no-cover'
  try {
    await insertDetailProbe({ slug: categorySlug, categorySlug, images: [] })

    const { status, body } = await detail(categorySlug)
    assert.equal(status, 500)
    assert.deepEqual(body, {
      error: { code: 'INTERNAL_ERROR', message: '服务内部错误。' },
    })
    assert.equal(JSON.stringify(body).includes(categorySlug), false)
  } finally {
    await deleteDetailProbeCategory(categorySlug)
  }
})
