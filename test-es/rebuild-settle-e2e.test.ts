import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import type { Client } from '@elastic/elasticsearch'
import { ElasticsearchProductIndexAdapter } from '../src/search/elasticsearch-adapter.ts'
import { settleAliasExclusiveTarget } from '../src/search/index-rebuild.ts'
import {
  assertDemoIndexStateUnchanged,
  captureDemoIndexState,
  createTestEsClient,
  type DemoIndexState,
} from './helpers/es-fixture.ts'

/**
 * 第四轮复审（真实 ES）：直接用真实适配器验证「静默 + 复查 + 收敛」。
 *
 * 人为让测试别名同时指向两个隔离索引，调用 settleAliasExclusiveTarget 后
 * 断言只剩指定目标；收敛只改别名、不删除索引。收尾清空测试别名与两个隔离索引，
 * 并核对演示别名 products 与 products_vN 集合前后一致。
 */

const INDEX_PREFIX = 'products_es_test_settle_v'
const ALIAS = 'products_es_test_settle_alias'
const KEEP_INDEX = INDEX_PREFIX + '2'
const DROP_INDEX = INDEX_PREFIX + '1'

let client: Client
let adapter: ElasticsearchProductIndexAdapter
let demoBefore: DemoIndexState

async function cleanup (): Promise<void> {
  const targets = await adapter.aliasIndices(ALIAS)
  if (targets.length > 0) await adapter.updateAlias(ALIAS, [], targets)
  await adapter.deleteIndex(DROP_INDEX)
  await adapter.deleteIndex(KEEP_INDEX)
  assert.deepEqual(await adapter.aliasIndices(ALIAS), [], '测试别名应已清空')
}

before(async () => {
  client = createTestEsClient()
  adapter = new ElasticsearchProductIndexAdapter(client, { indexPrefix: INDEX_PREFIX })
  demoBefore = await captureDemoIndexState(client)
  await cleanup()
})

after(async () => {
  try {
    await cleanup()
    assertDemoIndexStateUnchanged(demoBefore, await captureDemoIndexState(client))
  } finally {
    await client.close()
  }
})


test('真实适配器：静默 + 复查 + 收敛把双目标别名收敛为唯一目标，演示别名不受影响', async () => {
  await adapter.createIndex(DROP_INDEX)
  await adapter.createIndex(KEEP_INDEX)
  await adapter.updateAlias(ALIAS, [DROP_INDEX, KEEP_INDEX], [])
  assert.deepEqual(
    (await adapter.aliasIndices(ALIAS)).sort(),
    [DROP_INDEX, KEEP_INDEX],
    '前置：别名必须同时指向两个隔离索引',
  )

  const result = await settleAliasExclusiveTarget(adapter, {
    alias: ALIAS,
    indexPrefix: INDEX_PREFIX,
    expectedIndex: KEEP_INDEX,
    settleMs: 50,
    maxRounds: 3,
  })

  assert.equal(result.target, KEEP_INDEX)
  assert.deepEqual(await adapter.aliasIndices(ALIAS), [KEEP_INDEX], '收敛后别名必须恰好一个目标')
  assert.deepEqual(result.removed, [DROP_INDEX])
  assert.equal(
    await client.indices.exists({ index: DROP_INDEX }),
    true,
    '收敛只改别名，不删除任何索引',
  )
  assert.deepEqual(await adapter.aliasIndices('products'), demoBefore.aliasTargets, '演示别名 products 不受影响')
  assertDemoIndexStateUnchanged(demoBefore, await captureDemoIndexState(client))
})
