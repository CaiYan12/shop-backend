import { Type } from 'typebox'
import type { AppInstance } from '../app.ts'
import { SLUG_PATTERN } from '../db/seed-manifest.ts'

/**
 * 商品相关的共享 schema（D67）：列表与详情都从这里引用，
 * 避免同一 `$id` 被两处各定义一份。
 */

/** 封面图：列表卡片与详情轮播图同形，都是路径 + 替代文本。 */
export const ProductCoverImage = Type.Object({
  path: Type.String(),
  alt: Type.String(),
}, { $id: 'ProductCoverImage' })

/** 商品类型：只返 slug 与 name（D67）。 */
export const ProductCategory = Type.Object({
  slug: Type.String(),
  name: Type.String(),
}, { $id: 'ProductCategory' })

/**
 * 列表项字段集（D67）。详情在它之上追加字段，因此字段定义只写一份，
 * 由 `ProductListItem` 与 `ProductDetailResponse` 共用。
 */
const ProductListItemProperties = {
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
}

export const ProductListItem = Type.Object(ProductListItemProperties, { $id: 'ProductListItem' })

/** 列表响应（D60）：页码式分页，`total` 为 0 时 `totalPages` 也为 0。 */
export const ProductListResponse = Type.Object({
  page: Type.Integer(),
  pageSize: Type.Integer(),
  total: Type.Integer(),
  totalPages: Type.Integer(),
  items: Type.Array(Type.Ref('ProductListItem')),
}, { $id: 'ProductListResponse' })

/** 规格维度（D40）：保持商品声明的顺序，规格组合的选项值按此顺序解释。 */
export const ProductDimension = Type.Object({
  name: Type.String(),
  options: Type.Array(Type.String()),
}, { $id: 'ProductDimension' })

/** 规格组合（D40、D43）：金额一律整数分（D59）。 */
export const ProductVariant = Type.Object({
  sku: Type.String(),
  option1Value: Type.String(),
  option2Value: Type.String(),
  priceCents: Type.Integer(),
  originalPriceCents: Type.Integer(),
  stock: Type.Integer(),
}, { $id: 'ProductVariant' })

/** 图文详情块（D47）：文本与图片两型，保持存储顺序。 */
export const ProductDetailBlock = Type.Union([
  Type.Object({
    type: Type.Literal('text'),
    text: Type.String(),
  }),
  Type.Object({
    type: Type.Literal('image'),
    path: Type.String(),
    alt: Type.String(),
  }),
], { $id: 'ProductDetailBlock' })

/** 详情响应（D67）：列表项字段 + 商品级库存 + 图片 + 规格维度 + 规格组合 + 图文详情。 */
export const ProductDetailResponse = Type.Object({
  ...ProductListItemProperties,
  stock: Type.Integer(),
  images: Type.Array(Type.Ref('ProductCoverImage')),
  dimensions: Type.Array(Type.Ref('ProductDimension')),
  variants: Type.Array(Type.Ref('ProductVariant')),
  detail: Type.Array(Type.Ref('ProductDetailBlock')),
}, { $id: 'ProductDetailResponse' })

/** 详情路径参数（D39）：slug 为小写字母、数字与连字符，与种子清单同一规则。 */
export const ProductSlugParams = Type.Object({
  slug: Type.String({
    minLength: 1,
    maxLength: 64,
    pattern: SLUG_PATTERN.source,
  }),
})

/**
 * 注册共享 schema：同一 `$id` 只能注册一次（Fastify 重复注册会拒绝），
 * 因此由应用工厂统一调用，路由模块只引用。
 */
export function registerProductSchemas (app: AppInstance): void {
  app.addSchema(ProductCoverImage)
  app.addSchema(ProductCategory)
  app.addSchema(ProductListItem)
  app.addSchema(ProductListResponse)
  app.addSchema(ProductDimension)
  app.addSchema(ProductVariant)
  app.addSchema(ProductDetailBlock)
  app.addSchema(ProductDetailResponse)
}
