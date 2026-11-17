import { Type } from 'typebox'
import type { AppInstance } from '../app.ts'
import { selectCategories } from '../db/category-list.ts'

/** 商品类型路由（D58）：供列表页筛选使用，只返 slug 与 name（D67）。 */
export function registerCategoryRoutes (app: AppInstance): void {
  app.get('/api/categories', {
    schema: {
      operationId: 'listCategories',
      tags: ['商品类型'],
      response: {
        200: Type.Ref('CategoriesResponse'),
      },
    },
  }, async () => {
    return { items: await selectCategories(app.db) }
  })
}
