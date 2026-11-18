import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import type { RowDataPacket } from 'mysql2'
import type { Pool } from 'mysql2/promise'
import type { AppInstance } from '../src/app.ts'
import type { ErrorBody, ListItem } from './helpers/api-types.ts'
import { FakeProductSearchAdapter } from './helpers/fake-search-adapter.ts'
import { closeSeededApp, createSeededApp } from './helpers/seeded-app.ts'

let pool: Pool
let app: AppInstance
const search = new FakeProductSearchAdapter()

before(async () => {
  ({ pool, app } = await createSeededApp({ search }))
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
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) params.set(key, String(value))
  const suffix = params.size === 0 ? '' : `?${params.toString()}`
  const response = await app.inject({ method: 'GET', url: `/api/products${suffix}` })
  return { status: response.statusCode, body: response.json() }
}

function slugsOf (body: ListBody): string[] {
  return body.items.map((item) => item.slug)
}

/** 由 slug 取商品 id：只做夹具准备，断言仍落在端口参数与 HTTP 响应上。 */
async function productIds (slugs: string[]): Promise<number[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT id, slug FROM products WHERE slug IN (?)',
    [slugs],
  )
  const bySlug = new Map(rows.map((row) => [String(row.slug), Number(row.id)]))
  return slugs.map((slug) => {
    const id = bySlug.get(slug)
    assert.ok(id !== undefined, `种子数据里应有商品 ${slug}`)
    return id
  })
}

test('关键词命中按搜索端口给出的顺序返回，展示字段由 MySQL 补齐且与 MySQL 路径一致', async () => {
  search.reset()
  // 故意选择既不按 id 升序、也不按销量或价格的顺序。
  const slugs = ['sony-wh-1000xm3', 'apple-earpods', 'dell-e2210f']
  search.hits = await productIds(slugs)

  const { status, body } = await list({ keyword: '耳机' })
  assert.equal(status, 200)
  assert.deepEqual(slugsOf(body), slugs, '列表顺序应等于搜索端口的命中顺序')
  assert.equal(body.total, 3)
  assert.equal(body.totalPages, 1)
  assert.equal(body.page, 1)
  assert.equal(body.pageSize, 8)

  // 11 个字段逐项与 MySQL 路径同 slug 的列表项比较：展示价、展示原价、售罄、评分、销量、封面图都由 MySQL 补齐。
  const baseline = await list({ pageSize: 50 })
  assert.equal(baseline.status, 200)
  const mysqlItems = new Map(baseline.body.items.map((item) => [item.slug, item]))
  for (const item of body.items) {
    const expected = mysqlItems.get(item.slug)
    assert.ok(expected !== undefined, `MySQL 路径应包含 ${item.slug}`)
    assert.deepEqual(item, expected, `${item.slug} 的列表项字段应与 MySQL 路径完全一致`)
  }

  const query = search.queries.at(-1)
  assert.ok(query !== undefined, '有关键词的请求应调用搜索端口')
  assert.equal(query.keyword, '耳机', '关键词应 trim 后传给搜索端口')
})

test('筛选条件、页码与每页数量原样传到搜索端口；未显式指定排序时 sort 为 undefined', async () => {
  search.reset()
  search.hits = await productIds(['apple-earpods'])

  await list({
    keyword: '蓝牙',
    category: 'audio',
    priceMinCents: 10000,
    priceMaxCents: 200000,
    minSales: 3000,
    page: 2,
    pageSize: 5,
  })

  const query = search.queries.at(-1)
  assert.ok(query !== undefined)
  assert.equal(query.category, 'audio')
  assert.equal(query.priceMinCents, 10000)
  assert.equal(query.priceMaxCents, 200000)
  assert.equal(query.minSales, 3000)
  assert.equal(query.page, 2)
  assert.equal(query.pageSize, 5)
  assert.equal(query.sort, undefined, '未显式指定排序时不能兜底成 sales_desc')

  // 未提供的筛选条件不伪造值：端口收到 undefined，表示「不限」。
  search.reset()
  await list({ keyword: '蓝牙' })
  const bare = search.queries.at(-1)
  assert.ok(bare !== undefined)
  assert.deepEqual(
    [bare.category, bare.priceMinCents, bare.priceMaxCents, bare.minSales],
    [undefined, undefined, undefined, undefined],
  )

  for (const sort of ['price_asc', 'price_desc', 'sales_desc']) {
    search.reset()
    await list({ keyword: '蓝牙', sort })
    const sorted = search.queries.at(-1)
    assert.ok(sorted !== undefined)
    assert.equal(sorted.sort, sort, `显式排序 ${sort} 应原样传给搜索端口`)
  }
})

test('分页与总数映射：total 取搜索总数，totalPages 按其与每页数量计算', async () => {
  search.reset()
  const slugs = [
    'apple-earpods',
    'sony-wh-1000xm3',
    'sony-wh-ch500',
    'apple-watch-series-8',
    'airpods-max',
    'keychron-k8',
    'huawei-watch',
  ]
  search.hits = await productIds(slugs)

  const first = await list({ keyword: '耳机', pageSize: 3 })
  assert.equal(first.status, 200)
  assert.equal(first.body.total, 7)
  assert.equal(first.body.totalPages, 3)
  assert.deepEqual(slugsOf(first.body), slugs.slice(0, 3))

  const third = await list({ keyword: '耳机', page: 3, pageSize: 3 })
  assert.equal(third.status, 200)
  assert.equal(third.body.page, 3)
  assert.equal(third.body.total, 7)
  assert.equal(third.body.totalPages, 3)
  assert.deepEqual(slugsOf(third.body), slugs.slice(6))

  const beyond = await list({ keyword: '耳机', page: 4, pageSize: 3 })
  assert.equal(beyond.status, 200)
  assert.equal(beyond.body.page, 4)
  assert.equal(beyond.body.total, 7)
  assert.equal(beyond.body.totalPages, 3)
  assert.deepEqual(beyond.body.items, [])

  // 空结果：假实现没有命中，total 与 totalPages 都应为 0。
  search.reset()
  const empty = await list({ keyword: '查无此物' })
  assert.equal(empty.status, 200)
  assert.equal(empty.body.total, 0)
  assert.equal(empty.body.totalPages, 0)
  assert.deepEqual(empty.body.items, [])
})

