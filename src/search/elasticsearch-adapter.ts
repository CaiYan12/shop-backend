import { Client } from '@elastic/elasticsearch'
import type {
  MappingTypeMapping,
  QueryDslQueryContainer,
  SearchHit,
  SearchRequest,
  SearchResponse,
} from '@elastic/elasticsearch/lib/api/types'
import type { ProductListSort } from '../db/product-list.ts'
import {
  PRODUCT_INDEX_DEFINITION,
  PRODUCT_INDEX_PREFIX,
  PRODUCTS_ALIAS,
  productIndexVersion,
} from './index-mapping.ts'
import type {
  BulkOutcome,
  IndexBulkOperation,
  ProductIndexAdapter,
} from './index-rebuild.ts'
import {
  SearchUnavailableError,
  type ProductSearchAdapter,
  type ProductSearchQuery,
  type ProductSearchResult,
  type ProductSuggestionItem,
  type ProductSuggestionQuery,
  type ProductSuggestionResult,
} from './product-search.ts'
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

/** 检索字段与权重（C61）：name^3、model^3、brand^2、categoryName^1；不设 fuzziness，即关闭模糊匹配。 */
const PRODUCT_SEARCH_FIELDS = ['name^3', 'model^3', 'brand^2', 'categoryName^1']

/**
 * 联想字段（#22）：name / brand / model 都是 search_as_you_type，
 * bool_prefix 需要根字段与 ._2gram / ._3gram 一起参与，才能匹配输入中途的前缀。
 */
const PRODUCT_SUGGEST_FIELDS = [
  'name', 'name._2gram', 'name._3gram',
  'brand', 'brand._2gram', 'brand._3gram',
  'model', 'model._2gram', 'model._3gram',
]

/** 联想只用索引内的三个展示字段，不回 MySQL（ADR 0002）。 */
const PRODUCT_SUGGEST_SOURCE = ['slug', 'name', 'brand']

/**
 * 联想排序（#22）：相关性优先，同分追加 productId 升序。
 * 与关键词搜索同理：ES 默认的平分次序依赖分片内部文档号，重建后会变。
 */
const PRODUCT_SUGGEST_SORT: SearchRequest['sort'] = [
  { _score: { order: 'desc' } },
  { productId: { order: 'asc' } },
]

/**
 * 端口排序 → ES 排序（D61、C49）：
 * - 未显式指定排序：相关性（_score）优先，同分追加 productId 升序；
 * - 三种显式排序：价格升序 / 价格降序 / 销量降序，同值同样追加 productId 升序。
 * 追加 productId 是为了翻页稳定：ES 默认的平分次序依赖分片内部文档号，重建后会变。
 */
function buildProductSearchSort (sort: ProductListSort | undefined): SearchRequest['sort'] {
  const byProductId = { productId: { order: 'asc' as const } }
  if (sort === 'price_asc') return [{ displayPriceCents: { order: 'asc' as const } }, byProductId]
  if (sort === 'price_desc') return [{ displayPriceCents: { order: 'desc' as const } }, byProductId]
  if (sort === 'sales_desc') return [{ sales: { order: 'desc' as const } }, byProductId]
  return [{ _score: { order: 'desc' as const } }, byProductId]
}

/**
 * 端口筛选 → ES 过滤（C38、D61）：筛选走 bool.filter，不参与打分；
 * 价格用 displayPriceCents（映射为 long），销量用 sales，商品类型用 categorySlug 精确匹配。
 */
function buildProductSearchQuery (query: ProductSearchQuery): SearchRequest['query'] {
  const filters: QueryDslQueryContainer[] = []
  if (query.category !== undefined) {
    filters.push({ term: { categorySlug: query.category } })
  }
  const priceRange: { gte?: number, lte?: number } = {}
  if (query.priceMinCents !== undefined) priceRange.gte = query.priceMinCents
  if (query.priceMaxCents !== undefined) priceRange.lte = query.priceMaxCents
  if (priceRange.gte !== undefined || priceRange.lte !== undefined) {
    filters.push({ range: { displayPriceCents: priceRange } })
  }
  if (query.minSales !== undefined) {
    filters.push({ range: { sales: { gte: query.minSales } } })
  }

  return {
    bool: {
      must: [{
        multi_match: {
          query: query.keyword,
          type: 'best_fields',
          operator: 'or',
          fields: PRODUCT_SEARCH_FIELDS,
        },
      }],
      ...(filters.length === 0 ? {} : { filter: filters }),
    },
  }
}

