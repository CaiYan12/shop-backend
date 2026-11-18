import type { Client } from '@elastic/elasticsearch'
import {
  createElasticsearchClient,
  ElasticsearchProductIndexAdapter,
  ElasticsearchProductSearchAdapter,
} from '../../src/search/elasticsearch-adapter.ts'
import { PRODUCTS_ALIAS } from '../../src/search/index-mapping.ts'
import type { ProductSearchDocument } from '../../src/search/product-snapshot.ts'
import { DEMO_ALIAS, isIsolatedIndexName, testEsUrl } from './es-test-env.ts'

/** 真实 ES 客户端：超时放宽到 10 s，且不自动重试（与重建客户端同策略）。 */
export function createTestEsClient (): Client {
  return createElasticsearchClient({ node: testEsUrl(), requestTimeout: 10_000, maxRetries: 0 })
}

/**
 * 命名护栏（#25）：测试只允许操作 `products_es_test*` 索引与非 `products` 别名。
 * 任何一处写错都在创建前失败，而不是先污染演示索引再回滚。
 */
export function assertIsolatedNames (index: string, alias: string): void {
  if (alias === PRODUCTS_ALIAS) {
    throw new Error(`测试别名不能是演示别名 ${PRODUCTS_ALIAS}（#25）。`)
  }
  if (!isIsolatedIndexName(index)) {
    throw new Error(`测试索引 ${index} 不在 products_es_test* 命名空间内（#25）。`)
  }
}

export interface IsolatedProductIndex {
  indexAdapter: ElasticsearchProductIndexAdapter
  searchAdapter: ElasticsearchProductSearchAdapter
}

/**
 * 建隔离物理索引 + 别名并导入文档：调用方给出文档，写入后 refresh 并校验条数。
 * 上一轮遗留的别名 / 索引先清理；失败时不触碰演示索引。
 */
export async function resetIsolatedProductIndex (
  client: Client,
  index: string,
  alias: string,
  documents: ProductSearchDocument[],
): Promise<IsolatedProductIndex> {
  assertIsolatedNames(index, alias)
  const indexAdapter = new ElasticsearchProductIndexAdapter(client)

  const staleAliases = await indexAdapter.aliasIndices(alias)
  if (staleAliases.length > 0) {
    await indexAdapter.updateAlias(alias, [], staleAliases)
  }
  await indexAdapter.deleteIndex(index)

  await indexAdapter.createIndex(index)
  const bulk = await indexAdapter.bulk(
    index,
    documents.map((document) => ({ id: document.slug, document })),
  )
  if (bulk.status < 200 || bulk.status >= 300 || bulk.errors) {
    throw new Error(`测试索引 bulk 导入失败：status=${bulk.status} errors=${String(bulk.errors)}。`)
  }
  await indexAdapter.refresh(index)
  const count = await indexAdapter.count(index)
  if (count !== documents.length) {
    throw new Error(`测试索引文档数不符：索引 ${count}，快照 ${documents.length}。`)
  }
  await indexAdapter.updateAlias(alias, [index], [])

  return {
    indexAdapter,
    searchAdapter: new ElasticsearchProductSearchAdapter(client, { alias }),
  }
}

/** 清理隔离索引与别名；只允许删除自己的索引。 */
export async function cleanupIsolatedProductIndex (
  client: Client,
  index: string,
  alias: string,
): Promise<void> {
  assertIsolatedNames(index, alias)
  const indexAdapter = new ElasticsearchProductIndexAdapter(client)
  const targets = await indexAdapter.aliasIndices(alias)
  if (targets.length > 0) {
    await indexAdapter.updateAlias(alias, [], targets)
  }
  await indexAdapter.deleteIndex(index)

  const remaining = await indexAdapter.aliasIndices(alias)
  if (remaining.length > 0) {
    throw new Error(`测试别名 ${alias} 清理后仍指向 ${remaining.join('、')}。`)
  }
}

export interface DemoIndexState {
  aliasTargets: string[]
  productIndices: string[]
}

/** 演示索引与别名的只读快照：用于核对测试前后完全一致（#25）。 */
export async function captureDemoIndexState (client: Client): Promise<DemoIndexState> {
  const indexAdapter = new ElasticsearchProductIndexAdapter(client)
  return {
    aliasTargets: (await indexAdapter.aliasIndices(DEMO_ALIAS)).sort(),
    productIndices: (await indexAdapter.listProductIndices()).sort(),
  }
}

/** 断言演示别名与 `products_vN` 索引集合与测试前一致。 */
export function assertDemoIndexStateUnchanged (
  before: DemoIndexState,
  after: DemoIndexState,
): void {
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error(
      `测试影响了演示索引：之前 ${JSON.stringify(before)}，之后 ${JSON.stringify(after)}（#25）。`,
    )
  }
}

