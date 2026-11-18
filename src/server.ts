import type { Pool } from 'mysql2/promise'
import { createApp, type AppInstance } from './app.ts'
import { describeConfig, loadConfig, type AppConfig } from './config.ts'
import { createDb, createPool } from './db/client.ts'
import { runIfMain } from './run-if-main.ts'
import {
  createElasticsearchClient,
  ElasticsearchProductSearchAdapter,
} from './search/elasticsearch-adapter.ts'
import type { ProductSearchAdapter } from './search/product-search.ts'

/**
 * 在线搜索的请求超时（V19 待实测）：显式 3 s、不自动重试。
 * 与重建客户端分开取超时：重建一次 bulk 允许 30 s，在线查询不能等那么久。
 */
const SEARCH_REQUEST_TIMEOUT_MS = 3_000

export interface StartServerOptions {
  /** 已解析的配置；省略时读取 .env 与进程环境变量。 */
  config?: AppConfig
  /** 连接池工厂；默认 createPool。测试注入以观察监听失败时的关闭行为。 */
  createPool?: (config: AppConfig) => Pool
  /** 搜索能力端口；省略时装配真实 Elasticsearch 适配器（#21）。 */
  search?: ProductSearchAdapter
  /** 是否输出请求日志；默认开启。 */
  logger?: boolean
}

export interface StartedServer {
  app: AppInstance
  /** 本次启动创建的连接池；关闭责任归调用方。 */
  pool: Pool
  address: string
}

/**
 * 启动入口：创建连接池 → 构建应用 → 监听。
 * 监听失败时关闭应用与连接池，并把原始错误抛给调用方以非零码退出。
 */
export async function startServer (options: StartServerOptions = {}): Promise<StartedServer> {
  const config = options.config ?? loadConfig()
  const pool = (options.createPool ?? createPool)(config)
  const search = options.search ?? new ElasticsearchProductSearchAdapter(
    createElasticsearchClient({ node: config.esUrl, requestTimeout: SEARCH_REQUEST_TIMEOUT_MS }),
  )
  const app = await createApp({
    db: createDb(pool),
    config,
    search,
    logger: options.logger ?? true,
  })

  try {
    const address = await app.listen({ port: config.port, host: '127.0.0.1' })
    return { app, pool, address }
  } catch (error) {
    try {
      await app.close()
    } catch {
      // 监听失败时应用可能已部分关闭；以原始监听错误为准。
    }
    await pool.end()
    throw error
  }
}

async function main (): Promise<void> {
  const config = loadConfig()
  const { app, address } = await startServer({ config })
  app.log.info(`[config] ${describeConfig(config)}`)
  app.log.info(`[server] 实际监听 ${address}`)
}

await runIfMain(import.meta.url, async () => {
  try {
    await main()
  } catch (error) {
    console.error('[server] 启动失败：', error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
})
