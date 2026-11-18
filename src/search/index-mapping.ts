/**
 * 商品索引的固定定义（D74、ADR 0003）。
 *
 * 物理索引按版本命名（products_vN），对外只暴露别名 products；
 * 重建脚本、适配器与测试共用这一份常量和命名函数，避免映射各写一套。
 */

/** 对外别名：所有搜索请求只认它，不直接指向物理索引。 */
export const PRODUCTS_ALIAS = 'products'

/** 物理索引前缀；完整名称为 products_v1、products_v2… */
export const PRODUCT_INDEX_PREFIX = 'products_v'

export interface ProductIndexFieldDefinition {
  type: string
  analyzer?: string
}

export interface ProductIndexDefinition {
  settings: {
    number_of_shards: number
    number_of_replicas: number
  }
  mappings: {
    properties: Record<string, ProductIndexFieldDefinition>
  }
}

/**
 * 映射按 D74：
 * - 检索文本 name / brand / model 用 search_as_you_type + smartcn，同时支撑关键词与联想；
 * - categoryName 用 text + smartcn，只参与检索；
 * - slug / categorySlug 用 keyword，做精确过滤；
 * - productId / sales 用 integer；
 * - displayPriceCents 用 long：上限 9,999,999,999 分超过 integer 的 2,147,483,647。
 * 1 主分片、0 副本，本地单节点即可全部分配。
 */
export const PRODUCT_INDEX_DEFINITION: ProductIndexDefinition = {
  settings: {
    number_of_shards: 1,
    number_of_replicas: 0,
  },
  mappings: {
    properties: {
      productId: { type: 'integer' },
      slug: { type: 'keyword' },
      name: { type: 'search_as_you_type', analyzer: 'smartcn' },
      brand: { type: 'search_as_you_type', analyzer: 'smartcn' },
      model: { type: 'search_as_you_type', analyzer: 'smartcn' },
      categoryName: { type: 'text', analyzer: 'smartcn' },
      categorySlug: { type: 'keyword' },
      sales: { type: 'integer' },
      displayPriceCents: { type: 'long' },
    },
  },
}

/** 由版本号生成物理索引名；版本从 1 开始。 */
export function productIndexName (version: number): string {
  if (!Number.isInteger(version) || version < 1) {
    throw new Error('物理索引版本必须是正整数。')
  }
  return `${PRODUCT_INDEX_PREFIX}${version}`
}

/** 从物理索引名解析版本；不是 products_vN 形状时返回 null。 */
export function productIndexVersion (index: string): number | null {
  const match = new RegExp(`^${PRODUCT_INDEX_PREFIX}(\\d+)$`).exec(index)
  if (match === null) return null
  const version = Number(match[1])
  return Number.isInteger(version) && version >= 1 ? version : null
}
