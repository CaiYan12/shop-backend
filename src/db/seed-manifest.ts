import { posix } from 'node:path'
import type { DetailBlock, DimensionMetadata } from './schema.ts'

/** 一张商品图片：路径为 /images/products/{slug}/n.webp 形式的相对路径（D48）。 */
export interface SeedImage {
  path: string
  alt: string
}

/** 一件待导入商品；图片顺序即展示顺序，sort_order 由数组下标派生。 */
export interface SeedProduct {
  slug: string
  name: string
  categorySlug: string
  brand: string
  model: string
  rating: number
  sales: number
  detail: DetailBlock[]
  dimensions: DimensionMetadata[]
  images: SeedImage[]
}

export interface SeedCategory {
  slug: string
  name: string
}

/** 一次导入的清单；未出现在清单里的商品与分类保留（D52）。 */
export interface SeedManifest {
  categories: SeedCategory[]
  products: SeedProduct[]
}

export class SeedValidationError extends Error {
  constructor (message: string) {
    super(message)
    this.name = 'SeedValidationError'
  }
}

/** slug 手工指定、小写连字符（D39）。 */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const IMAGE_FILE_NAME_PATTERN = /^[1-9]\d*\.webp$/

/** 商品图片目录：/images/products/{slug}/。 */
export function productImageDirectory (slug: string): string {
  return `/images/products/${slug}/`
}

/**
 * 校验并返回规范化后的图片路径（D48）：
 * 拒绝反斜杠与 .. 段，规范化后必须仍位于该商品目录内，文件名必须是 n.webp。
 */
export function normalizeProductImagePath (rawPath: string, slug: string): string {
  if (typeof rawPath !== 'string' || rawPath.trim() === '') {
    throw new SeedValidationError('图片路径不能为空')
  }
  if (rawPath.includes('\0')) {
    throw new SeedValidationError(`图片路径含空字符：${rawPath}`)
  }
  if (rawPath.includes('\\')) {
    throw new SeedValidationError(`图片路径必须使用 / 分隔：${rawPath}`)
  }
  if (rawPath.split('/').includes('..')) {
    throw new SeedValidationError(`图片路径不得包含 ..：${rawPath}`)
  }
  const normalized = posix.normalize(rawPath)
  if (normalized !== rawPath) {
    throw new SeedValidationError(`图片路径不是规范形式：${rawPath}`)
  }
  const directory = productImageDirectory(slug)
  if (!normalized.startsWith(directory)) {
    throw new SeedValidationError(`图片路径不在商品 ${slug} 的目录内：${rawPath}`)
  }
  const fileName = normalized.slice(directory.length)
  if (!IMAGE_FILE_NAME_PATTERN.test(fileName)) {
    throw new SeedValidationError(`图片文件名必须是 n.webp：${rawPath}`)
  }
  return normalized
}

function assertNonEmptyString (value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new SeedValidationError(`${label} 不能为空`)
  }
}

function assertSlug (value: unknown, label: string): asserts value is string {
  assertNonEmptyString(value, label)
  if (!SLUG_PATTERN.test(value)) {
    throw new SeedValidationError(`${label} 必须是小写字母、数字与连字符：${value}`)
  }
}

function validateDimensions (product: SeedProduct): void {
  const dimensions = product.dimensions
  if (!Array.isArray(dimensions) || dimensions.length !== 2) {
    throw new SeedValidationError(`商品 ${product.slug} 必须恰好声明两个规格维度`)
  }
  const names = new Set<string>()
  for (const dimension of dimensions) {
    assertNonEmptyString(dimension.name, `商品 ${product.slug} 的规格维度名`)
    if (dimension.name !== dimension.name.trim()) {
      throw new SeedValidationError(`商品 ${product.slug} 的规格维度名不得有首尾空白：${dimension.name}`)
    }
    if (names.has(dimension.name)) {
      throw new SeedValidationError(`商品 ${product.slug} 的规格维度名重复：${dimension.name}`)
    }
    names.add(dimension.name)

    if (!Array.isArray(dimension.options) || dimension.options.length < 2) {
      throw new SeedValidationError(`商品 ${product.slug} 的规格维度 ${dimension.name} 至少需要两个选项`)
    }
    const options = new Set<string>()
    for (const option of dimension.options) {
      assertNonEmptyString(option, `商品 ${product.slug} 的规格选项`)
      if (option !== option.trim()) {
        throw new SeedValidationError(`商品 ${product.slug} 的规格选项不得有首尾空白：${option}`)
      }
      if (options.has(option)) {
        throw new SeedValidationError(`商品 ${product.slug} 的规格选项重复：${option}`)
      }
      options.add(option)
    }
  }
}

