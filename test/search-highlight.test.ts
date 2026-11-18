import test from 'node:test'
import assert from 'node:assert/strict'
import type { Client } from '@elastic/elasticsearch'
import type {
  SearchHit,
  SearchRequest,
  SearchResponse,
} from '@elastic/elasticsearch/lib/api/types'
import { ElasticsearchProductSearchAdapter } from '../src/search/elasticsearch-adapter.ts'

/**
 * 高亮的适配器契约（#23）。
 *
 * 断言落在这个适配器对外的两边：交给 ES 客户端的 SearchRequest 里的 highlight 配置，
 * 以及把 ES 响应里的 highlight 映射成端口结果。不测查询 DSL 的字符串拼接，
 * 也不依赖 Elasticsearch 在线——客户端由本文件注入假实现。
 */

interface FakeClient {
  client: Client
  requests: SearchRequest[]
}

function fakeClient (respond: (request: SearchRequest) => unknown): FakeClient {
  const requests: SearchRequest[] = []
  const search = async (request: SearchRequest): Promise<unknown> => {
    requests.push(request)
    return respond(request)
  }
  return { client: { search } as unknown as Client, requests }
}

function listResponse (
  hits: Array<{ id: string, productId: number, slug: string, highlight?: Record<string, string[]> }>,
): SearchResponse {
  return {
    took: 1,
    timed_out: false,
    _shards: { total: 1, successful: 1, skipped: 0, failed: 0 },
    hits: {
      total: { value: hits.length, relation: 'eq' },
      max_score: 1,
      hits: hits.map((hit) => ({
        _index: 'products_v1',
        _id: hit.id,
        _score: 1,
        _source: { productId: hit.productId, slug: hit.slug },
        ...(hit.highlight === undefined ? {} : { highlight: hit.highlight }),
      } as SearchHit)),
    },
  } as unknown as SearchResponse
}

const HIGHLIGHT_FIELDS = ['brand', 'model', 'name']

/** ES 的 `fields` 允许数组写法；本适配器只写对象写法，测试按对象读取。 */
type HighlightFields = Record<string, { number_of_fragments?: number, matched_fields?: string[] }>

function highlightFields (highlight: NonNullable<SearchRequest['highlight']>): HighlightFields {
  return (highlight.fields ?? {}) as HighlightFields
}

test('列表搜索请求显式设置 html 编码与固定 em 标签，并覆盖 name / brand / model 三个字段', async () => {
  const { client, requests } = fakeClient(() => listResponse([]))
  const adapter = new ElasticsearchProductSearchAdapter(client)

  await adapter.search({ keyword: '降噪', page: 1, pageSize: 8 })

  const [request] = requests
  assert.ok(request !== undefined, '列表搜索应发出一次 ES 请求')

  const highlight = request.highlight
  assert.ok(highlight !== undefined, '列表搜索必须声明 highlight')
  // encoder: 'html' 是「先转义原文再插入标签」的开关；缺了它，原文里的 HTML 会被当成标签带进响应。
  assert.equal(highlight.encoder, 'html', '必须显式使用 html 编码器')
  assert.deepEqual(highlight.pre_tags, ['<em>'], '命中片段只用固定 <em> 开标签')
  assert.deepEqual(highlight.post_tags, ['</em>'], '命中片段只用固定 </em> 闭标签')

  const fields = highlightFields(highlight)
  assert.deepEqual(Object.keys(fields).sort(), HIGHLIGHT_FIELDS, '列表高亮覆盖 name / brand / model')
  for (const field of HIGHLIGHT_FIELDS) {
    assert.equal(
      fields[field]?.number_of_fragments,
      0,
      field + ' 应返回整字段片段，前端据此替换原字段而不是拼接摘要',
    )
  }

  // 合并键是 slug：命中文档的 _source 必须带回 slug。
  assert.deepEqual([...(request._source as string[])].sort(), ['productId', 'slug'])
})

