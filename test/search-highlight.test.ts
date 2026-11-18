import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import type { RowDataPacket } from 'mysql2'
import type { Pool } from 'mysql2/promise'
import type { AppInstance } from '../src/app.ts'
import type { ListItem } from './helpers/api-types.ts'
import { FakeProductSearchAdapter } from './helpers/fake-search-adapter.ts'
import { closeSeededApp, createSeededApp } from './helpers/seeded-app.ts'

/**
 * 命中高亮（#23）的 HTTP 契约。
 *
 * 只断言调用方可见的结果：列表与联想的响应里，高亮按 slug 合并回条目、
 * 有片段才出现字段、无片段时整个字段缺省。适配器内部的请求参数与假 ES
 * 响应映射属于实现细节，不在这里断言；真实 ES 的高亮行为见
 * test-es/search-highlight.test.ts。
 */

interface ListItemHighlight {
  name?: string[]
  brand?: string[]
  model?: string[]
}

interface HighlightedListItem extends ListItem {
  highlight?: ListItemHighlight
}

interface ListBody {
  page: number
  pageSize: number
  total: number
  totalPages: number
  items: HighlightedListItem[]
}

interface SuggestionItem {
  slug: string
  name: string
  brand: string
  highlight?: { name?: string[], brand?: string[] }
}

interface SuggestionsBody {
  items: SuggestionItem[]
}

let pool: Pool
let app: AppInstance
const search = new FakeProductSearchAdapter()

before(async () => {
  ({ pool, app } = await createSeededApp({ search }))
})

after(async () => {
  await closeSeededApp({ pool, app })
})

function toQuery (params: Record<string, string | number>): string {
  const searchParams = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) searchParams.set(key, String(value))
  return searchParams.size === 0 ? '' : `?${searchParams.toString()}`
}

async function list (params: Record<string, string | number> = {}): Promise<{ status: number, body: ListBody }> {
  const response = await app.inject({ method: 'GET', url: `/api/products${toQuery(params)}` })
  return { status: response.statusCode, body: response.json() as ListBody }
}

async function suggest (params: Record<string, string | number> = {}): Promise<{ status: number, body: SuggestionsBody }> {
  const response = await app.inject({ method: 'GET', url: `/api/products/suggestions${toQuery(params)}` })
  return { status: response.statusCode, body: response.json() as SuggestionsBody }
}

/** 由 slug 取商品 id：只做夹具准备，断言仍落在 HTTP 响应上。 */
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

test('关键词搜索的 HTTP 响应：高亮按 slug 合并回条目，无片段时字段缺省', async () => {
  search.reset()
  const slugs = ['sony-wh-1000xm3', 'apple-earpods', 'dell-e2210f']
  search.hits = await productIds(slugs)
  search.highlights = new Map([
    ['sony-wh-1000xm3', {
      name: ['Sony WH-1000XM3 无线<em>降</em><em>噪</em>头戴耳机'],
      brand: ['<em>Sony</em>'],
    }],
    ['dell-e2210f', { model: ['Dell <em>E2210f</em> 22 英寸液晶显示器'] }],
  ])

  const { status, body } = await list({ keyword: '降噪' })
  assert.equal(status, 200)
  assert.deepEqual(body.items.map((item) => item.slug), slugs, '高亮不得改变命中顺序')

  assert.deepEqual(body.items[0]?.highlight, {
    name: ['Sony WH-1000XM3 无线<em>降</em><em>噪</em>头戴耳机'],
    brand: ['<em>Sony</em>'],
  }, '命中片段按字段原样出现在 HTTP 响应里')
  assert.equal('highlight' in (body.items[1] ?? {}), false, '无命中片段的条目不出现 highlight')
  assert.deepEqual(
    Object.keys(body.items[2]?.highlight ?? {}),
    ['model'],
    '未命中的字段不出现，不是空数组',
  )

  search.reset()
})

test('商品联想的 HTTP 响应：有片段才带 highlight，无片段不补空对象', async () => {
  search.reset()
  search.items = [
    {
      slug: 'sony-wh-1000xm3',
      name: 'Sony WH-1000XM3 无线降噪头戴耳机',
      brand: 'Sony',
      highlight: {
        name: ['Sony WH-1000XM3 无线<em>降噪</em>头戴耳机'],
        brand: ['<em>Sony</em>'],
      },
    },
    {
      slug: 'apple-airpods-max',
      name: 'Apple AirPods Max 头戴式降噪耳机',
      brand: 'Apple',
    },
  ]

  const { status, body } = await suggest({ q: '降噪' })
  assert.equal(status, 200)
  assert.deepEqual(body.items[0]?.highlight, {
    name: ['Sony WH-1000XM3 无线<em>降噪</em>头戴耳机'],
    brand: ['<em>Sony</em>'],
  })
  assert.equal('highlight' in (body.items[1] ?? {}), false, '无命中片段时不补空 highlight')
  assert.deepEqual(
    Object.keys(body.items[0] ?? {}).sort(),
    ['brand', 'highlight', 'name', 'slug'],
    '有片段时条目只多出一个 highlight 字段',
  )

  search.reset()
})
