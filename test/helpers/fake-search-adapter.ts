import {
  SearchUnavailableError,
  type ProductHighlight,
  type ProductSearchAdapter,
  type ProductSearchQuery,
  type ProductSearchResult,
  type ProductSuggestionItem,
  type ProductSuggestionQuery,
  type ProductSuggestionResult,
} from '../../src/search/product-search.ts'

/**
 * 搜索端口的假实现（#21）：默认套件注入它，因此不依赖 Elasticsearch。
 *
 * - 记录每次调用，供断言「筛选与排序参数正确传到搜索端口」；
 * - `hits` 是固定命中顺序（productId），按 page/pageSize 切片，模拟 ES 的 from/size；
 * - `total` 缺省等于 `hits.length`，显式给出可构造「本页不足一页但总数更大」的场景；
 * - `failure` 非空时抛出，用于模拟搜索服务不可用或程序错误；
 * - `items` 是商品联想的固定候选，按 limit 截断，模拟 ES 的 size（#22）。
 */
export class FakeProductSearchAdapter implements ProductSearchAdapter {
  readonly queries: ProductSearchQuery[] = []
  readonly suggestionQueries: ProductSuggestionQuery[] = []
  hits: number[] = []
  total: number | undefined = undefined
  /** 命中片段（#23）：按 slug 组织，模拟 ES 返回的 highlight，路由据此合并回条目。 */
  highlights = new Map<string, ProductHighlight>()
  items: ProductSuggestionItem[] = []
  failure: Error | undefined = undefined

  reset (): void {
    this.queries.length = 0
    this.suggestionQueries.length = 0
    this.hits = []
    this.total = undefined
    this.highlights = new Map()
    this.items = []
    this.failure = undefined
  }

  /** 让后续搜索都抛「不可用」，用于降级用例。 */
  failUnavailable (): void {
    this.failure = new SearchUnavailableError('模拟的搜索服务连接失败。')
  }

  async search (query: ProductSearchQuery): Promise<ProductSearchResult> {
    this.queries.push(query)
    if (this.failure !== undefined) throw this.failure
    const start = (query.page - 1) * query.pageSize
    return {
      total: this.total ?? this.hits.length,
      productIds: this.hits.slice(start, start + query.pageSize),
      highlights: this.highlights,
    }
  }

  /** 商品联想（#22）：记录入参，按 limit 截断固定候选，顺序原样返回。 */
  async suggest (query: ProductSuggestionQuery): Promise<ProductSuggestionResult> {
    this.suggestionQueries.push(query)
    if (this.failure !== undefined) throw this.failure
    return { items: this.items.slice(0, query.limit) }
  }
}
