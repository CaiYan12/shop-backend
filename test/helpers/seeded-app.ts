import type { Pool } from 'mysql2/promise'
import { createApp, type AppInstance } from '../../src/app.ts'
import { createDb, createPool, type Database } from '../../src/db/client.ts'
import { runMigrations } from '../../src/db/migrate.ts'
import { seedDatabase } from '../../src/db/seed.ts'
import type { ProductSearchAdapter } from '../../src/search/product-search.ts'
import type { SearchCooldownOptions } from '../../src/search/search-cooldown.ts'
import { FakeProductSearchAdapter } from './fake-search-adapter.ts'
import { loadTestConfig } from './test-config.ts'

/**
 * 集成测试共用的「迁移 + 种子 + 应用工厂」生命周期。
 * 各接口测试文件原本各写一份 before/after，逻辑只在这里维护。
 */
export interface SeededApp {
  pool: Pool
  db: Database
  app: AppInstance
  /** 本次应用工厂装配的搜索端口；默认是记录型假实现，关键词用例可自行断言或替换行为。 */
  search: ProductSearchAdapter
}

export interface CreateSeededAppOptions {
  /** 搜索端口；缺省注入假实现，因此默认套件不依赖 Elasticsearch。 */
  search?: ProductSearchAdapter
  /** 搜索降级冷却（#24）：窗口长度与时钟；缺省用生产默认（5 s + Date.now）。 */
  searchCooldown?: SearchCooldownOptions
}

/**
 * 创建连接池、跑迁移与种子、构建并 ready 应用。
 * 中途失败时关闭连接池，避免测试进程留下悬挂连接。
 */
export async function createSeededApp (options: CreateSeededAppOptions = {}): Promise<SeededApp> {
  const config = loadTestConfig()
  const pool = createPool(config)
  const search = options.search ?? new FakeProductSearchAdapter()

  try {
    const db = createDb(pool)
    await runMigrations(db)
    await seedDatabase(db)
    const app = await createApp({ db, config, search, searchCooldown: options.searchCooldown })
    await app.ready()
    return { pool, db, app, search }
  } catch (error) {
    await pool.end()
    throw error
  }
}

/** 关闭应用与连接池：顺序与创建相反，应用先关。 */
export async function closeSeededApp ({ pool, app }: Pick<SeededApp, 'pool' | 'app'>): Promise<void> {
  await app.close()
  await pool.end()
}
