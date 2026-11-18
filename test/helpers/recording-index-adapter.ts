import type {
  BulkOutcome,
  IndexBulkOperation,
  ProductIndexAdapter,
} from '../../src/search/index-rebuild.ts'
import type { ProductSearchDocument } from '../../src/search/product-snapshot.ts'
import { PRODUCT_INDEX_PREFIX, productIndexVersion } from '../../src/search/index-mapping.ts'

/** 记录型假适配器：记录调用序列，并在内存里维护索引、文档与别名。 */
export type RecordedStep =
  | { name: 'listProductIndices' }
  | { name: 'aliasIndices', alias: string }
  | { name: 'createIndex', index: string }
  | { name: 'bulk', index: string, ids: string[], documents: ProductSearchDocument[] }
  | { name: 'refresh', index: string }
  | { name: 'count', index: string }
  | { name: 'getDocuments', index: string, ids: string[] }
  | { name: 'updateAlias', alias: string, add: string[], remove: string[] }
  | { name: 'searchTotal', index: string }
  | { name: 'deleteIndex', index: string }

export interface RecordingProductIndexAdapterOptions {
  /** 物理索引前缀；默认 products_v，与生产一致。 */
  indexPrefix?: string
}

export class RecordingProductIndexAdapter implements ProductIndexAdapter {
  readonly steps: RecordedStep[] = []
  readonly indices = new Map<string, Map<string, ProductSearchDocument>>()
  readonly aliases = new Map<string, Set<string>>()
  private readonly indexPrefix: string

  constructor (options: RecordingProductIndexAdapterOptions = {}) {
    this.indexPrefix = options.indexPrefix ?? PRODUCT_INDEX_PREFIX
  }

  /** 模拟 bulk 逐项失败；errors 与 item.status 同步变为失败。 */
  bulkErrorIds = new Set<string>()
  /** 模拟写入后与 MySQL 快照不一致，供全量校验阶段发现。 */
  corruptDocument?: (document: ProductSearchDocument) => ProductSearchDocument
  /** 非负值时覆盖冒烟查询总数，用于模拟切别名后失败。 */
  smokeTotal = -1
  /** 让指定的一次 updateAlias 直接失败（例如模拟回滚失败）。 */
  aliasUpdateFailure?: (attempt: { alias: string, add: string[], remove: string[] }) => Error | undefined

  async listProductIndices (): Promise<string[]> {
    this.steps.push({ name: 'listProductIndices' })
    return [...this.indices.keys()]
      .filter((name) => productIndexVersion(name, this.indexPrefix) !== null)
      .sort()
  }

  async aliasIndices (alias: string): Promise<string[]> {
    this.steps.push({ name: 'aliasIndices', alias })
    return [...(this.aliases.get(alias) ?? [])].sort()
  }

  async createIndex (index: string): Promise<void> {
    this.steps.push({ name: 'createIndex', index })
    if (this.indices.has(index)) throw new Error(`索引 ${index} 已存在`)
    this.indices.set(index, new Map())
  }

  async bulk (index: string, operations: IndexBulkOperation[]): Promise<BulkOutcome> {
    this.steps.push({
      name: 'bulk',
      index,
      ids: operations.map((operation) => operation.id),
      documents: operations.map((operation) => operation.document),
    })
    const store = this.indices.get(index)
    if (store === undefined) throw new Error(`索引 ${index} 不存在`)

    let errors = false
    const items = operations.map((operation) => {
      if (this.bulkErrorIds.has(operation.id)) {
        errors = true
        return { id: operation.id, status: 400, error: 'simulated bulk failure' }
      }
      const document = this.corruptDocument === undefined
        ? operation.document
        : this.corruptDocument(operation.document)
      store.set(operation.id, document)
      return { id: operation.id, status: 201 }
    })
    return { errors, items }
  }

  async refresh (index: string): Promise<void> {
    this.steps.push({ name: 'refresh', index })
  }

  async count (index: string): Promise<number> {
    this.steps.push({ name: 'count', index })
    return this.indices.get(index)?.size ?? 0
  }

  async getDocuments (
    index: string,
    ids: string[],
  ): Promise<Map<string, ProductSearchDocument | undefined>> {
    this.steps.push({ name: 'getDocuments', index, ids })
    const store = this.indices.get(index) ?? new Map<string, ProductSearchDocument>()
    return new Map(ids.map((id) => [id, store.get(id)]))
  }

  async updateAlias (alias: string, add: string[], remove: string[]): Promise<void> {
    this.steps.push({ name: 'updateAlias', alias, add: [...add], remove: [...remove] })
    const failure = this.aliasUpdateFailure?.({ alias, add: [...add], remove: [...remove] })
    if (failure !== undefined) throw failure
    const targets = this.aliases.get(alias) ?? new Set<string>()
    for (const index of remove) targets.delete(index)
    for (const index of add) targets.add(index)
    if (targets.size === 0) this.aliases.delete(alias)
    else this.aliases.set(alias, targets)
  }

  async searchTotal (index: string): Promise<number> {
    this.steps.push({ name: 'searchTotal', index })
    if (this.smokeTotal >= 0) return this.smokeTotal
    let total = 0
    for (const target of this.aliases.get(index) ?? []) total += this.indices.get(target)?.size ?? 0
    return total
  }

  async deleteIndex (index: string): Promise<void> {
    this.steps.push({ name: 'deleteIndex', index })
    this.indices.delete(index)
  }
}
