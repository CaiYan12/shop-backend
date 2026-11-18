import type { ProductListSort } from '../db/product-list.ts'

/**
 * 搜索能力端口（#21、C37）。
 *
 * 路由只依赖这个端口，不直接持有 Elasticsearch 客户端：应用工厂负责注入实现，
 * 默认测试注入假实现，因此 `pnpm test` 不依赖 Elasticsearch 在线。
 * 关键词搜索与商品联想共用这个端口：端口只表达「查什么、要第几页 / 几条」，
 * 排序与筛选语义由实现翻译成自己的查询语言，调用方（路由）不感知 DSL。
 */
export interface ProductSearchQuery {
  /** 已 trim 的关键词，长度 1–100；空串不会进入端口。 */
  keyword: string
  /** 商品类型 slug；未提供表示不限。 */
  category?: string
  /** 展示价下限（整数分，含端点）；未提供表示不限。 */
  priceMinCents?: number
  /** 展示价上限（整数分，含端点）；未提供表示不限。 */
  priceMaxCents?: number
  /** 销量下限（含端点）；未提供表示不限。 */
  minSales?: number
  /**
   * 三种显式排序；**未显式指定时为 `undefined`**，由搜索实现按相关性排序。
   * TypeBox 不套用 schema 的 default（见 docs/typebox-notes.md），
   * 因此这里不能用 `sort ?? 'sales_desc'` 之类兜底，否则「未指定」会被吞掉。
   */
  sort?: ProductListSort
  /** 页码，1..200（D60）。 */
  page: number
  /** 每页数量，1..50（D60）。 */
  pageSize: number
}

export interface ProductSearchResult {
  /** 命中的总条数（实现必须取精确值，不接受相关性阈值截断）。 */
  total: number
  /** 当前页的命中商品 id，按搜索实现的排序；展示字段由 MySQL 按这个顺序补齐。 */
  productIds: number[]
  /**
   * 命中片段（#23），按 slug 组织：展示字段由 MySQL 补齐，路由据此把高亮合并回同一条目。
   * 高亮只是附加信息，不参与排序；没有任何片段时是空 Map。
   */
  highlights: ReadonlyMap<string, ProductHighlight>
}

/**
 * 商品联想查询（#22）：已 trim 的输入前缀与返回条数上限。
 * 与关键词搜索共用同一端口，路由不区分两个能力背后的实现。
 */
export interface ProductSuggestionQuery {
  /** 已 trim 的输入前缀，长度 1–100；空串不会进入端口。 */
  prefix: string
  /** 返回条数上限，1–10。 */
  limit: number
}

/**
 * 命中片段（#23）：按字段组织，每个片段是一段可直接渲染的文本——
 * 命中部分用固定 `<em>` 包裹，原文里的 HTML 已被转义成实体。
 * 未命中的字段不出现（不是空数组）；三个字段都未命中时整个对象不出现。
 */
export interface ProductHighlight {
  name?: string[]
  brand?: string[]
  model?: string[]
}

/** 联想条目的高亮（#23）：只覆盖 name / brand，与联想条目自身的字段集一致。 */
export interface ProductSuggestionHighlight {
  name?: string[]
  brand?: string[]
}

/** 商品联想条目（#22、#23）：slug / name / brand，命中时附加可选高亮。 */
export interface ProductSuggestionItem {
  slug: string
  name: string
  brand: string
  /** 命中片段（#23）；没有片段时不出现该字段。 */
  highlight?: ProductSuggestionHighlight
}

export interface ProductSuggestionResult {
  /** 按相关性排序、同分按 productId 升序；长度不超过 limit。 */
  items: ProductSuggestionItem[]
}

export interface ProductSearchAdapter {
  search (query: ProductSearchQuery): Promise<ProductSearchResult>
  /** 商品联想（#22）：按输入前缀返回商品条目；不可用时同样抛 SearchUnavailableError。 */
  suggest (query: ProductSuggestionQuery): Promise<ProductSuggestionResult>
}

/**
 * 搜索服务不可用（连接失败、超时、索引未就绪等）。
 * 路由把它映射为 `503 SEARCH_NOT_AVAILABLE`；其它异常仍是 `500`，
 * 以免把程序错误伪装成「稍后重试」。冷却窗口留给 #24，端口本身不保持状态。
 */
export class SearchUnavailableError extends Error {
  constructor (message = '搜索服务暂时不可用。', options?: ErrorOptions) {
    super(message, options)
    this.name = 'SearchUnavailableError'
  }
}
