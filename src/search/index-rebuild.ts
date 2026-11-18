import {
  PRODUCT_INDEX_DEFINITION,
  PRODUCT_INDEX_PREFIX,
  PRODUCTS_ALIAS,
  productIndexName,
  productIndexVersion,
} from './index-mapping.ts'
import type { ProductSearchDocument } from './product-snapshot.ts'
import { acquireRebuildLock } from './rebuild-lock.ts'

/** 索引字段映射的只读视图：重建用它回读目标索引的实际 mapping（P2）。 */
export type IndexMapping = Record<string, { type?: string, analyzer?: string }>

/**
 * 适配器识别出的「索引已存在」：ES 返回 400 resource_already_exists_exception。
 * 并发重建选中同一版本时由此触发重新取号，而不是当成普通失败去清理索引（P2）。
 */
export class IndexAlreadyExistsError extends Error {
  readonly index: string

  constructor (index: string, options?: ErrorOptions) {
    super(`索引 ${index} 已存在`, options)
    this.name = 'IndexAlreadyExistsError'
    this.index = index
  }
}

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
  /** 回读索引的实际 mapping；重建在切换别名前用它校验关键字段（P2）。 */
  getMapping (index: string): Promise<IndexMapping>
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
  /**
   * 物理索引前缀；默认 `products_v`（ADR 0003）。
   * 测试传入隔离前缀即可跑完整重建，默认值保持不变。
   */
  indexPrefix?: string
  /** 进度输出；默认静默。 */
  log?: (line: string) => void
  /**
   * 重建互斥锁文件；默认 <仓库根>/.run/es-rebuild.lock（不依赖 cwd）。
   * 测试注入临时路径；获取与释放都在 rebuildProductIndex 内部完成。
   */
  lockPath?: string
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

/**
 * 切换后的唯一目标不变式被打破（第三轮复审）。
 * 这类失败保留现场：不回滚别名、不删除任何索引，并把实际目标带进消息。
 */
export class AliasExclusivityError extends IndexRebuildError {
  readonly alias: string
  readonly targets: string[]

  constructor (alias: string, targets: string[], message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'AliasExclusivityError'
    this.alias = alias
    this.targets = [...targets]
  }
}

/** 全量校验逐项比对的字段（D74、ADR 0003）。 */
const VALIDATED_FIELDS = ['productId', 'categorySlug', 'sales', 'displayPriceCents'] as const

/**
 * 切换别名前必须回读校验的关键字段（P2）。
 * bulk 若意外对不存在的索引自动建索引，字段会退化成 ES 默认映射；
 * 只校验 business 字段不够，必须校验类型与分析器，否则错误映射会被发布。
 */
const REQUIRED_MAPPING_FIELDS = [
  'name',
  'brand',
  'model',
  'displayPriceCents',
  'productId',
  'sales',
  'slug',
  'categorySlug',
] as const

/** 版本冲突最多重试次数（P2）：并发重建选中同一版本时重新取号。 */
const MAX_VERSION_CONFLICTS = 5

