import { writeFileSync } from 'node:fs'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'
import { createDb, createPool } from './db/client.ts'
import { OPENAPI_FILE, serializeOpenApiDocument } from './openapi.ts'
import { runIfMain } from './run-if-main.ts'

/**
 * 生成可提交的 OpenAPI 契约产物（D64）：构建应用 → `ready()` → `swagger()` → 写出文件。
 *
 * 只读配置与连接池句柄，不监听端口、不查询数据库，因此不需要数据库在线；
 * 连接池与配置的归属仍按应用工厂约定由调用方创建与关闭。
 */
async function generateOpenApi (): Promise<{ file: string, pathCount: number }> {
  const config = loadConfig()
  const pool = createPool(config)
  const app = await createApp({ db: createDb(pool), config })

  try {
    await app.ready()
    const document = app.swagger()
    writeFileSync(OPENAPI_FILE, serializeOpenApiDocument(document), 'utf8')
    return { file: OPENAPI_FILE, pathCount: Object.keys(document.paths ?? {}).length }
  } finally {
    await app.close()
    await pool.end()
  }
}

await runIfMain(import.meta.url, async () => {
  try {
    const { file, pathCount } = await generateOpenApi()
    console.log(`[openapi] 已写出 ${file}（${pathCount} 个业务路径）`)
  } catch (error) {
    console.error('[openapi] 生成失败：', error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
})