test('列表响应的高亮按 slug 映射成端口结果：空数组字段被丢弃，无片段时不产生条目', async () => {
  const { client } = fakeClient(() => listResponse([
    {
      id: 'sony-wh-1000xm3',
      productId: 3,
      slug: 'sony-wh-1000xm3',
      highlight: {
        name: ['Sony WH-1000XM3 无线<em>降</em><em>噪</em>头戴耳机'],
        brand: ['<em>Sony</em>'],
        model: [],
      },
    },
    { id: 'dell-e2210f', productId: 4, slug: 'dell-e2210f', highlight: { model: ['<em>E2210f</em>'] } },
    { id: 'apple-earpods', productId: 5, slug: 'apple-earpods' },
  ]))
  const adapter = new ElasticsearchProductSearchAdapter(client)

  const result = await adapter.search({ keyword: '降噪', page: 1, pageSize: 8 })

  assert.deepEqual(result.productIds, [3, 4, 5], '命中顺序与总数不受高亮影响')
  assert.equal(result.total, 3)
  assert.deepEqual([...result.highlights.entries()], [
    ['sony-wh-1000xm3', {
      name: ['Sony WH-1000XM3 无线<em>降</em><em>噪</em>头戴耳机'],
      brand: ['<em>Sony</em>'],
    }],
    ['dell-e2210f', { model: ['<em>E2210f</em>'] }],
  ], '空数组字段不出现；没有片段的命中不进入映射')
})

test('联想请求的 highlight 只覆盖 name / brand，并用 matched_fields 指向 ._index_prefix 才能标出前缀', async () => {
  const { client, requests } = fakeClient(() => listResponse([]) as unknown as SearchResponse)
  const adapter = new ElasticsearchProductSearchAdapter(client)

  await adapter.suggest({ prefix: 'AirP', limit: 5 })

  const [request] = requests
  assert.ok(request !== undefined, '联想应发出一次 ES 请求')

  const highlight = request.highlight
  assert.ok(highlight !== undefined, '联想必须声明 highlight')
  assert.equal(highlight.encoder, 'html')
  assert.deepEqual(highlight.pre_tags, ['<em>'])
  assert.deepEqual(highlight.post_tags, ['</em>'])

  const fields = highlightFields(highlight)
  assert.deepEqual(Object.keys(fields).sort(), ['brand', 'name'], '联想高亮只覆盖 name / brand')
  for (const field of ['name', 'brand']) {
    assert.deepEqual(
      fields[field]?.matched_fields,
      [field, field + '._index_prefix'],
      field + ' 的 matched_fields 必须包含自身的 ._index_prefix 子字段',
    )
  }
})

test('联想响应的 highlight 映射到条目：有片段才带字段，无片段不补齐', async () => {
  const { client } = fakeClient(() => ({
    hits: {
      total: { value: 2, relation: 'eq' },
      hits: [
        {
          _index: 'products_v1',
          _id: 'apple-airpods-max',
          _score: 1,
          _source: { slug: 'apple-airpods-max', name: 'Apple AirPods Max 头戴式降噪耳机', brand: 'Apple' },
          highlight: {
            name: ['Apple <em>AirPods</em> Max 头戴式降噪耳机'],
            brand: ['<em>Apple</em>'],
          },
        },
        {
          _index: 'products_v1',
          _id: 'sony-wh-1000xm3',
          _score: 1,
          _source: { slug: 'sony-wh-1000xm3', name: 'Sony WH-1000XM3 无线降噪头戴耳机', brand: 'Sony' },
        },
      ],
    },
  } as unknown as SearchResponse))
  const adapter = new ElasticsearchProductSearchAdapter(client)

  const result = await adapter.suggest({ prefix: 'AirP', limit: 5 })

  assert.deepEqual(result.items[0], {
    slug: 'apple-airpods-max',
    name: 'Apple AirPods Max 头戴式降噪耳机',
    brand: 'Apple',
    highlight: {
      name: ['Apple <em>AirPods</em> Max 头戴式降噪耳机'],
      brand: ['<em>Apple</em>'],
    },
  })
  assert.equal('highlight' in (result.items[1] ?? {}), false, '无片段时不应出现 highlight 字段')
})