function describeError (error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function describeMappingField (field: { type?: string, analyzer?: string } | undefined): string {
  if (field === undefined) return '缺失'
  return field.analyzer === undefined
    ? String(field.type)
    : `${String(field.type)} + ${field.analyzer}`
}

/** bulk 即使在 HTTP 200 下也可能带 errors；逐项检查后才算成功（ADR 0003）。 */
function assertBulkSucceeded (bulk: BulkOutcome, expectedCount: number): void {
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
 * 切换后的不变式（第三轮复审）：别名必须恰好一个目标，且就是 indexName。
 *
 * 两个重建各自读到同一旧集合时会互相 add，别名出现多个目标。发现多目标先收敛：
 * 用一次 _aliases 请求移除除 indexName 之外的全部目标，再复查；收敛请求失败或
 * 复查仍不唯一都按失败处理，由调用方保留现场（不回滚、不删除任何索引）。
 */
async function ensureExclusiveAliasTarget (
  adapter: ProductIndexAdapter,
  alias: string,
  indexName: string,
  log: (line: string) => void,
): Promise<void> {
  const targets = await adapter.aliasIndices(alias)
  if (targets.length === 1 && targets[0] === indexName) return

  const extras = targets.filter((target) => target !== indexName)
  if (targets.includes(indexName) && extras.length > 0) {
    log(`[es:rebuild] 别名 ${alias} 同时指向 ${targets.join('、')}，先收敛为唯一目标 ${indexName}`)
    try {
      await adapter.updateAlias(alias, [], extras)
    } catch (error) {
      throw new AliasExclusivityError(
        alias,
        targets,
        `别名 ${alias} 有多个目标（实际：${targets.join('、')}），移除多余目标的请求失败：${describeError(error)}。`,
        { cause: error },
      )
    }
    const reconciled = await adapter.aliasIndices(alias)
    if (reconciled.length === 1 && reconciled[0] === indexName) return
    throw new AliasExclusivityError(
      alias,
      reconciled,
      `别名 ${alias} 收敛后仍不唯一（实际：${reconciled.length === 0 ? '无目标' : reconciled.join('、')}；` +
        `期望只有 ${indexName}）。`,
    )
  }

  throw new IndexRebuildError(
    `别名 ${alias} 切换后未指向 ${indexName}（实际：${targets.length === 0 ? '无目标' : targets.join('、')}）。`,
  )
}

/**
 * 全量重建商品索引（ADR 0003）。
 *
 * 固定顺序：建新物理索引 → 读快照 → bulk 逐项检查 → refresh → 校验映射
 * → 全量校验 → 原子切换别名（同一请求 add 新 / remove 旧）→ 校验别名 → 冒烟查询 → 删旧。
 *
 * 切换别名之前的任何失败都不会触碰别名，旧索引继续服务；新索引只在自己创建成功时清理。
 * 切换请求发出后失败/结果不明时一律保留新索引（服务端可能稍后才生效，P1-B）；
 * 切换之后的冒烟失败会先回滚别名，回滚成功且复查确认不含新索引后才清理。
 *
 * 并发重建可能选中同一版本：createIndex 抛 IndexAlreadyExistsError 时重新取号重试，
 * 他人的索引在任何异常路径下都不删除（P2）。
 */
export async function rebuildProductIndex (
  adapter: ProductIndexAdapter,
  options: RebuildProductIndexOptions,
): Promise<RebuildProductIndexResult> {
  // 互斥（第三轮复审）：CLI 与直接调用都在这里取得锁；成功与异常都由 finally 释放。
  const lock = acquireRebuildLock({ lockPath: options.lockPath })
  try {
    if (lock.recoveredFrom !== undefined) {
      const log = options.log ?? (() => {})
      log(
        `[es:rebuild] 已清理过期重建锁（pid=${lock.recoveredFrom.pid}，` +
          `启动时间=${lock.recoveredFrom.startTime}）：持有者已消失，由本次重建接管`,
      )
    }
    return await rebuildProductIndexLocked(adapter, options)
  } finally {
    lock.release()
  }
}

/** 已取得互斥锁的重建主体；锁由 rebuildProductIndex 在 finally 中释放。 */
async function rebuildProductIndexLocked (
  adapter: ProductIndexAdapter,
  options: RebuildProductIndexOptions,
): Promise<RebuildProductIndexResult> {
  const alias = options.alias ?? PRODUCTS_ALIAS
  const indexPrefix = options.indexPrefix ?? PRODUCT_INDEX_PREFIX
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
  const nextVersionFrom = (indices: string[]): number => {
    const versions = indices
      .map((index) => productIndexVersion(index, indexPrefix))
      .filter((version): version is number => version !== null)
    return versions.length === 0 ? 1 : Math.max(...versions) + 1
  }
  let nextVersion = nextVersionFrom([...existing, ...current])
  let indexName = productIndexName(nextVersion, indexPrefix)
  log(
    `[es:rebuild] 目标别名 ${alias}，新物理索引 ${indexName}` +
      `（旧索引：${previousIndices.length === 0 ? '无' : previousIndices.join('、')}）`,
  )

  // 所有权（P2）：只有本次 createIndex 成功后才允许在异常路径清理它。
  let createdIndex = false
  // 切换尝试（P1-B）：必须在调用 updateAlias 之前置位。
  let switchAttempted = false
  // 切换成功（用于判断是否需要回滚）。
  let aliasSwitched = false
  const cleanupNotes: string[] = []

  try {
    let versionConflicts = 0
    for (;;) {
      indexName = productIndexName(nextVersion, indexPrefix)
      try {
        await runStage('建索引', () => adapter.createIndex(indexName))
        createdIndex = true
        break
      } catch (error) {
        // 并发重建的版本冲突：重新取号后重试，不是失败，更不清理任何索引。
        if (!(error instanceof IndexAlreadyExistsError)) throw error
        versionConflicts += 1
        if (versionConflicts > MAX_VERSION_CONFLICTS) {
          throw new IndexRebuildError(
            `索引 ${indexName} 已存在，连续 ${versionConflicts} 次版本冲突，` +
              `重试 ${MAX_VERSION_CONFLICTS} 次后放弃。`,
            { cause: error },
          )
        }
        const retryExisting = await runStage('重新读取现有索引', () => adapter.listProductIndices())
        nextVersion = nextVersionFrom([...retryExisting, ...current])
        log(
          `[es:rebuild] 索引 ${indexName} 已存在（并发重建），` +
            `重新取号 ${productIndexName(nextVersion, indexPrefix)}`,
        )
      }
    }

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

    // bulk + refresh 之后、切换别名之前回读实际 mapping（P2）：
    // 即便发生意外的自动建索引，也在这里拦下，不发布错误映射。
    await runStage('校验映射', async () => {
      const mapping = await adapter.getMapping(indexName)
      for (const field of REQUIRED_MAPPING_FIELDS) {
        const expected = PRODUCT_INDEX_DEFINITION.mappings.properties[field]
        const actual = mapping[field]
        if (actual?.type !== expected.type || actual?.analyzer !== expected.analyzer) {
          throw new IndexRebuildError(
            `索引 ${indexName} 的字段 ${field} 映射与契约不一致：` +
              `实际 ${describeMappingField(actual)}，期望 ${describeMappingField(expected)}。`,
          )
        }
      }
    })

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
    // 发出请求之前先置位：catch 靠它区分「从未发出」与「发出但结果不明」（P1-B）。
    switchAttempted = true
    await runStage('切换别名', () => adapter.updateAlias(alias, [indexName], previousIndices))
    aliasSwitched = true

    // 切换后的不变式（第三轮复审）：别名必须恰好一个目标，且就是本次的新索引。
    await runStage('校验别名', () => ensureExclusiveAliasTarget(adapter, alias, indexName, log))

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
    // 唯一目标不变式失败（第三轮复审）：保留现场——不回滚别名、不删除任何索引。
    const exclusivityFailure = error instanceof AliasExclusivityError
    let rollbackNote = ''
    let rollbackSucceeded = false
    if (exclusivityFailure) {
      rollbackNote = '；别名目标不唯一，未回滚、未删除任何索引'
    } else if (aliasSwitched) {
      try {
        await adapter.updateAlias(alias, previousIndices, [indexName])
        aliasSwitched = false
        rollbackSucceeded = true
        rollbackNote = '；别名已回滚到旧索引'
      } catch (rollbackError) {
        rollbackNote = `；别名回滚失败（${describeError(rollbackError)}），请人工检查别名 ${alias}`
      }
    }

    // 双重确定（P1-B）：
    // - 从未发出切换请求：别名不可能引用新索引，可清理；
    // - 发出过但失败/结果不明：服务端可能稍后才让切换生效，复查不可信，一律保留；
    // - 发出并回滚成功：复查确认不含新索引后，才可清理。
    const switchOutcomeUncertain = switchAttempted && !rollbackSucceeded

    let aliasTargets: string[] | undefined
    try {
      aliasTargets = await adapter.aliasIndices(alias)
    } catch (checkError) {
      rollbackNote += `；核对别名状态失败（${describeError(checkError)}）`
    }
    const aliasChecked = aliasTargets !== undefined
    const aliasPointsToNewIndex = aliasTargets?.includes(indexName) ?? false

    let cleanupNote = ''
    if (exclusivityFailure) {
      cleanupNote = `；别名 ${alias} 目标不唯一，未执行任何索引删除（新索引 ${indexName} 已保留）`
    } else if (!createdIndex) {
      // 所有权（P2）：不是自己创建的索引，任何异常路径都不碰。
      cleanupNote = `；索引 ${indexName} 不是由本次重建创建，未执行清理`
    } else if (switchOutcomeUncertain) {
      cleanupNote = !aliasChecked
        ? `；切换结果不确定，别名状态无法确认，新索引 ${indexName} 已保留`
        : aliasPointsToNewIndex
          ? `；切换结果不确定，新索引 ${indexName} 仍被别名 ${alias} 引用，已保留`
          : `；切换结果不确定，新索引 ${indexName} 已保留`
    } else if (aliasPointsToNewIndex) {
      cleanupNote = `；新索引 ${indexName} 仍被别名 ${alias} 引用，已保留`
    } else if (!aliasChecked && switchAttempted) {
      cleanupNote = `；别名状态无法确认，新索引 ${indexName} 已保留`
    } else {
      try {
        await adapter.deleteIndex(indexName)
        cleanupNote = '；新索引已清理'
      } catch (cleanupError) {
        cleanupNote = `；新索引 ${indexName} 清理失败：${describeError(cleanupError)}`
      }
    }

    const prefix = exclusivityFailure
      ? '索引重建失败，别名目标不唯一'
      : !switchAttempted
        ? '索引重建失败，未切换别名'
        : switchOutcomeUncertain && aliasChecked && !aliasPointsToNewIndex
          ? '索引重建失败，别名切换结果不确定'
          : !aliasChecked
            ? '索引重建失败，别名状态未知'
            : aliasPointsToNewIndex
              ? '索引重建失败'
              : '索引重建失败，未切换别名'
    const message = `${prefix}（${failure}）${rollbackNote}${cleanupNote}。`
    // 唯一目标失败保持专门的错误类型，调用方无需解析文案即可识别。
    throw error instanceof AliasExclusivityError
      ? new AliasExclusivityError(error.alias, error.targets, message, { cause: error })
      : new IndexRebuildError(message, { cause: error })
  }
}
