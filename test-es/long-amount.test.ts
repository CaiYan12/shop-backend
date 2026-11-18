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
import { LONG_AMOUNT_ALIAS, LONG_AMOUNT_INDEX } from './helpers/es-test-env.ts'

/**
 * V20 · 超 32 位金额（#25）。
 *
 * `displayPriceCents` 映射为 `long`（上限 9,999,999,999 分），但 `integer` 的最大值是
 * 2,147,483,647。这里在隔离索引里写入 9,999,999,999 分的文档，验证：
 * 1. 导入后原值精确保留（不是被截断/溢出的整数）；
 * 2. 按价格区间 `gte: 2,147,483,648` 能命中；
 * 3. 对照：`lte: 2,147,483,647` 不命中，证明区间比较确实按 long 生效。
 * 跑完删除隔离索引与别名，演示别名 products 前后不变。
 */

/** 超过 32 位有符号整数上限（2,147,483,647）的金额，取价格字段契约上限 9,999,999,999。 */
const OVER_32_BIT_CENTS = 9_999_999_999

/** 只在隔离索引里存在的 productId；一致性矩阵的 16 件商品不受影响。 */
const PROBE_PRODUCT_ID = 999_999

const PROBE_DOCUMENT: ProductSearchDocument = {
  productId: PROBE_PRODUCT_ID,
  slug: 'probe-over-32bit-amount',
  name: '超32位金额测试商品',
  brand: 'Probe',
  model: 'P-32',
  categoryName: '测试类型',
  categorySlug: 'probe',
  sales: 0,
  displayPriceCents: OVER_32_BIT_CENTS,
}

let client: Client
let isolated: IsolatedProductIndex
let demoBefore: DemoIndexState

before(async () => {
  client = createTestEsClient()
  demoBefore = await captureDemoIndexState(client)
  isolated = await resetIsolatedProductIndex(client, LONG_AMOUNT_INDEX, LONG_AMOUNT_ALIAS, [PROBE_DOCUMENT])
})

after(async () => {
  try {
    await cleanupIsolatedProductIndex(client, LONG_AMOUNT_INDEX, LONG_AMOUNT_ALIAS)
    assertDemoIndexStateUnchanged(demoBefore, await captureDemoIndexState(client))
  } finally {
    await client.close()
  }
})

test('V20：超 32 位金额可导入且原值精确保留', async () => {
  const stored = await isolated.indexAdapter.getDocuments(LONG_AMOUNT_INDEX, [PROBE_DOCUMENT.slug])
  assert.deepEqual(
    stored.get(PROBE_DOCUMENT.slug),
    PROBE_DOCUMENT,
    `${OVER_32_BIT_CENTS} 分应原值写入并读回`,
  )
})

test('V20：价格区间 gte 2,147,483,648 能命中超 32 位金额文档', async () => {
  const result = await isolated.searchAdapter.search({
    keyword: '金额',
    priceMinCents: 2_147_483_648,
    page: 1,
    pageSize: 10,
  })
  assert.equal(result.total, 1, '超 32 位金额应被价格下限命中')
  assert.deepEqual(result.productIds, [PROBE_PRODUCT_ID])
})

test('V20 对照：不设价格区间能命中，lte 2,147,483,647 不命中', async () => {
  const unfiltered = await isolated.searchAdapter.search({
    keyword: '金额',
    page: 1,
    pageSize: 10,
  })
  assert.equal(unfiltered.total, 1, '不设价格区间时文档应可见')

  const belowBoundary = await isolated.searchAdapter.search({
    keyword: '金额',
    priceMaxCents: 2_147_483_647,
    page: 1,
    pageSize: 10,
  })
  assert.equal(belowBoundary.total, 0, '32 位上限以下的价格区间不应命中超限金额')
})
