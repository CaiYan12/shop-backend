import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import type { Pool } from 'mysql2/promise'
import { createApp, type AppInstance } from '../src/app.ts'
import { createDb, createPool } from '../src/db/client.ts'
import type { ErrorBody } from './helpers/api-types.ts'
import { FakeProductSearchAdapter } from './helpers/fake-search-adapter.ts'
import { loadTestConfig } from './helpers/test-config.ts'

/**
 * 商品联想接口（#22）的默认套件：注入记录型假搜索端口，因此不依赖 Elasticsearch。
 * 断言只落在 HTTP 响应与端口入参 / 出参上（前缀、条数、顺序、降级），不测内部查询 DSL。
 */

interface SuggestionItem {
  slug: string
  name: string
  brand: string
}

interface SuggestionsBody {
  items: SuggestionItem[]
}

const config = loadTestConfig()
const search = new FakeProductSearchAdapter()

let pool: Pool
let app: AppInstance

before(async () => {
  pool = createPool(config)
  app = await createApp({ db: createDb(pool), config, search })
  await app.ready()
})

after(async () => {
  await app.close()
  await pool.end()
})

async function suggest (query: Record<string, string | number> = {}): Promise<{
  status: number
  body: SuggestionsBody & ErrorBody
}> {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) params.set(key, String(value))
  const suffix = params.size === 0 ? '' : `?${params.toString()}`
  const response = await app.inject({ method: 'GET', url: `/api/products/suggestions${suffix}` })
  return { status: response.statusCode, body: response.json() }
}

/** 固定候选：顺序故意既不按 slug 也不按商品 id 排，用来观察端口顺序是否被原样透传。 */
const ITEMS: SuggestionItem[] = [
  { slug: 'sony-wh-1000xm3', name: 'Sony WH-1000XM3 无线降噪头戴耳机', brand: 'Sony' },
  { slug: 'apple-airpods-max', name: 'Apple AirPods Max 头戴式降噪耳机', brand: 'Apple' },
  { slug: 'dell-e2210f', name: 'Dell E2210f 22 英寸液晶显示器', brand: 'Dell' },
  { slug: 'keychron-k8', name: 'Keychron K8 无线机械键盘（87 键 TKL）', brand: 'Keychron' },
  { slug: 'huawei-watch', name: 'Huawei Watch 智能手表（第一代）', brand: 'Huawei' },
]

test('有效请求返回 200 与 { items }：q 先 trim 再传到端口，limit 缺省为 5', async () => {
  search.reset()
  search.items = ITEMS.slice(0, 2)

  const { status, body } = await suggest({ q: '  AirPods  ' })
  assert.equal(status, 200)
  assert.deepEqual(body, { items: search.items }, '响应应只有 items，字段与端口给出的条目逐项一致')

  const query = search.suggestionQueries.at(-1)
  assert.ok(query !== undefined, '有效请求应调用搜索端口')
  assert.equal(query.prefix, 'AirPods', 'q 应 trim 后传给搜索端口')
  assert.equal(query.limit, 5, '未提供 limit 时缺省为 5')

  search.reset()
  search.items = ITEMS.slice(0, 1)
  await suggest({ q: 'Apple', limit: 3 })
  const explicit = search.suggestionQueries.at(-1)
  assert.ok(explicit !== undefined)
  assert.equal(explicit.limit, 3, '显式 limit 应原样传给搜索端口')
})

test('q 缺失、trim 后为空、trim 后超过 100 字符都返回 400，明细指向 querystring/q', async () => {
  search.reset()
  const cases: Array<[string, Record<string, string | number>]> = [
    ['缺少 q', {}],
    ['空白 q', { q: '   ' }],
    ['超长 q', { q: `  ${'a'.repeat(101)}  ` }],
  ]

  for (const [label, query] of cases) {
    const { status, body } = await suggest(query)
    assert.equal(status, 400, `${label} 应返回 400`)
    assert.equal(body.error.code, 'VALIDATION_FAILED', label)
    assert.equal(body.error.details?.[0]?.path, 'querystring/q', `${label} 的明细应指向 q`)
  }

  assert.equal(search.suggestionQueries.length, 0, '参数校验失败的请求不应调用搜索端口')
})

test('limit 必须是 1–10 的整数：越界与非整数返回 400，明细指向 querystring/limit', async () => {
  search.reset()
  for (const limit of [0, 11, -1, 2.5, 'abc']) {
    const { status, body } = await suggest({ q: 'AirPods', limit })
    assert.equal(status, 400, `limit=${String(limit)} 应返回 400`)
    assert.equal(body.error.code, 'VALIDATION_FAILED')
    assert.equal(body.error.details?.[0]?.path, 'querystring/limit', `limit=${String(limit)} 的明细应指向 limit`)
  }
  assert.equal(search.suggestionQueries.length, 0, '参数校验失败的请求不应调用搜索端口')
})

test('搜索端口不可用返回 503 与 SEARCH_NOT_AVAILABLE', async () => {
  search.reset()
  search.failUnavailable()

  const { status, body } = await suggest({ q: '耳机' })
  assert.equal(status, 503)
  assert.equal(body.error.code, 'SEARCH_NOT_AVAILABLE')
  assert.equal(typeof body.error.message, 'string')

  search.reset()
})

test('参数校验先于搜索可用性判断：两者同时不满足时报 400，且不调用搜索端口', async () => {
  search.reset()
  search.failUnavailable()

  const missing = await suggest({ limit: 99 })
  assert.equal(missing.status, 400, '缺少 q 时应先报可修正的 400，而不是 503')
  assert.equal(missing.body.error.code, 'VALIDATION_FAILED')
  assert.equal(missing.body.error.details?.[0]?.path, 'querystring/q')

  const badLimit = await suggest({ q: '   ', limit: 0 })
  assert.equal(badLimit.status, 400)
  assert.equal(search.suggestionQueries.length, 0, '校验失败时不应触碰不可用的搜索端口')

  search.reset()
})

test('响应条数不超过 limit：顺序与端口一致，条目只含 slug / name / brand', async () => {
  search.reset()
  search.items = ITEMS

  const { status, body } = await suggest({ q: '耳机', limit: 3 })
  assert.equal(status, 200)
  assert.deepEqual(
    body.items.map((item) => item.slug),
    ITEMS.slice(0, 3).map((item) => item.slug),
    '联想条目顺序应原样透传端口结果',
  )
  for (const item of body.items) {
    assert.deepEqual(Object.keys(item).sort(), ['brand', 'name', 'slug'], '本票不做高亮，条目只有三个字段')
  }
})
