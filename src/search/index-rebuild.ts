import {
  PRODUCTS_ALIAS,
  productIndexName,
  productIndexVersion,
} from './index-mapping.ts'
import type { ProductSearchDocument } from './product-snapshot.ts'

/** 一次 bulk 操作：_id 固定用 slug（ADR 0003）。 */
export interface IndexBulkOperation {
  id: string
  document: ProductSearchDocument
}

export interface BulkItemOutcome {
  id: string
  status: number
  error?: string
}

export interface BulkOutcome {
  /** HTTP 状态码；只有 2xx 才继续。 */
  status: number
  errors: boolean
  items: BulkItemOutcome[]
}

/**
 * 重建所需的 Elasticsearch 能力端口。
 * 默认测试注入记录型假实现；生产由 ElasticsearchProductIndexAdapter 实现。
 */
export interface ProductIndexAdapter {
  listProductIndices (): Promise<string[]>
  aliasIndices (alias: string): Promise<string[]>
  createIndex (index: string): Promise<void>
  bulk (index: string, operations: IndexBulkOperation[]): Promise<BulkOutcome>
  refresh (index: string): Promise<void>
  count (index: string): Promise<number>
  getDocuments (index: string, ids: string[]): Promise<Map<string, ProductSearchDocument | undefined>>
  updateAlias (alias: string, add: string[], remove: string[]): Promise<void>
  searchTotal (index: string): Promise<number>
  deleteIndex (index: string): Promise<void>
}

export interface RebuildProductIndexOptions {
  /** MySQL 全量快照；生产注入 loadProductSnapshot(db)，测试注入固定夹具。 */
  loadSnapshot: () => Promise<ProductSearchDocument[]>
  /** 别名；默认 products。 */
  alias?: string
  /** 进度输出；默认静默。 */
  log?: (line: string) => void
}

export interface RebuildStageTiming {
  stage: string
  ms: number
}

export interface RebuildProductIndexResult {
  index: string
  previousIndices: string[]
  documentCount: number
  timings: RebuildStageTiming[]
  totalMs: number
  deletedIndices: string[]
  cleanupWarnings: string[]
}

/** 重建失败：消息里必须能看出别名当前是否仍是旧索引。 */
export class IndexRebuildError extends Error {
  constructor (message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'IndexRebuildError'
  }
}

/** 全量校验逐项比对的字段（D74、ADR 0003）。 */
const VALIDATED_FIELDS = ['productId', 'categorySlug', 'sales', 'displayPriceCents'] as const

