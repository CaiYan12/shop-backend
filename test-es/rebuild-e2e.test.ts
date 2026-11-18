import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Client } from '@elastic/elasticsearch'
import { rebuildProductIndex } from '../src/search/index-rebuild.ts'
import { ElasticsearchProductIndexAdapter } from '../src/search/elasticsearch-adapter.ts'
import { loadProductSnapshot, type ProductSearchDocument } from '../src/search/product-snapshot.ts'
import { closeSeededApp, createSeededApp, type SeededApp } from '../test/helpers/seeded-app.ts'
import {
  assertDemoIndexStateUnchanged,
  captureDemoIndexState,
  createTestEsClient,
  type DemoIndexState,
} from './helpers/es-fixture.ts'
import { freePort } from '../test/helpers/free-port.ts'
import {
  DEMO_ALIAS,
  TEST_REBUILD_ALIAS,
  TEST_REBUILD_PREFIX,
} from './helpers/es-test-env.ts'

/**
 * 重建端到端（#25）：在隔离前缀下跑完整重建。
 *
 * 覆盖「建索引 → bulk → refresh → 全量校验 → 切别名 → 校验别名 → 冒烟 → 删旧」，
 * 并核对演示别名 products 与 products_vN 索引集合前后不变。
 */

/** 测试专用互斥端口与身份记录：不占用仓库默认的 19201 与 .run 记录。 */
const LOCK_PORT = await freePort()
const LOCK_OWNER_PATH = join(tmpdir(), 'shop-es-rebuild-e2e-owner-' + String(process.pid) + '.json')

async function rebuildIndices (client: Client): Promise<string[]> {
  try {
    const response = await client.indices.get({
      index: `${TEST_REBUILD_PREFIX}*`,
      allow_no_indices: true,
      expand_wildcards: 'open',
    })
    return Object.keys(response).sort()
  } catch (error) {
    const status = (error as { meta?: { statusCode?: unknown } }).meta?.statusCode
    if (status === 404) return []
    throw error
  }
}

/** 清理本轮隔离命名空间；只允许删除带测试前缀的索引。 */
async function cleanupRebuildNamespace (client: Client): Promise<void> {
  const adapter = new ElasticsearchProductIndexAdapter(client, { indexPrefix: TEST_REBUILD_PREFIX })
  const aliases = await adapter.aliasIndices(TEST_REBUILD_ALIAS)
  if (aliases.length > 0) {
    await adapter.updateAlias(TEST_REBUILD_ALIAS, [], aliases)
  }
  for (const index of await rebuildIndices(client)) {
    assert.equal(index.startsWith(TEST_REBUILD_PREFIX), true, `清理范围只能是隔离前缀：${index}`)
    await adapter.deleteIndex(index)
  }
  assert.deepEqual(await rebuildIndices(client), [], '隔离前缀下不应残留索引')
  assert.deepEqual(await adapter.aliasIndices(TEST_REBUILD_ALIAS), [], '测试别名应已清空')
}

let client: Client
let seeded: SeededApp
let demoBefore: DemoIndexState
let documents: ProductSearchDocument[]

before(async () => {
  client = createTestEsClient()
  seeded = await createSeededApp()
  documents = await loadProductSnapshot(seeded.db)
  demoBefore = await captureDemoIndexState(client)
  await cleanupRebuildNamespace(client)
})

after(async () => {
  try {
    await cleanupRebuildNamespace(client)
    assertDemoIndexStateUnchanged(demoBefore, await captureDemoIndexState(client))
  } finally {
    await closeSeededApp(seeded)
    await client.close()
  }
})

test('完整重建：隔离前缀下建索引、切别名、冒烟、删旧，演示别名不被触碰', async () => {
  const adapter = new ElasticsearchProductIndexAdapter(client, { indexPrefix: TEST_REBUILD_PREFIX })
  const options = {
    alias: TEST_REBUILD_ALIAS,
    indexPrefix: TEST_REBUILD_PREFIX,
    loadSnapshot: async () => documents,
    lockPort: LOCK_PORT,
    ownerPath: LOCK_OWNER_PATH,
    // 端到端不等待默认 5 s 静默窗口；静默收敛由专用用例与假适配器覆盖。
    settleMs: 0,
  }

  const first = await rebuildProductIndex(adapter, options)
  assert.equal(first.index, `${TEST_REBUILD_PREFIX}1`)
  assert.equal(first.documentCount, documents.length)
  assert.deepEqual(first.previousIndices, [])
  assert.deepEqual(await adapter.aliasIndices(TEST_REBUILD_ALIAS), [first.index])
  assert.equal(await adapter.count(first.index), documents.length)
  assert.equal(await adapter.searchTotal(TEST_REBUILD_ALIAS), documents.length, '冒烟查询应通过别名命中全部文档')
  assertDemoIndexStateUnchanged(demoBefore, await captureDemoIndexState(client))

  const second = await rebuildProductIndex(adapter, options)
  assert.equal(second.index, `${TEST_REBUILD_PREFIX}2`)
  assert.deepEqual(second.previousIndices, [first.index])
  assert.deepEqual(second.deletedIndices, [first.index], '成功后应删除上一版物理索引')
  assert.deepEqual(await adapter.aliasIndices(TEST_REBUILD_ALIAS), [second.index])
  assert.equal(await adapter.count(second.index), documents.length)
  assert.equal(await client.indices.exists({ index: first.index }), false, '旧索引应已删除')
  assert.equal(await adapter.count(TEST_REBUILD_ALIAS), documents.length)

  // 演示别名与 products_vN 集合不变：测试只在隔离前缀内工作。
  assert.deepEqual(await adapter.aliasIndices(DEMO_ALIAS), demoBefore.aliasTargets)
  assertDemoIndexStateUnchanged(demoBefore, await captureDemoIndexState(client))
})
