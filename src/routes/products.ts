import type { FastifyRequest } from 'fastify'
import { Type } from 'typebox'
import type { AppInstance } from '../app.ts'
import {
  selectProductDetail,
  selectProductImages,
  selectProductVariants,
} from '../db/product-detail.ts'
import { selectCoverImages, selectProductListPage, PRODUCT_LIST_SORTS, type ProductListSort } from '../db/product-list.ts'
import { selectProductRecommendations } from '../db/product-recommendations.ts'
import { selectProductSummaries } from '../db/product-summary.ts'
import { AppError } from '../errors.ts'
import { yuanToCents } from '../money.ts'
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

/** 关键词先 trim（D69）：空白串按无关键词处理，长度校验作用在 trim 之后。 */
async function trimKeyword (request: FastifyRequest): Promise<void> {
  const query = request.query as { keyword?: string }
  if (typeof query.keyword === 'string') {
    query.keyword = query.keyword.trim()
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

    // Phase 3 关键词搜索尚未接入（D69）：非空关键词明确返回 503。
    if (query.keyword !== undefined && query.keyword !== '') {
      throw new AppError('SEARCH_NOT_AVAILABLE', '关键词搜索尚未接入。')
    }

    // TypeBoxValidatorCompiler 只做 Convert + Check，不应用 schema 的 default，
    // 所以这三处兜底不是死代码（见 docs/typebox-notes.md）。
    const sort: ProductListSort = query.sort ?? 'sales_desc'
    const page = query.page ?? 1
    const pageSize = query.pageSize ?? 8

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
  registerGetProductRoute(app)
  registerListRecommendationsRoute(app)
}