function describeError (error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** bulk 返回 HTTP 200 也可能带 errors；逐项检查后才算成功（ADR 0003）。 */
function assertBulkSucceeded (bulk: BulkOutcome, expectedCount: number): void {
  if (bulk.status < 200 || bulk.status >= 300) {
    throw new IndexRebuildError(`bulk 返回 HTTP ${bulk.status}，没有继续。`)
  }

  const failed = bulk.items.filter(
    (item) => item.status < 200 || item.status >= 300 || item.error !== undefined,
  )
  if (bulk.errors || failed.length > 0) {
    const detail = failed
      .slice(0, 5)
      .map((item) => `${item.id === '' ? '(未知 id)' : item.id} status=${item.status}${item.error === undefined ? '' : ` error=${item.error}`}`)
      .join('；')
    throw new IndexRebuildError(
      `bulk 写入失败（errors=${String(bulk.errors)}，失败 ${failed.length} 项${detail === '' ? '' : `：${detail}`}）。`,
    )
  }
  if (bulk.items.length !== expectedCount) {
    throw new IndexRebuildError(
      `bulk 返回 ${bulk.items.length} 项，与快照 ${expectedCount} 件不一致。`,
    )
  }
}

/**
 * 全量重建商品索引（ADR 0003）。
 *
 * 固定顺序：建新物理索引 → 读快照 → bulk 逐项检查 → refresh → 全量校验
 * → 原子切换别名（同一请求 add 新 / remove 旧）→ 校验别名 → 冒烟查询 → 删旧。
 *
 * 切换别名之前的任何失败都不会触碰别名，旧索引继续服务；新索引尽力清理。
 * 切换之后的冒烟失败会先把别名回滚到旧索引，再清理新索引。
 */
export async function rebuildProductIndex (
  adapter: ProductIndexAdapter,
  options: RebuildProductIndexOptions,
): Promise<RebuildProductIndexResult> {
  const alias = options.alias ?? PRODUCTS_ALIAS
  const log = options.log ?? (() => {})
  const timings: RebuildStageTiming[] = []
  const startedAt = performance.now()

  const runStage = async <T>(stage: string, task: () => Promise<T>): Promise<T> => {
    const stageStarted = performance.now()
    try {
      return await task()
    } finally {
      const ms = Math.round(performance.now() - stageStarted)
      timings.push({ stage, ms })
      log(`[es:rebuild] ${stage}：${ms} ms`)
    }
  }

  const { existing, current } = await runStage('读取现有索引与别名', async () => {
    const existing = await adapter.listProductIndices()
    const current = await adapter.aliasIndices(alias)
    return { existing, current }
  })

  const previousIndices = [...new Set(current)]
  const versions = [...existing, ...current]
    .map((index) => productIndexVersion(index))
    .filter((version): version is number => version !== null)
  const nextVersion = versions.length === 0 ? 1 : Math.max(...versions) + 1
  const indexName = productIndexName(nextVersion)
  log(
    `[es:rebuild] 目标别名 ${alias}，新物理索引 ${indexName}` +
      `（旧索引：${previousIndices.length === 0 ? '无' : previousIndices.join('、')}）`,
  )

  let aliasSwitched = false
  const cleanupNotes: string[] = []

  try {
    await runStage('建索引', () => adapter.createIndex(indexName))

    const documents = await runStage('读取 MySQL 快照', options.loadSnapshot)
    if (documents.length === 0) {
      throw new IndexRebuildError('MySQL 快照为空，拒绝用空索引替换线上别名。')
    }
    const seenSlugs = new Set<string>()
    for (const document of documents) {
      if (seenSlugs.has(document.slug)) {
        throw new IndexRebuildError(`MySQL 快照中出现重复 slug：${document.slug}。`)
      }
      seenSlugs.add(document.slug)
    }

    const bulk = await runStage('bulk 导入', () =>
      adapter.bulk(indexName, documents.map((document) => ({ id: document.slug, document }))),
    )
    assertBulkSucceeded(bulk, documents.length)

    await runStage('refresh', () => adapter.refresh(indexName))

    await runStage('全量校验', async () => {
      const count = await adapter.count(indexName)
      if (count !== documents.length) {
        throw new IndexRebuildError(
          `索引文档数与 MySQL 快照不一致：索引 ${count}，快照 ${documents.length}。`,
        )
      }
      const stored = await adapter.getDocuments(indexName, documents.map((document) => document.slug))
      for (const expected of documents) {
        const actual = stored.get(expected.slug)
        if (actual === undefined) {
          throw new IndexRebuildError(`索引缺少商品 ${expected.slug}。`)
        }
        for (const field of VALIDATED_FIELDS) {
          if (actual[field] !== expected[field]) {
            throw new IndexRebuildError(
              `商品 ${expected.slug} 的 ${field} 与 MySQL 不一致：` +
                `索引 ${String(actual[field])}，快照 ${String(expected[field])}。`,
            )
          }
        }
      }
    })

    // 一个 _aliases 请求同时完成 add 新索引与 remove 旧索引，避免切换空窗。
    await runStage('切换别名', () => adapter.updateAlias(alias, [indexName], previousIndices))
    aliasSwitched = true

    await runStage('校验别名', async () => {
      const targets = await adapter.aliasIndices(alias)
      if (!targets.includes(indexName)) {
        throw new IndexRebuildError(`别名 ${alias} 切换后未指向 ${indexName}。`)
      }
    })

    const smokeTotal = await runStage('冒烟查询', () => adapter.searchTotal(alias))
    if (smokeTotal < 1) {
      throw new IndexRebuildError(`别名 ${alias} 的冒烟查询没有命中任何文档。`)
    }

    const deletedIndices: string[] = []
    await runStage('删除旧物理索引', async () => {
      for (const old of previousIndices) {
        if (old === indexName) continue
        try {
          await adapter.deleteIndex(old)
          deletedIndices.push(old)
        } catch (error) {
          cleanupNotes.push(`删除旧索引 ${old} 失败：${describeError(error)}`)
        }
      }
    })

    const totalMs = Math.round(performance.now() - startedAt)
    return {
      index: indexName,
      previousIndices,
      documentCount: documents.length,
      timings,
      totalMs,
      deletedIndices,
      cleanupWarnings: cleanupNotes,
    }
  } catch (error) {
    const failure = describeError(error)
    let rollbackNote = ''
    if (aliasSwitched) {
      try {
        await adapter.updateAlias(alias, previousIndices, [indexName])
        aliasSwitched = false
        rollbackNote = '；别名已回滚到旧索引'
      } catch (rollbackError) {
        rollbackNote = `；别名回滚失败（${describeError(rollbackError)}），请人工检查别名 ${alias}`
      }
    }

    let cleanupNote = ''
    try {
      await adapter.deleteIndex(indexName)
      cleanupNote = '；新索引已清理'
    } catch (cleanupError) {
      cleanupNote = `；新索引 ${indexName} 清理失败：${describeError(cleanupError)}`
    }

    const prefix = aliasSwitched ? '索引重建失败' : '索引重建失败，未切换别名'
    throw new IndexRebuildError(
      `${prefix}（${failure}）${rollbackNote}${cleanupNote}。`,
      { cause: error },
    )
  }
}
