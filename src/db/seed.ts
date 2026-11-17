import { describeConfig, loadConfig } from '../config.ts'
import { createPool } from './client.ts'

/**
 * 种子入口骨架（T1）：与迁移、服务共用 src/config.ts 的同一份配置。
 * 商品、图片与规格组合的导入在 T2 / T3 实现。
 */
const config = loadConfig()
console.log(`[seed] 目标：${describeConfig(config)}`)

const pool = createPool(config)
try {
  await pool.query('SELECT 1')
  console.log('[seed] 连接成功；种子数据导入在 T2 实现。')
} finally {
  await pool.end()
}
