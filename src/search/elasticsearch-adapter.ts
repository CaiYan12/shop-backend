import { Client } from '@elastic/elasticsearch'
import type { MappingTypeMapping } from '@elastic/elasticsearch/lib/api/types'
import {
  PRODUCT_INDEX_DEFINITION,
  PRODUCT_INDEX_PREFIX,
  productIndexVersion,
} from './index-mapping.ts'
import type {
  BulkOutcome,
  IndexBulkOperation,
  ProductIndexAdapter,
} from './index-rebuild.ts'
import type { ProductSearchDocument } from './product-snapshot.ts'

export interface ElasticsearchClientOptions {
  node: string
  /** 重建比在线查询宽松：默认 30 s，且不自动重试，避免 bulk 被重放。 */
  requestTimeout?: number
}

/** 重建专用客户端：显式超时、禁用自动重试。 */
export function createElasticsearchClient (options: ElasticsearchClientOptions): Client {
  return new Client({
    node: options.node,
    requestTimeout: options.requestTimeout ?? 30_000,
    maxRetries: 0,
  })
}

function statusCodeOf (error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const meta = (error as { meta?: { statusCode?: unknown } }).meta
  if (typeof meta?.statusCode === 'number') return meta.statusCode
  const direct = (error as { statusCode?: unknown }).statusCode
  return typeof direct === 'number' ? direct : undefined
}

/** 404 在索引/别名不存在时是正常状态，不该中断重建。 */
function isNotFound (error: unknown): boolean {
  return statusCodeOf(error) === 404
}

interface BulkItemPayload {
  _id?: string
  status?: number
  error?: unknown
}

/** 官方客户端适配器：查询、写入与别名操作都走同一端口。 */
export class ElasticsearchProductIndexAdapter implements ProductIndexAdapter {
  private readonly client: Client

  // Node 的 strip-only TypeScript 不支持构造函数参数字段，这里显式声明并赋值。
  constructor (client: Client) {
    this.client = client
  }

  async listProductIndices (): Promise<string[]> {
    try {
      const response = await this.client.indices.get({
        index: `${PRODUCT_INDEX_PREFIX}*`,
        allow_no_indices: true,
        expand_wildcards: 'open',
      })
      return Object.keys(response).filter((name) => productIndexVersion(name) !== null)
    } catch (error) {
      if (isNotFound(error)) return []
      throw error
    }
  }

  async aliasIndices (alias: string): Promise<string[]> {
    try {
      const response = await this.client.indices.getAlias({ name: alias })
      return Object.keys(response)
    } catch (error) {
      if (isNotFound(error)) return []
      throw error
    }
  }

  async createIndex (index: string): Promise<void> {
    await this.client.indices.create({
      index,
      settings: PRODUCT_INDEX_DEFINITION.settings,
      // 映射常量本身不依赖客户端类型；结构由 test/index-mapping.test.ts 锁定，这里只做类型桥接。
      mappings: PRODUCT_INDEX_DEFINITION.mappings as unknown as MappingTypeMapping,
    })
  }

  async bulk (index: string, operations: IndexBulkOperation[]): Promise<BulkOutcome> {
    const body = operations.flatMap((operation) => [
      { index: { _index: index, _id: operation.id } },
      operation.document,
    ])
    const response = await this.client.bulk({ operations: body })
    return {
      status: 200,
      errors: response.errors,
      items: response.items.map((item) => {
        const actionName = Object.keys(item)[0] ?? ''
        const payload = (item as Record<string, BulkItemPayload>)[actionName] ?? {}
        return {
          id: payload._id ?? '',
          status: payload.status ?? 0,
          error: payload.error === undefined ? undefined : JSON.stringify(payload.error),
        }
      }),
    }
  }

  async refresh (index: string): Promise<void> {
    await this.client.indices.refresh({ index })
  }

  async count (index: string): Promise<number> {
    const response = await this.client.count({ index })
    return response.count
  }

  async getDocuments (
    index: string,
    ids: string[],
  ): Promise<Map<string, ProductSearchDocument | undefined>> {
    const documents = new Map<string, ProductSearchDocument | undefined>()
    if (ids.length === 0) return documents
    const response = await this.client.mget({ index, ids })
    for (const doc of response.docs) {
      if ('found' in doc && doc.found && '_source' in doc && doc._source !== undefined && doc._source !== null) {
        documents.set(String(doc._id), doc._source as ProductSearchDocument)
      }
    }
    return documents
  }

  async updateAlias (alias: string, add: string[], remove: string[]): Promise<void> {
    const actions = [
      ...add.map((index) => ({ add: { index, alias } })),
      ...remove.map((index) => ({ remove: { index, alias } })),
    ]
    if (actions.length === 0) return
    await this.client.indices.updateAliases({ actions })
  }

  async searchTotal (index: string): Promise<number> {
    const response = await this.client.search({
      index,
      size: 1,
      track_total_hits: true,
    })
    const total = response.hits.total
    return typeof total === 'number' ? total : total?.value ?? 0
  }

  async deleteIndex (index: string): Promise<void> {
    try {
      await this.client.indices.delete({ index })
    } catch (error) {
      if (!isNotFound(error)) throw error
    }
  }
}
