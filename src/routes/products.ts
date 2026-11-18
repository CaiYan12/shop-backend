import type { FastifyRequest } from 'fastify'
import { Type, type Static } from 'typebox'
import type { AppInstance } from '../app.ts'
import {
  selectProductDetail,
  selectProductImages,
  selectProductVariants,
} from '../db/product-detail.ts'
import {
  selectCoverImages,
  selectProductListPage,
  selectProductListRowsByIds,
  PRODUCT_LIST_SORTS,
  type ProductListSort,
} from '../db/product-list.ts'
import { selectProductRecommendations } from '../db/product-recommendations.ts'
import { selectProductSummaries } from '../db/product-summary.ts'
import { AppError } from '../errors.ts'
import { yuanToCents } from '../money.ts'
import {
  SearchUnavailableError,
  type ProductSearchQuery,
  type ProductSearchResult,
  type ProductSuggestionQuery,
  type ProductSuggestionResult,
} from '../search/product-search.ts'
import { ProductSlugParams } from '../schemas/product.ts'

/** 相关推荐固定取 4 件（D66）：同类优先，不足时从其他商品类型补足。 */
const RECOMMENDATION_LIMIT = 4

/** 列表查询参数（D61、D68）；未提供的筛选条件表示不限。 */
const ListProductsQuery = Type.Object({
  category: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  priceMinCents: Type.Optional(Type.Integer({ minimum: 0, maximum: 9_999_999_999 })),
  priceMaxCents: Type.Optional(Type.Integer({ minimum: 0, maximum: 9_999_999_999 })),
  minSales: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_000_000 })),
  keyword: Type.Optional(Type.String({ maxLength: 100 })),
  sort: Type.Optional(Type.Union(
    PRODUCT_LIST_SORTS.map((sort) => Type.Literal(sort)),
    { default: 'sales_desc' },
  )),
  page: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 1 })),
  pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 8 })),
})

/**
 * 商品联想查询参数（#22）：q 必填、trim 后 1–100；limit 为 1–10 的整数，默认 5。
 * `default` 只进契约，运行时仍由 handler 兜底（见 docs/typebox-notes.md）。
 */
const SuggestProductsQuery = Type.Object({
  q: Type.String({ minLength: 1, maxLength: 100 }),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, default: 5 })),
})

/** 商品联想的缺省条数（#22）：与契约里的 `default` 同值，但运行时由 handler 兜底。 */
const SUGGESTION_DEFAULT_LIMIT = 5

/** 关键词先 trim（D69）：空白串按无关键词处理，长度校验作用在 trim 之后。 */
async function trimKeyword (request: FastifyRequest): Promise<void> {
  const query = request.query as { keyword?: string }
  if (typeof query.keyword === 'string') {
    query.keyword = query.keyword.trim()
  }
}

/**
 * 商品联想先 trim 再校验（#22）：空白 q 按非法参数处理，长度校验作用在 trim 之后。
 * limit 不做原始字符串校验：整个 API 的整数参数都沿用 Value.Convert 的既有行为
 * （"2.5" 截断为 2 后通过范围校验），与 page / pageSize 一致（见 docs/typebox-notes.md）。
 * 缺参时框架校验的 instancePath 为空、明细只会落到 `querystring`，
 * 这里补一条指向具体参数的明细，满足「details 指向对应参数」。
 */
async function normalizeSuggestionQuery (request: FastifyRequest): Promise<void> {
  const query = request.query as { q?: unknown }
  if (query.q === undefined) {
    throw new AppError('VALIDATION_FAILED', '缺少查询参数 q。', [
      { path: 'querystring/q', message: '必须提供 q。' },
    ])
  }
  if (typeof query.q === 'string') {
    query.q = query.q.trim()
  }
}

/** 列表项的商品字段（D67）：列表行与相关推荐候选都满足这一形状。 */
interface ListItemProduct {
  slug: string
  name: string
  brand: string
  model: string
  categorySlug: string
  categoryName: string
  rating: number
  sales: number
}

/** 列表项的派生摘要（D49）：展示价、展示原价与售罄状态。 */
interface ListItemSummary {
  displayPrice: number
  displayOriginalPrice: number
  soldOut: boolean
}

