import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import type { Client } from '@elastic/elasticsearch'
import type { ProductSearchDocument } from '../src/search/product-snapshot.ts'
import {
  assertDemoIndexStateUnchanged,
  captureDemoIndexState,
  cleanupIsolatedProductIndex,
  createTestEsClient,
  resetIsolatedProductIndex,
  type DemoIndexState,
  type IsolatedProductIndex,
} from './helpers/es-fixture.ts'
import { HIGHLIGHT_ALIAS, HIGHLIGHT_INDEX } from './helpers/es-test-env.ts'

/**
 * 高亮契约（#23）的真实 ES 验收。
 *
 * 断言落在 ES 实际返回、经端口映射后的片段上：
 * - 命中片段用固定 <em> 包裹；
 * - 原文里的 < / > 被 HTML 编码器转义成实体；
 * - 没有片段的字段不出现，整个对象也不出现。
 */

const DOC_WITH_TAGS: ProductSearchDocument = {
  productId: 101,
  slug: 'highlight-angle-brackets',
  name: 'Sony 无线<降噪>耳机',
  brand: 'Sony',
  model: 'WH-1000XM3',
  categoryName: '音频设备',
  categorySlug: 'audio',
  sales: 10,
  displayPriceCents: 399_900,
}

/** name / brand 不含「音频」；只有商品类型命中的探针。 */
const DOC_CATEGORY_ONLY: ProductSearchDocument = {
  productId: 102,
  slug: 'highlight-category-only',
  name: '纯音乐播放器',
  brand: 'Acme',
  model: 'Probe Zeta',
  categoryName: '音频设备',
  categorySlug: 'audio',
  sales: 5,
  displayPriceCents: 19_900,
}

let client: Client
let isolated: IsolatedProductIndex
let demoBefore: DemoIndexState

before(async () => {
  client = createTestEsClient()
  demoBefore = await captureDemoIndexState(client)
  isolated = await resetIsolatedProductIndex(
    client,
    HIGHLIGHT_INDEX,
    HIGHLIGHT_ALIAS,
    [DOC_WITH_TAGS, DOC_CATEGORY_ONLY],
  )
})

after(async () => {
  try {
    await cleanupIsolatedProductIndex(client, HIGHLIGHT_INDEX, HIGHLIGHT_ALIAS)
    assertDemoIndexStateUnchanged(demoBefore, await captureDemoIndexState(client))
  } finally {
    await client.close()
  }
})

test('列表高亮：命中片段含 <em>，原文尖括号被转义', async () => {
  const result = await isolated.searchAdapter.search({ keyword: '降噪', page: 1, pageSize: 10 })
  assert.deepEqual(result.productIds, [DOC_WITH_TAGS.productId])

  const fragments = result.highlights.get(DOC_WITH_TAGS.slug)?.name
  assert.ok(fragments !== undefined && fragments.length > 0, '降噪命中应在 name 上产生片段')
  const fragment = fragments.join('')
  assert.match(fragment, /<em>[^<]+<\/em>/, '命中部分必须用 <em> 包裹')
  assert.equal(fragment.includes('&lt;'), true, '原文的 < 应转义成 &lt;')
  assert.equal(fragment.includes('&gt;'), true, '原文的 > 应转义成 &gt;')
  const withoutTags = fragment.replace(/<\/?em>/g, '')
  assert.equal(
    withoutTags.includes('<') || withoutTags.includes('>'),
    false,
    '除 <em> 外不应出现真实标签',
  )
})

test('列表高亮缺省：只命中 categoryName 时不产生任何片段', async () => {
  const result = await isolated.searchAdapter.search({ keyword: '音频', page: 1, pageSize: 10 })
  assert.equal(result.total, 2, '两件商品的 categoryName 都含「音频」')
  assert.equal(result.highlights.size, 0, 'name / brand / model 没有片段时不应写高亮条目')
})

test('联想高亮：前缀命中带 <em>，只有 model 命中时条目不带 highlight', async () => {
  const matched = await isolated.searchAdapter.suggest({ prefix: 'Son', limit: 5 })
  const sony = matched.items.find((item) => item.slug === DOC_WITH_TAGS.slug)
  assert.ok(sony !== undefined, '前缀 Son 应命中 Sony 商品')
  const fragment = sony?.highlight?.name?.join('') ?? ''
  assert.match(fragment, /<em>[^<]+<\/em>/, '联想命中片段也必须用 <em> 包裹')

  const modelOnly = await isolated.searchAdapter.suggest({ prefix: 'Probe', limit: 5 })
  const acme = modelOnly.items.find((item) => item.slug === DOC_CATEGORY_ONLY.slug)
  assert.ok(acme !== undefined, '前缀 Probe 应通过 model 命中探针商品')
  assert.equal('highlight' in (acme ?? {}), false, '只有 model 命中时 name / brand 没有片段')
})