function validateDetail (product: SeedProduct): void {
  if (!Array.isArray(product.detail) || product.detail.length === 0) {
    throw new SeedValidationError(`商品 ${product.slug} 的详情块不能为空`)
  }
  for (const block of product.detail) {
    if (block.type === 'text') {
      assertNonEmptyString(block.text, `商品 ${product.slug} 的文本详情块`)
    } else if (block.type === 'image') {
      normalizeProductImagePath(block.path, product.slug)
      assertNonEmptyString(block.alt, `商品 ${product.slug} 的详情图片 alt`)
    } else {
      throw new SeedValidationError(`商品 ${product.slug} 的详情块类型未知：${String((block as { type?: unknown }).type)}`)
    }
  }
}

function validateImages (product: SeedProduct): void {
  if (!Array.isArray(product.images) || product.images.length < 4) {
    throw new SeedValidationError(`商品 ${product.slug} 至少需要 4 张图片`)
  }
  const paths = new Set<string>()
  for (const image of product.images) {
    const normalized = normalizeProductImagePath(image.path, product.slug)
    if (paths.has(normalized)) {
      throw new SeedValidationError(`商品 ${product.slug} 的图片路径重复：${normalized}`)
    }
    paths.add(normalized)
    assertNonEmptyString(image.alt, `商品 ${product.slug} 的图片 alt`)
  }
}

/** 导入前校验整份清单；失败时不触碰数据库。 */
export function validateManifest (manifest: SeedManifest): void {
  if (manifest === null || typeof manifest !== 'object') {
    throw new SeedValidationError('种子清单必须是对象')
  }
  if (!Array.isArray(manifest.categories) || manifest.categories.length === 0) {
    throw new SeedValidationError('种子清单的商品类型不能为空')
  }
  if (!Array.isArray(manifest.products) || manifest.products.length === 0) {
    throw new SeedValidationError('种子清单的商品不能为空')
  }

  const categorySlugs = new Set<string>()
  for (const category of manifest.categories) {
    assertSlug(category.slug, '商品类型 slug')
    if (categorySlugs.has(category.slug)) {
      throw new SeedValidationError(`商品类型 slug 重复：${category.slug}`)
    }
    categorySlugs.add(category.slug)
    assertNonEmptyString(category.name, `商品类型 ${category.slug} 的 name`)
  }

  const productSlugs = new Set<string>()
  for (const product of manifest.products) {
    assertSlug(product.slug, '商品 slug')
    if (productSlugs.has(product.slug)) {
      throw new SeedValidationError(`商品 slug 重复：${product.slug}`)
    }
    productSlugs.add(product.slug)

    assertNonEmptyString(product.name, `商品 ${product.slug} 的 name`)
    assertNonEmptyString(product.categorySlug, `商品 ${product.slug} 的 categorySlug`)
    assertNonEmptyString(product.brand, `商品 ${product.slug} 的 brand`)
    assertNonEmptyString(product.model, `商品 ${product.slug} 的 model`)

    if (typeof product.rating !== 'number' || !Number.isFinite(product.rating) || product.rating < 0 || product.rating > 5) {
      throw new SeedValidationError(`商品 ${product.slug} 的评分必须是 0–5 的数字`)
    }
    if (!Number.isInteger(product.sales) || product.sales < 0) {
      throw new SeedValidationError(`商品 ${product.slug} 的销量必须是非负整数`)
    }

    validateDimensions(product)
    validateDetail(product)
    validateImages(product)
  }
}