/** 列表项 11 字段投影（D67）：列表与相关推荐共用，字段只写一份。 */
function toListItem (
  product: ListItemProduct,
  summary: ListItemSummary,
  coverImage: { path: string, alt: string },
) {
  return {
    slug: product.slug,
    name: product.name,
    brand: product.brand,
    model: product.model,
    category: { slug: product.categorySlug, name: product.categoryName },
    displayPriceCents: yuanToCents(summary.displayPrice),
    displayOriginalPriceCents: yuanToCents(summary.displayOriginalPrice),
    soldOut: summary.soldOut,
    rating: product.rating,
    sales: product.sales,
    coverImage,
  }
}

/** 列表查询的静态类型：helper 与 handler 共用同一份 schema 推导。 */
type ListProductsQueryType = Static<typeof ListProductsQuery>

/**
 * 调用搜索端口（#21、#22、C37）：把「连不上 / 超时 / 索引未就绪」映射为 503；
 * 其它异常保持 500，避免把程序错误伪装成「稍后重试」。
 * 关键词搜索与商品联想共用这一份错误映射，方法差异只通过回调表达。
 */
async function callSearchPort<T> (task: () => Promise<T>): Promise<T> {
  try {
    return await task()
  } catch (error) {
    if (error instanceof SearchUnavailableError) {
      throw new AppError('SEARCH_NOT_AVAILABLE', '搜索服务暂时不可用，请稍后重试。')
    }
    throw error
  }
}

/** 关键词搜索（#21）：只传结构化条件，路由不感知查询 DSL。 */
function searchProductHits (
  app: AppInstance,
  query: ProductSearchQuery,
): Promise<ProductSearchResult> {
  return callSearchPort(() => app.productSearch.search(query))
}

/**
 * 商品联想（#22）：与关键词搜索共用同一个端口与同一套降级语义。
 * 路由只把端口结果转成响应，不感知查询 DSL，也不直接持有适配器。
 */
function suggestProductHits (
  app: AppInstance,
  query: ProductSuggestionQuery,
): Promise<ProductSuggestionResult> {
  return callSearchPort(() => app.productSearch.suggest(query))
}

/**
 * 关键词路径（#21、ADR 0002）：命中与顺序由搜索端口给出，展示字段回 MySQL 按命中顺序补齐。
 * 补齐与 MySQL 路径共用同一条派生查询，因此展示价、展示原价、售罄、评分、销量、封面图
 * 的含义与无关键词浏览完全一致（11 个字段相同）。
 */
async function listProductsByKeyword (
  app: AppInstance,
  query: ListProductsQueryType,
  keyword: string,
  page: number,
  pageSize: number,
) {
  const result = await searchProductHits(app, {
    keyword,
    category: query.category,
    priceMinCents: query.priceMinCents,
    priceMaxCents: query.priceMaxCents,
    minSales: query.minSales,
    // 只有显式指定三种排序时才是具体值；未指定保持 undefined，由搜索侧按相关性排序。
    sort: query.sort,
    page,
    pageSize,
  })

  const [rowsById, covers] = await Promise.all([
    selectProductListRowsByIds(app.db, result.productIds),
    selectCoverImages(app.db, result.productIds),
  ])

  const items = result.productIds.map((productId) => {
    const row = rowsById.get(productId)
    if (row === undefined) {
      // ES 文档是重建时的快照（ADR 0002）：命中在 MySQL 缺失说明索引已过期，属数据完整性异常。
      throw new Error(`搜索命中的商品 ${productId} 不在数据库中，请重建商品索引。`)
    }
    const coverImage = covers.get(productId)
    if (coverImage === undefined) {
      // D67：封面图必填，无图属数据完整性异常。
      throw new Error(`商品 ${row.slug} 缺少封面图，列表无法渲染。`)
    }
    const item = toListItem(row, row, coverImage)
    // 命中高亮（#23）按 slug 合并回同一条目：展示字段仍来自 MySQL，顺序仍由搜索端口决定。
    // 没有片段时不写该字段，前端按原字段渲染。
    const highlight = result.highlights.get(row.slug)
    return highlight === undefined ? item : { ...item, highlight }
  })

  return {
    page,
    pageSize,
    total: result.total,
    totalPages: result.total === 0 ? 0 : Math.ceil(result.total / pageSize),
    items,
  }
}

