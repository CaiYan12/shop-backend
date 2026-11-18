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
import {
  IndexAlreadyExistsError,
  type BulkOutcome,
  type IndexBulkOperation,
  type IndexMapping,
  type ProductIndexAdapter,
} from './index-rebuild.ts'
import {
  SearchUnavailableError,
  type ProductHighlight,
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
  /** 每个请求的最大重试次数；默认 0（不重试），在线查询显式传 0（#24、V19）。 */
  maxRetries?: number
}

export interface ElasticsearchProductIndexAdapterOptions {
  /**
   * 物理索引前缀；默认 `products_v`（ADR 0003）。
   * 测试传入隔离前缀（如 `products_es_test_rebuild_v`）即可跑完整重建而不触碰演示索引。
   */
  indexPrefix?: string
}

/** 重建专用客户端：显式超时、禁用自动重试。 */
export function createElasticsearchClient (options: ElasticsearchClientOptions): Client {
  return new Client({
    node: options.node,
    requestTimeout: options.requestTimeout ?? 30_000,
    maxRetries: options.maxRetries ?? 0,
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

/**
 * 「索引已存在」在 ES 是 400 + resource_already_exists_exception（P2）。
 * 适配器把它翻译成专门的 IndexAlreadyExistsError，重建据此重新取号；
 * 其余 400 仍是程序错误，原样上抛。
 */
function isResourceAlreadyExists (error: unknown): boolean {
  if (statusCodeOf(error) !== 400 || typeof error !== 'object' || error === null) return false
  const direct = (error as { body?: { error?: { type?: unknown } } }).body?.error?.type
  if (direct === 'resource_already_exists_exception') return true
  const meta = (error as { meta?: { body?: { error?: { type?: unknown } } } }).meta
  return meta?.body?.error?.type === 'resource_already_exists_exception'
}

/** 一次别名动作：add / remove 二选一，失败时用来在消息里指明是哪一项。 */
interface AliasActionRequest {
  add?: { index: string, alias: string }
  remove?: { index: string, alias: string }
}

function describeAliasAction (action: AliasActionRequest): string {
  if (action.add !== undefined) return `add ${action.add.index} -> ${action.add.alias}`
  if (action.remove !== undefined) return `remove ${action.remove.index} -> ${action.remove.alias}`
  return '(未知动作)'
}

interface AliasActionResultPayload {
  status?: unknown
  error?: unknown
}

/** 真实 ES 9.x 的单项 action_result：动作名下是 index/alias，status/error 在对象外层。 */
interface AliasActionResultRecord extends AliasActionResultPayload {
  add?: AliasActionResultPayload & { index?: string, alias?: string }
  remove?: AliasActionResultPayload & { index?: string, alias?: string }
}

function isSuccessStatus (status: number): boolean {
  return status >= 200 && status < 300
}

/**
 * 解析单项 action_result（第四轮复审，第五轮复审修正）。
 *
 * 真实 ES 9.x 把 status / error 放在动作对象外层，例如
 * { add: { index, alias }, status: 200 } / { remove: { index, alias }, status: 404 }；
 * 旧桩数据放在动作名下（{ remove: { status: 404 } }），布尔形式也仍然兼容。
 * 因此优先读外层 record.status / record.error，再回退到动作名下。
 */
function describeFailedAliasAction (
  action: AliasActionRequest | undefined,
  result: unknown,
): string | undefined {
  const actionText = action === undefined ? '(未知动作)' : describeAliasAction(action)
  if (result === true) return undefined
  if (result === false) return `${actionText}（布尔 false，无状态码）`
  if (typeof result !== 'object' || result === null) return undefined
  const record = result as AliasActionResultRecord
  const kind = action?.add !== undefined ? 'add' : action?.remove !== undefined ? 'remove' : undefined
  const payload = kind === undefined ? undefined : record[kind]
  const status = typeof record.status === 'number'
    ? record.status
    : typeof payload?.status === 'number'
      ? payload.status
      : undefined
  const error = record.error !== undefined ? record.error : payload?.error
  const failure = status === undefined || !isSuccessStatus(status) || error !== undefined
  if (!failure) return undefined
  const statusText = status === undefined ? '未知状态码' : `状态码 ${status}`
  const errorText = error === undefined ? '' : `，错误 ${JSON.stringify(error)}`
  return `${actionText}（${statusText}${errorText}）`
}

/** 收集失败的别名动作；与请求里的 actions 一一对应。 */
function describeFailedAliasActions (
  actions: AliasActionRequest[],
  actionResults: unknown,
): string[] {
  if (!Array.isArray(actionResults)) return []
  const failed: string[] = []
  actionResults.forEach((result, index) => {
    const detail = describeFailedAliasAction(actions[index], result)
    if (detail !== undefined) failed.push(`第 ${index + 1} 项 ${detail}`)
  })
  return failed
}

interface BulkItemPayload {
  _id?: string
  status?: number
  error?: unknown
}

/** 官方客户端适配器：查询、写入与别名操作都走同一端口。 */
export class ElasticsearchProductIndexAdapter implements ProductIndexAdapter {
  private readonly client: Client
  private readonly indexPrefix: string

  // Node 的 strip-only TypeScript 不支持构造函数参数字段，这里显式声明并赋值。
  constructor (client: Client, options: ElasticsearchProductIndexAdapterOptions = {}) {
    this.client = client
    this.indexPrefix = options.indexPrefix ?? PRODUCT_INDEX_PREFIX
  }

  async listProductIndices (): Promise<string[]> {
    try {
      const response = await this.client.indices.get({
        index: `${this.indexPrefix}*`,
        allow_no_indices: true,
        expand_wildcards: 'open',
      })
      return Object.keys(response)
        .filter((name) => productIndexVersion(name, this.indexPrefix) !== null)
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
    try {
      await this.client.indices.create({
        index,
        settings: PRODUCT_INDEX_DEFINITION.settings,
        // 映射常量本身不依赖客户端类型；结构由 test/index-mapping.test.ts 锁定，这里只做类型桥接。
        mappings: PRODUCT_INDEX_DEFINITION.mappings as unknown as MappingTypeMapping,
      })
    } catch (error) {
      if (isResourceAlreadyExists(error)) {
        throw new IndexAlreadyExistsError(index, { cause: error })
      }
      throw error
    }
  }

  /**
   * 回读目标索引的实际 mapping（P2）：重建在切换别名前用它校验关键字段。
   * 只保留 type / analyzer，避免把 ES 返回的其它字段带进契约判断。
   */
  async getMapping (index: string): Promise<IndexMapping> {
    const response = await this.client.indices.getMapping({ index })
    const properties = response[index]?.mappings?.properties
    const mapping: IndexMapping = {}
    if (properties === undefined) return mapping
    for (const [field, definition] of Object.entries(properties)) {
      if (typeof definition !== 'object' || definition === null) continue
      const record = definition as { type?: unknown, analyzer?: unknown }
      mapping[field] = {
        ...(typeof record.type === 'string' ? { type: record.type } : {}),
        ...(typeof record.analyzer === 'string' ? { analyzer: record.analyzer } : {}),
      }
    }
    return mapping
  }

  async bulk (index: string, operations: IndexBulkOperation[]): Promise<BulkOutcome> {
    const body = operations.flatMap((operation) => [
      { index: { _index: index, _id: operation.id } },
      operation.document,
    ])
    const response = await this.client.bulk({ operations: body })
    return {
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
    const response: { acknowledged?: boolean, errors?: boolean, action_results?: unknown } =
      await this.client.indices.updateAliases({ actions })
    // HTTP 200 也可能只是受理了请求：未确认、errors 为真或逐项非 2xx 时都按失败处理，
    // 让重建流程进入别名核对，而不是误以为未切换后删掉新索引。
    const failedActions = describeFailedAliasActions(actions, response.action_results)
    if (response.acknowledged !== true || response.errors === true || failedActions.length > 0) {
      throw new Error(
        `切换别名 ${alias} 未成功：acknowledged=${String(response.acknowledged)}，` +
          `errors=${String(response.errors ?? false)}` +
          `${failedActions.length === 0 ? '。' : `；失败动作：${failedActions.join('、')}。`}`,
      )
    }
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

/** 列表高亮字段（#23）：名称、品牌、型号三个检索文本字段。 */
const PRODUCT_HIGHLIGHT_FIELDS = ['name', 'brand', 'model'] as const

/** 联想高亮字段（#23）：联想条目只展示名称与品牌，型号不在契约内。 */
const PRODUCT_SUGGEST_HIGHLIGHT_FIELDS = ['name', 'brand'] as const

/**
 * 高亮的固定标签（#23）：契约规定命中片段只用不带其它标记的 `<em>` 包裹，
 * 前端据此只允许这一个标签渲染。
 */
const HIGHLIGHT_TAGS = {
  // encoder: 'html' 先转义原文再插入标签：原文里的 < / > 变成实体，
  // 响应里唯一真正的标签就是我们插入的 <em>。
  encoder: 'html' as const,
  pre_tags: ['<em>'],
  post_tags: ['</em>'],
}

/**
 * 列表高亮配置（#23）：覆盖三个检索文本字段。
 * `number_of_fragments: 0` 返回整个字段值（而不是摘要片段），
 * 前端用片段替换原字段渲染，不必担心摘要截断丢字。
 */
function buildListHighlight (): SearchRequest['highlight'] {
  return {
    ...HIGHLIGHT_TAGS,
    fields: {
      name: { number_of_fragments: 0 },
      brand: { number_of_fragments: 0 },
      model: { number_of_fragments: 0 },
    },
  }
}

/**
 * 联想高亮配置（#23）：bool_prefix 的命中落在 search_as_you_type 的子字段上，
 * 只写根字段会因为 `require_field_match` 是默认值而拿不到任何片段；
 * 因此用 `matched_fields` 把根字段与 `._index_prefix` 合并，才能标出输入前缀。
 */
function buildSuggestHighlight (): SearchRequest['highlight'] {
  return {
    ...HIGHLIGHT_TAGS,
    fields: {
      name: {
        number_of_fragments: 0,
        matched_fields: ['name', 'name._index_prefix'],
      },
      brand: {
        number_of_fragments: 0,
        matched_fields: ['brand', 'brand._index_prefix'],
      },
    },
  }
}

type EsHighlight = NonNullable<SearchHit['highlight']>

/**
 * ES 的 highlight → 端口的高亮（#23）：只保留非空片段数组。
 * 没有片段、或片段数组为空时返回 undefined——契约要求「字段不出现」，
 * 不能退化成空数组，更不能补一个空对象。
 */
function readHighlight<Field extends string> (
  highlight: EsHighlight | undefined,
  fields: readonly Field[],
): Partial<Record<Field, string[]>> | undefined {
  if (highlight === undefined) return undefined
  const result: Partial<Record<Field, string[]>> = {}
  let matched = false
  for (const field of fields) {
    const fragments = highlight[field]
    if (!Array.isArray(fragments) || fragments.length === 0) continue
    result[field] = fragments
    matched = true
  }
  return matched ? result : undefined
}

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
 * 命中文档只取 productId 与 slug（ADR 0002）：展示字段一律回 MySQL 补齐，
 * slug 是高亮合并回条目的键（#23）。
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
 * 命中文档的 slug（#23）：高亮按 slug 合并回 MySQL 补齐的条目。
 * 缺 slug 与缺 productId 同类，属索引映射与查询契约不一致。
 */
function readSearchHitSlug (hit: SearchHit): string {
  const source = hit._source as { slug?: unknown } | undefined
  const value = source?.slug
  if (typeof value !== 'string') {
    throw new Error(`搜索命中的文档 ${hit._id ?? ''} 缺少 slug，索引映射与查询契约不一致。`)
  }
  return value
}

/**
 * 联想命中的文档只取 slug / name / brand（ADR 0002）。
 * 缺字段说明索引映射与查询契约不一致，属程序错误，不能映射成「不可用」。
 * 命中片段（#23）附加在条目的 highlight 上；没有片段时不写该字段。
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
  const item: ProductSuggestionItem = { slug: source.slug, name: source.name, brand: source.brand }
  const highlight = readHighlight(hit.highlight, PRODUCT_SUGGEST_HIGHLIGHT_FIELDS)
  return highlight === undefined ? item : { ...item, highlight }
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

export interface ElasticsearchProductSearchOptions {
  /**
   * 对外别名（ADR 0003）：默认 `products`。
   * `pnpm test:es` 传入隔离的测试别名（#25），绝不读写演示别名。
   */
  alias?: string
}

/**
 * 在线搜索适配器（#21）：把端口上的结构化条件翻译成 ES 请求。
 * 默认只认别名 `products`（ADR 0003），不直接指向物理索引；
 * 别名可由调用方覆盖，供隔离的 ES 验收测试使用（#25）。
 */
export class ElasticsearchProductSearchAdapter implements ProductSearchAdapter {
  private readonly client: Client
  private readonly alias: string

  constructor (client: Client, options: ElasticsearchProductSearchOptions = {}) {
    this.client = client
    this.alias = options.alias ?? PRODUCTS_ALIAS
  }

  async search (query: ProductSearchQuery): Promise<ProductSearchResult> {
    const request: SearchRequest = {
      index: this.alias,
      // D60：总数必须精确，不能被相关性阈值截断成 10000+。
      track_total_hits: true,
      from: (query.page - 1) * query.pageSize,
      size: query.pageSize,
      // slug 是高亮合并回条目的键（#23），与 productId 一起取。
      _source: ['productId', 'slug'],
      query: buildProductSearchQuery(query),
      sort: buildProductSearchSort(query.sort),
      highlight: buildListHighlight(),
    }

    let response: SearchResponse
    try {
      response = await this.client.search(request)
    } catch (error) {
      throw toSearchUnavailable(error)
    }

    const { total, hits } = response.hits
    const productIds: number[] = []
    const highlights = new Map<string, ProductHighlight>()
    for (const hit of hits) {
      productIds.push(readSearchProductId(hit))
      // 高亮只是附加信息，不参与排序：productIds 的顺序仍是 ES 返回的顺序。
      const highlight = readHighlight(hit.highlight, PRODUCT_HIGHLIGHT_FIELDS)
      if (highlight !== undefined) {
        highlights.set(readSearchHitSlug(hit), highlight)
      }
    }
    return {
      total: typeof total === 'number' ? total : total?.value ?? 0,
      productIds,
      highlights,
    }
  }

  /**
   * 商品联想（#22）：search_as_you_type 的 bool_prefix，按相关性排序、同分按 productId 升序。
   * 只读索引内的 slug / name / brand（ADR 0002），因此不回 MySQL 补齐。
   */
  async suggest (query: ProductSuggestionQuery): Promise<ProductSuggestionResult> {
    const request: SearchRequest = {
      index: this.alias,
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
      highlight: buildSuggestHighlight(),
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
