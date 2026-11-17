import { asc } from 'drizzle-orm'
import type { Database } from './client.ts'
import { categories } from './schema.ts'

/** 商品类型列表项（D67）：只返 slug 与 name，不返商品数量等未确认字段。 */
export interface CategoryListItem {
  slug: string
  name: string
}

/** 全部商品类型，按 id 升序（D67）：顺序稳定，与 slug、name 的字典序无关。 */
export async function selectCategories (db: Database): Promise<CategoryListItem[]> {
  return db
    .select({
      slug: categories.slug,
      name: categories.name,
    })
    .from(categories)
    .orderBy(asc(categories.id))
}