/** 商品列表路由（D58）：挂载在应用工厂内、文档插件之后。 */
function registerListProductsRoute (app: AppInstance): void {
  app.get('/api/products', {
    schema: {
      operationId: 'listProducts',
      tags: ['商品'],
      querystring: ListProductsQuery,
      response: {
        200: Type.Ref('ProductListResponse'),
        400: Type.Ref('ErrorResponse'),
        500: Type.Ref('ErrorResponse'),
        503: Type.Ref('ErrorResponse'),
      },
    },
    preValidation: trimKeyword,
  }, async (request) => {
    const query = request.query

    // 请求校验（400）先于服务不可用（503）：两者同时不满足时，先报可修正的那个。
    const { priceMinCents, priceMaxCents } = query
    if (priceMinCents !== undefined && priceMaxCents !== undefined && priceMinCents > priceMaxCents) {
      throw new AppError('VALIDATION_FAILED', '价格下限不能大于价格上限。', [
        { path: 'querystring/priceMinCents', message: '价格下限不能大于价格上限。' },
      ])
    }

    // TypeBoxValidatorCompiler 只做 Convert + Check，不应用 schema 的 default，
    // 所以这两处兜底不是死代码（见 docs/typebox-notes.md）。
    const page = query.page ?? 1
    const pageSize = query.pageSize ?? 8

    // 有无关键词分流（#21、C37）：trim 后为空串或纯空白时走 MySQL，行为与 Phase 3 一致。
    if (query.keyword !== undefined && query.keyword !== '') {
      return listProductsByKeyword(app, query, query.keyword, page, pageSize)
    }

    const sort: ProductListSort = query.sort ?? 'sales_desc'

    const { rows, total } = await selectProductListPage(app.db, {
      category: query.category,
      priceMinCents,
      priceMaxCents,
      minSales: query.minSales,
      sort,
      page,
      pageSize,
    })

    const items = rows.map((row) => {
      if (row.coverImage === null) {
        throw new Error(`商品 ${row.slug} 缺少封面图，列表无法渲染。`)
      }
      return toListItem(row, row, row.coverImage)
    })

    return {
      page,
      pageSize,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / pageSize),
      items,
    }
  })
}

/** 商品联想路由（#22）：参数校验先于搜索可用性判断。 */
function registerListSuggestionsRoute (app: AppInstance): void {
  app.get('/api/products/suggestions', {
    schema: {
      operationId: 'listSuggestions',
      tags: ['商品'],
      querystring: SuggestProductsQuery,
      response: {
        200: Type.Ref('ProductSuggestionsResponse'),
        400: Type.Ref('ErrorResponse'),
        500: Type.Ref('ErrorResponse'),
        503: Type.Ref('ErrorResponse'),
      },
    },
    preValidation: normalizeSuggestionQuery,
  }, async (request) => {
    // TypeBoxValidatorCompiler 只做 Convert + Check，不应用 schema 的 default，
    // 所以这里的兜底不是死代码（见 docs/typebox-notes.md）。
    const limit = request.query.limit ?? SUGGESTION_DEFAULT_LIMIT
    const result = await suggestProductHits(app, { prefix: request.query.q, limit })
    return { items: result.items }
  })
}

/**
 * 商品详情路由（D58）：一次返回详情页所需的全部数据。
 * 展示价、展示原价与售罄状态复用列表的派生查询（D49），不重写规则。
 */
