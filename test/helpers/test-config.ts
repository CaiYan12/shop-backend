import { loadConfig, type AppConfig } from '../../src/config.ts'

export const TEST_DB_NAME = 'shop_homework_test'

/** 测试统一指向 shop_homework_test；其余参数与迁移、种子、服务读同一份 .env。 */
export function loadTestConfig (): AppConfig {
  const config = loadConfig()
  return { ...config, db: { ...config.db, database: TEST_DB_NAME } }
}