/**
 * 命中文档只取 productId（ADR 0002）：展示字段一律回 MySQL 补齐。
 * 缺 productId 说明索引映射与查询契约不一致，属程序错误，不能映射成「不可用」。
 */
function readSearchProductId (hit: SearchHit): number {
  const source = hit._source as { productId?: unknown } | undefined
  const value = source?.productId
  if (typeof value !== 'number') {
    throw new Error(`搜索命中的文档 ${hit._id ?? ''} 缺少 productId，索引映射与查询契约不一致。`)
  }
  return value
}

/**
 * 联想命中的文档只取 slug / name / brand（ADR 0002）。
 * 缺字段说明索引映射与查询契约不一致，属程序错误，不能映射成「不可用」。
 */
function readSuggestionItem (hit: SearchHit): ProductSuggestionItem {
  const source = hit._source as { slug?: unknown, name?: unknown, brand?: unknown } | undefined
  if (
    source === undefined ||
    typeof source.slug !== 'string' ||
    typeof source.name !== 'string' ||
    typeof source.brand !== 'string'
  ) {
    throw new Error('联想命中的文档 ' + (hit._id ?? '') + ' 缺少 slug / name / brand，索引映射与查询契约不一致。')
  }
  return { slug: source.slug, name: source.name, brand: source.brand }
}

/**
 * 4xx（除索引 / 别名不存在）说明请求本身不合法，是程序错误，原样上抛走 500；
 * 连接失败、超时、索引未就绪与其它 5xx 一律视为服务不可用，映射为 503。
 */
function toSearchUnavailable (error: unknown): Error {
  const status = statusCodeOf(error)
  if (status !== undefined && status >= 400 && status < 500 && status !== 404) {
    return error instanceof Error ? error : new Error(String(error))
  }
  return new SearchUnavailableError('搜索服务暂时不可用。', { cause: error })
}

/**
 * 在线搜索适配器（#21）：把端口上的结构化条件翻译成 ES 请求。
 * 对外只认别名 `products`（ADR 0003），不直接指向物理索引。
 */
export class ElasticsearchProductSearchAdapter implements ProductSearchAdapter {
  private readonly client: Client

  constructor (client: Client) {
    this.client = client
  }

  async search (query: ProductSearchQuery): Promise<ProductSearchResult> {
    const request: SearchRequest = {
      index: PRODUCTS_ALIAS,
      // D60：总数必须精确，不能被相关性阈值截断成 10000+。
      track_total_hits: true,
      from: (query.page - 1) * query.pageSize,
      size: query.pageSize,
      _source: ['productId'],
      query: buildProductSearchQuery(query),
      sort: buildProductSearchSort(query.sort),
    }

    let response: SearchResponse
    try {
      response = await this.client.search(request)
    } catch (error) {
      throw toSearchUnavailable(error)
    }

    const { total } = response.hits
    return {
      total: typeof total === 'number' ? total : total?.value ?? 0,
      productIds: response.hits.hits.map(readSearchProductId),
    }
  }

  /**
   * 商品联想（#22）：search_as_you_type 的 bool_prefix，按相关性排序、同分按 productId 升序。
   * 只读索引内的 slug / name / brand（ADR 0002），因此不回 MySQL 补齐。
   */
  async suggest (query: ProductSuggestionQuery): Promise<ProductSuggestionResult> {
    const request: SearchRequest = {
      index: PRODUCTS_ALIAS,
      size: query.limit,
      _source: PRODUCT_SUGGEST_SOURCE,
      query: {
        multi_match: {
          query: query.prefix,
          type: 'bool_prefix',
          fields: PRODUCT_SUGGEST_FIELDS,
        },
      },
      sort: PRODUCT_SUGGEST_SORT,
    }

    let response: SearchResponse
    try {
      response = await this.client.search(request)
    } catch (error) {
      throw toSearchUnavailable(error)
    }

    return { items: response.hits.hits.map(readSuggestionItem) }
  }
}