function registerGetProductRoute (app: AppInstance): void {
  app.get('/api/products/:slug', {
    schema: {
      operationId: 'getProduct',
      tags: ['商品'],
      params: ProductSlugParams,
      response: {
        200: Type.Ref('ProductDetailResponse'),
        400: Type.Ref('ErrorResponse'),
        404: Type.Ref('ErrorResponse'),
        500: Type.Ref('ErrorResponse'),
      },
    },
  }, async (request) => {
    const { slug } = request.params

    const product = await selectProductDetail(app.db, slug)
    if (product === null) {
      throw new AppError('PRODUCT_NOT_FOUND', '商品不存在。')
    }

    const [summary] = await selectProductSummaries(app.db, { productIds: [product.productId] })
    if (summary === undefined) {
      // D49 不变量：每件商品至少有一个有效规格组合；缺摘要说明数据完整性被破坏。
      throw new Error(`商品 ${product.slug} 缺少规格组合摘要，详情无法渲染。`)
    }

    const [images, variants] = await Promise.all([
      selectProductImages(app.db, product.productId),
      selectProductVariants(app.db, product.productId),
    ])

    const [coverImage] = images
    if (coverImage === undefined) {
      // D67：封面图必填，无图属数据完整性异常。
      throw new Error(`商品 ${product.slug} 缺少封面图，详情无法渲染。`)
    }

    return {
      slug: product.slug,
      name: product.name,
      brand: product.brand,
      model: product.model,
      category: { slug: product.categorySlug, name: product.categoryName },
      displayPriceCents: yuanToCents(summary.displayPrice),
      displayOriginalPriceCents: yuanToCents(summary.displayOriginalPrice),
      soldOut: summary.soldOut,
      rating: product.rating,
      sales: product.sales,
      coverImage,
      // 商品级库存 = 全部有效规格组合库存之和（D67）。
      stock: variants.reduce((total, variant) => total + variant.stock, 0),
      images,
      dimensions: product.dimensions,
      variants: variants.map((variant) => ({
        sku: variant.sku,
        option1Value: variant.option1Value,
        option2Value: variant.option2Value,
        priceCents: yuanToCents(variant.price),
        originalPriceCents: yuanToCents(variant.originalPrice),
        stock: variant.stock,
      })),
      detail: product.detail,
    }
  })
}

/** 相关推荐路由（D58、D66）：最多 4 件，字段与列表项一致。 */
function registerListRecommendationsRoute (app: AppInstance): void {
  app.get('/api/products/:slug/recommendations', {
    schema: {
      operationId: 'listRecommendations',
      tags: ['商品'],
      params: ProductSlugParams,
      response: {
        200: Type.Ref('ProductRecommendationsResponse'),
        400: Type.Ref('ErrorResponse'),
        404: Type.Ref('ErrorResponse'),
        500: Type.Ref('ErrorResponse'),
      },
    },
  }, async (request) => {
    const { slug } = request.params

    const candidates = await selectProductRecommendations(app.db, slug, RECOMMENDATION_LIMIT)
    if (candidates === null) {
      throw new AppError('PRODUCT_NOT_FOUND', '商品不存在。')
    }

    const productIds = candidates.map((candidate) => candidate.productId)
    const [summaries, covers] = await Promise.all([
      selectProductSummaries(app.db, { productIds }),
      selectCoverImages(app.db, productIds),
    ])
    const summaryByProductId = new Map(
      summaries.map((summary) => [summary.productId, summary]),
    )

    const items = candidates.map((candidate) => {
      const summary = summaryByProductId.get(candidate.productId)
      if (summary === undefined) {
        // D49 不变量：每件商品至少有一个有效规格组合；缺摘要说明数据完整性被破坏。
        throw new Error(`商品 ${candidate.slug} 缺少规格组合摘要，相关推荐无法渲染。`)
      }
      const coverImage = covers.get(candidate.productId)
      if (coverImage === undefined) {
        // D67：封面图必填，无图属数据完整性异常。
        throw new Error(`商品 ${candidate.slug} 缺少封面图，相关推荐无法渲染。`)
      }

      return toListItem(candidate, summary, coverImage)
    })

    return { items }
  })
}

/** 商品路由（D58）：挂载在应用工厂内、文档插件之后。 */
export function registerProductRoutes (app: AppInstance): void {
  registerListProductsRoute(app)
  registerListSuggestionsRoute(app)
  registerGetProductRoute(app)
  registerListRecommendationsRoute(app)
}