test('搜索端口不可用返回 503 与 SEARCH_NOT_AVAILABLE，无关键词的普通浏览不受影响', async () => {
  search.reset()
  search.failUnavailable()

  const broken = await list({ keyword: '耳机' })
  assert.equal(broken.status, 503)
  assert.equal(broken.body.error.code, 'SEARCH_NOT_AVAILABLE')
  assert.equal(typeof broken.body.error.message, 'string')

  const browse = await list()
  assert.equal(browse.status, 200, '搜索不可用时普通浏览必须照常返回')
  assert.equal(browse.body.total, 16)
  assert.equal(search.queries.length, 1, '普通浏览不应调用搜索端口')

  search.reset()
})

test('搜索端口的非可用性异常走 500，不被误映射为 503', async () => {
  search.reset()
  search.failure = new Error('模拟的程序错误')

  const { status, body } = await list({ keyword: '耳机' })
  assert.equal(status, 500)
  assert.deepEqual(body, { error: { code: 'INTERNAL_ERROR', message: '服务内部错误。' } })

  search.reset()
})

interface ListItemHighlight {
  name?: string[]
  brand?: string[]
  model?: string[]
}

interface HighlightedListItem extends ListItem {
  highlight?: ListItemHighlight
}

test('列表项带命中高亮：按 slug 合并回同一条目，命中顺序不变，片段原样透传', async () => {
  search.reset()
  // 命中顺序仍由搜索端口决定，高亮只是附加信息。
  const slugs = ['sony-wh-1000xm3', 'apple-earpods', 'dell-e2210f']
  search.hits = await productIds(slugs)
  search.highlights = new Map([
    ['sony-wh-1000xm3', {
      name: ['Sony WH-1000XM3 无线<em>降</em><em>噪</em>头戴耳机', '头戴式<em>降噪</em>耳机'],
      brand: ['<em>Sony</em>'],
    }],
    // 只有型号命中的条目：name / brand 必须缺省，而不是空数组。
    ['dell-e2210f', { model: ['Dell <em>E2210f</em> 22 英寸液晶显示器'] }],
  ])

  const { status, body } = await list({ keyword: '降噪' })
  assert.equal(status, 200)
  assert.deepEqual(slugsOf(body), slugs, '高亮不得改变搜索端口给出的命中顺序')

  const items = body.items as HighlightedListItem[]

  // 字段结构：命中的字段按端口给出的片段数组原样透传（含多个片段的顺序）。
  assert.deepEqual(items[0]?.highlight, {
    name: ['Sony WH-1000XM3 无线<em>降</em><em>噪</em>头戴耳机', '头戴式<em>降噪</em>耳机'],
    brand: ['<em>Sony</em>'],
  })
  // 没有命中片段的条目：整个字段不出现（不是空对象）。
  assert.equal('highlight' in (items[1] ?? {}), false, '无命中片段的条目不应带 highlight 字段')
  // 字段级缺省：只有 model 命中时 name / brand 不出现（不是空数组）。
  assert.deepEqual(Object.keys(items[2]?.highlight ?? {}), ['model'])
  assert.deepEqual(items[2]?.highlight?.model, ['Dell <em>E2210f</em> 22 英寸液晶显示器'])

  // 转义由 ES 完成，路由不得二次转义或改写片段。
  assert.equal(
    items[0]?.highlight?.brand?.[0],
    '<em>Sony</em>',
    '片段应逐字节透传，路由不做二次转义',
  )

  // 展示字段仍由 MySQL 补齐：除 highlight 外与 MySQL 路径逐字段一致。
  const baseline = await list({ pageSize: 50 })
  assert.equal(baseline.status, 200)
  const mysqlItems = new Map(baseline.body.items.map((item) => [item.slug, item]))
  for (const item of items) {
    const { highlight: _highlight, ...rest } = item
    const expected = mysqlItems.get(item.slug)
    assert.ok(expected !== undefined, `MySQL 路径应包含 ${item.slug}`)
    assert.deepEqual(rest, expected, `${item.slug} 的展示字段应与 MySQL 路径完全一致`)
  }

  search.reset()
})

test('关键词 trim 后为空不调用搜索端口，关键请求参数校验先于搜索调用', async () => {
  search.reset()

  for (const keyword of ['', '   ']) {
    const { status, body } = await list({ keyword })
    assert.equal(status, 200, `关键词 ${JSON.stringify(keyword)} 应按无关键词处理`)
    assert.equal(body.total, 16)
  }
  assert.equal(search.queries.length, 0, '空关键词不应调用搜索端口')

  const overlong = await list({ keyword: `  ${'a'.repeat(101)}  ` })
  assert.equal(overlong.status, 400)
  assert.equal(overlong.body.error.code, 'VALIDATION_FAILED')
  assert.equal(overlong.body.error.details?.[0]?.path, 'querystring/keyword')

  const crossField = await list({ keyword: '蓝牙', priceMinCents: 20000, priceMaxCents: 19999 })
  assert.equal(crossField.status, 400, '可修正的请求校验应排在搜索调用之前')
  assert.equal(search.queries.length, 0, '校验失败的请求不应调用搜索端口')
})
