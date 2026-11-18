import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Client } from '@elastic/elasticsearch'
import {
  ElasticsearchProductIndexAdapter,
  ElasticsearchProductSearchAdapter,
} from '../src/search/elasticsearch-adapter.ts'
import { rebuildProductIndex } from '../src/search/index-rebuild.ts'
import { loadProductSnapshot, type ProductSearchDocument } from '../src/search/product-snapshot.ts'
import { closeSeededApp, createSeededApp, type SeededApp } from '../test/helpers/seeded-app.ts'
import {
  assertDemoIndexStateUnchanged,
  captureDemoIndexState,
  createTestEsClient,
  type DemoIndexState,
} from './helpers/es-fixture.ts'
import { TEST_REBUILD_ALIAS, TEST_REBUILD_PREFIX } from './helpers/es-test-env.ts'

/**
 * 第三轮复审回归：真实 ES 上的并发重建（互斥锁 + 别名唯一目标）。
 *
 * 旧实现在同一别名上并发 add 出两个目标，HTTP 列表把同一件商品返回两次
 * （keyword=Apple 时出现两条 airpods-max）。这里连续发起两次重建：
 * 第二次在第一个仍持锁时启动，必须立即失败；随后断言别名恰好一个目标，
 * 并用真实适配器的 HTTP /api/products?keyword=Apple 核对 slug 无重复。
 */

/** 测试专用锁路径：不占用仓库默认的 .run/es-rebuild.lock。 */
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const LOCK_PATH = join(REPO_ROOT, '.run', 'es-rebuild.es-test.lock')

interface ListItem { slug: string }
interface ListBody { total: number, items: ListItem[] }

let client: Client
let seeded: SeededApp
let demoBefore: DemoIndexState
let documents: ProductSearchDocument[]

async function rebuildIndices (): Promise<string[]> {
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
async function cleanupRebuildNamespace (): Promise<void> {
  const adapter = new ElasticsearchProductIndexAdapter(client, { indexPrefix: TEST_REBUILD_PREFIX })
  const targets = await adapter.aliasIndices(TEST_REBUILD_ALIAS)
  if (targets.length > 0) await adapter.updateAlias(TEST_REBUILD_ALIAS, [], targets)
  for (const index of await rebuildIndices()) {
    assert.equal(index.startsWith(TEST_REBUILD_PREFIX), true, `清理范围只能是隔离前缀：${index}`)
    await adapter.deleteIndex(index)
  }
  assert.deepEqual(await rebuildIndices(), [], '隔离前缀下不应残留索引')
  assert.deepEqual(await adapter.aliasIndices(TEST_REBUILD_ALIAS), [], '测试别名应已清空')
}

before(async () => {
  // 仅测试路径：清掉上次运行异常中断可能留下的锁。
  rmSync(LOCK_PATH, { force: true })
  client = createTestEsClient()
  seeded = await createSeededApp({
    search: new ElasticsearchProductSearchAdapter(client, { alias: TEST_REBUILD_ALIAS }),
  })
  documents = await loadProductSnapshot(seeded.db)
  demoBefore = await captureDemoIndexState(client)
  await cleanupRebuildNamespace()
})

after(async () => {
  try {
    await cleanupRebuildNamespace()
    rmSync(LOCK_PATH, { force: true })
    assertDemoIndexStateUnchanged(demoBefore, await captureDemoIndexState(client))
  } finally {
    await closeSeededApp(seeded)
    await client.close()
  }
})

test('并发重建：第二个因锁失败，别名唯一，HTTP 关键词列表 slug 无重复', async () => {
  const adapter = new ElasticsearchProductIndexAdapter(client, { indexPrefix: TEST_REBUILD_PREFIX })
  const options = {
    alias: TEST_REBUILD_ALIAS,
    indexPrefix: TEST_REBUILD_PREFIX,
    loadSnapshot: async () => documents,
    lockPath: LOCK_PATH,
  }

  const first = rebuildProductIndex(adapter, options)
  const second = rebuildProductIndex(adapter, options)
  const outcomes = await Promise.allSettled([first, second])

  assert.equal(outcomes[0]?.status, 'fulfilled', '先取得锁的重建应成功')
  assert.equal(outcomes[1]?.status, 'rejected', '第二个重建必须因锁立即失败')
  const failure = outcomes[1]?.status === 'rejected' ? outcomes[1].reason : undefined
  assert.ok(failure instanceof Error, '第二个重建应抛出错误')
  assert.match(failure.message, /重建锁/)
  assert.ok(failure.message.includes(LOCK_PATH), '错误消息必须指出锁文件位置')
  assert.ok(failure.message.includes(String(process.pid)), '错误消息必须指出持锁进程')

  const result = outcomes[0]?.status === 'fulfilled' ? outcomes[0].value : undefined
  assert.ok(result !== undefined)
  assert.equal(result.index, `${TEST_REBUILD_PREFIX}1`, '第二个重建不得创建索引')
  const targets = await adapter.aliasIndices(TEST_REBUILD_ALIAS)
  assert.equal(targets.length, 1, `别名必须恰好一个目标，实际 ${targets.join('、')}`)
  assert.deepEqual(targets, [result.index])
  assert.equal(existsSync(LOCK_PATH), false, '重建结束后必须释放锁')

  const response = await seeded.app.inject({
    method: 'GET',
    url: '/api/products?keyword=Apple&pageSize=50',
  })
  assert.equal(response.statusCode, 200)
  const body = response.json() as ListBody
  const slugs = body.items.map((item) => item.slug)
  assert.ok(slugs.length > 1, `Apple 应命中多件商品，实际 ${slugs.length} 件`)
  assert.equal(new Set(slugs).size, slugs.length, `HTTP 列表出现重复 slug：${slugs.join('、')}`)
  assert.equal(body.total, slugs.length, 'total 应与去重后的条目数一致')
  assertDemoIndexStateUnchanged(demoBefore, await captureDemoIndexState(client))
})
