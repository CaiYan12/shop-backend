import type { FastifyRequest } from 'fastify'
import { Type } from 'typebox'
import type { AppInstance } from '../app.ts'
import { selectProductListPage, type ProductListSort } from '../db/product-list.ts'
import { AppError } from '../errors.ts'
import { yuanToCents } from '../money.ts'

/** 列表查询参数（D61、D68）；未提供的筛选条件表示不限。 */
const ListProductsQuery = Type.Object({
  category: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  priceMinCents: Type.Optional(Type.Integer({ minimum: 0, maximum: 9_999_999_999 })),
  priceMaxCents: Type.Optional(Type.Integer({ minimum: 0, maximum: 9_999_999_999 })),
  minSales: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_000_000 })),
  keyword: Type.Optional(Type.String({ maxLength: 100 })),
  sort: Type.Optional(Type.Union([
    Type.Literal('price_asc'),
    Type.Literal('price_desc'),
    Type.Literal('sales_desc'),
  ], { default: 'sales_desc' })),
  page: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 1 })),
  pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 8 })),
})

/** 列表项字段集（D67）：金额一律整数分，封面图必填。 */
const ProductCoverImage = Type.Object({
  path: Type.String(),
  alt: Type.String(),
}, { $id: 'ProductCoverImage' })

const ProductCategory = Type.Object({
  slug: Type.String(),
  name: Type.String(),
}, { $id: 'ProductCategory' })

const ProductListItem = Type.Object({
  slug: Type.String(),
  name: Type.String(),
  brand: Type.String(),
  model: Type.String(),
  category: Type.Ref('ProductCategory'),
  displayPriceCents: Type.Integer(),
  displayOriginalPriceCents: Type.Integer(),
  soldOut: Type.Boolean(),
  rating: Type.Number(),
  sales: Type.Integer(),
  coverImage: Type.Ref('ProductCoverImage'),
}, { $id: 'ProductListItem' })

const ProductListResponse = Type.Object({
  page: Type.Integer(),
  pageSize: Type.Integer(),
  total: Type.Integer(),
  totalPages: Type.Integer(),
  items: Type.Array(Type.Ref('ProductListItem')),
}, { $id: 'ProductListResponse' })

/** 关键词先 trim（D69）：空白串按无关键词处理，长度校验作用在 trim 之后。 */
async function trimKeyword (request: FastifyRequest): Promise<void> {
  const query = request.query as { keyword?: string }
  if (typeof query.keyword === 'string') {
    query.keyword = query.keyword.trim()
  }
}

/** 商品列表路由（D58）：挂载在应用工厂内、文档插件之后。 */
export function registerProductRoutes (app: AppInstance): void {
  app.addSchema(ProductCoverImage)
  app.addSchema(ProductCategory)
  app.addSchema(ProductListItem)
  app.addSchema(ProductListResponse)

  app.get('/api/products', {
    schema: {
      operationId: 'listProducts',
      tags: ['商品'],
      querystring: ListProductsQuery,
      response: {
        200: Type.Ref('ProductListResponse'),
      },
    },
    preValidation: trimKeyword,
  }, async (request) => {
    const query = request.query

    // Phase 3 关键词搜索尚未接入（D69）：非空关键词明确返回 503。
    if (query.keyword !== undefined && query.keyword !== '') {
      throw new AppError('SEARCH_NOT_AVAILABLE', '关键词搜索尚未接入。')
    }

    const { priceMinCents, priceMaxCents } = query
    if (priceMinCents !== undefined && priceMaxCents !== undefined && priceMinCents > priceMaxCents) {
      throw new AppError('VALIDATION_FAILED', '价格下限不能大于价格上限。', [
        { path: 'querystring/priceMinCents', message: '价格下限不能大于价格上限。' },
      ])
    }

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
      return {
        slug: row.slug,
        name: row.name,
        brand: row.brand,
        model: row.model,
        category: { slug: row.categorySlug, name: row.categoryName },
        displayPriceCents: yuanToCents(row.displayPrice),
        displayOriginalPriceCents: yuanToCents(row.displayOriginalPrice),
        soldOut: row.soldOut,
        rating: row.rating,
        sales: row.sales,
        coverImage: row.coverImage,
      }
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
