/**
 * 接口测试共享的响应形状：列表项与统一错误信封在多个测试文件里重复声明，
 * 这里只写一份，断言仍落在各接口自己的测试里。
 */

/** 列表项（D67）：列表与相关推荐共用同一字段集。 */
export interface ListItem {
  slug: string
  name: string
  brand: string
  model: string
  category: { slug: string, name: string }
  displayPriceCents: number
  displayOriginalPriceCents: number
  soldOut: boolean
  rating: number
  sales: number
  coverImage: { path: string, alt: string }
}

/** 统一错误信封（D62）：测试只关心 code / message / details。 */
export interface ErrorBody {
  error: {
    code: string
    message: string
    details?: Array<{ path: string, message: string }>
  }
}
