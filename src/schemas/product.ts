import { Type } from 'typebox'
import type { AppInstance } from '../app.ts'
import { SLUG_PATTERN } from '../db/seed-manifest.ts'
import { ERROR_CODES } from '../errors.ts'

/**
 * 商品相关的共享 schema（D67）：列表与详情都从这里引用，
 * 避免同一 `$id` 被两处各定义一份。
 */

/**
 * 统一错误信封（D62）：`code` 只允许七个业务码，`details` 元素固定为 `{ path, message }`。
 * 路由的错误响应统一引用这个组件，契约里不再只有 200。
 */
export const ErrorResponse = Type.Object({
  error: Type.Object({
    code: Type.Enum(ERROR_CODES),
    message: Type.String(),
    details: Type.Optional(Type.Array(Type.Object({
      path: Type.String(),
      message: Type.String(),
    }))),
  }),
}, { $id: 'ErrorResponse' })

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

/** 商品类型列表项（D67）：只返 slug 与 name，不返商品数量等未确认字段。 */
export const CategoryListItem = Type.Object({
  slug: Type.String(),
  name: Type.String(),
}, { $id: 'CategoryListItem' })

/** 商品类型响应（D58、D67）：非分页集合统一带 `items`。 */
export const CategoriesResponse = Type.Object({
  items: Type.Array(Type.Ref('CategoryListItem')),
}, { $id: 'CategoriesResponse' })

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

/** 相关推荐响应（D66）：最多 4 件，字段与列表项一致；非分页集合统一带 `items`。 */
export const ProductRecommendationsResponse = Type.Object({
  items: Type.Array(Type.Ref('ProductListItem')),
}, { $id: 'ProductRecommendationsResponse' })

/** 商品联想条目（#22）：只用索引里已有的稳定标识与展示文本，本票不含高亮（#23）。 */
export const ProductSuggestionItem = Type.Object({
  slug: Type.String(),
  name: Type.String(),
  brand: Type.String(),
}, { $id: 'ProductSuggestionItem' })

/** 商品联想响应（#22）：最多 limit 条；非分页集合统一带 `items`。 */
export const ProductSuggestionsResponse = Type.Object({
  items: Type.Array(Type.Ref('ProductSuggestionItem')),
}, { $id: 'ProductSuggestionsResponse' })

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
 * 购买校验请求（D63、D68）：单件商品的所选规格组合与数量；
 * 预期单价可选，未提供表示本次不做价格确认。
 */
export const PurchaseCheckBody = Type.Object({
  slug: Type.String({ minLength: 1, maxLength: 64, pattern: SLUG_PATTERN.source }),
  sku: Type.String({ minLength: 1, maxLength: 64 }),
  quantity: Type.Integer({ minimum: 1, maximum: 999 }),
  expectedUnitPriceCents: Type.Optional(Type.Integer({ minimum: 0, maximum: 9_999_999_999 })),
})

/** 购买校验回显的商品标识（D63）。 */
export const PurchaseCheckProduct = Type.Object({
  slug: Type.String(),
  name: Type.String(),
}, { $id: 'PurchaseCheckProduct' })

/** 购买校验回显的规格组合标识（D63）。 */
export const PurchaseCheckVariant = Type.Object({
  sku: Type.String(),
  option1Value: Type.String(),
  option2Value: Type.String(),
}, { $id: 'PurchaseCheckVariant' })

/** 三分支共同字段（D63）：商品、规格组合、数量、单价、小计与库存。 */
const PurchaseCheckCommonProperties = {
  product: Type.Ref('PurchaseCheckProduct'),
  variant: Type.Ref('PurchaseCheckVariant'),
  quantity: Type.Integer(),
  unitPriceCents: Type.Integer(),
  subtotalCents: Type.Integer(),
  stock: Type.Integer(),
}

/** 可购买分支（D63）：价格未变化，`priceChanged` 恒为 false。 */
const PurchaseCheckPurchasable = Type.Object({
  result: Type.Literal('purchasable'),
  ...PurchaseCheckCommonProperties,
  priceChanged: Type.Literal(false),
})

/** 库存不足分支（D63）：库存不足优先作原因；`priceChanged` 独立布尔，可与原因同时为真。 */
const PurchaseCheckBlockedInsufficientStock = Type.Object({
  result: Type.Literal('blocked'),
  reason: Type.Literal('INSUFFICIENT_STOCK'),
  ...PurchaseCheckCommonProperties,
  priceChanged: Type.Boolean(),
})

/** 价格变化分支（D63）：必带请求价，`priceChanged` 恒为 true。 */
const PurchaseCheckBlockedPriceChanged = Type.Object({
  result: Type.Literal('blocked'),
  reason: Type.Literal('PRICE_CHANGED'),
  ...PurchaseCheckCommonProperties,
  priceChanged: Type.Literal(true),
  requestedUnitPriceCents: Type.Integer(),
})

/**
 * 购买校验响应（D63）：三分支以 `anyOf` + `const` 组成可穷尽联合（V18），
 * 前端对 `result`（必要时连同 `reason`）写穷尽检查。
 */
export const PurchaseCheckResponse = Type.Union([
  PurchaseCheckPurchasable,
  PurchaseCheckBlockedInsufficientStock,
  PurchaseCheckBlockedPriceChanged,
], { $id: 'PurchaseCheckResponse' })

/**
 * 注册共享 schema：同一 `$id` 只能注册一次（Fastify 重复注册会拒绝），
 * 因此由应用工厂统一调用，路由模块只引用。
 */
export function registerProductSchemas (app: AppInstance): void {
  app.addSchema(ErrorResponse)
  app.addSchema(ProductCoverImage)
  app.addSchema(ProductCategory)
  app.addSchema(CategoryListItem)
  app.addSchema(CategoriesResponse)
  app.addSchema(ProductListItem)
  app.addSchema(ProductListResponse)
  app.addSchema(ProductRecommendationsResponse)
  app.addSchema(ProductSuggestionItem)
  app.addSchema(ProductSuggestionsResponse)
  app.addSchema(ProductDimension)
  app.addSchema(ProductVariant)
  app.addSchema(ProductDetailBlock)
  app.addSchema(ProductDetailResponse)
  app.addSchema(PurchaseCheckProduct)
  app.addSchema(PurchaseCheckVariant)
  app.addSchema(PurchaseCheckResponse)
}
