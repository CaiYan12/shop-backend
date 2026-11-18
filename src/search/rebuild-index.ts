import { loadConfig } from '../config.ts'
import { createDb, createPool } from '../db/client.ts'
import { runIfMain } from '../run-if-main.ts'
import {
  createElasticsearchClient,
  ElasticsearchProductIndexAdapter,
} from './elasticsearch-adapter.ts'
import { rebuildProductIndex, type RebuildStageTiming } from './index-rebuild.ts'
import { loadProductSnapshot } from './product-snapshot.ts'

function printTimings (timings: RebuildStageTiming[]): void {
  const width = Math.max(...timings.map((timing) => timing.stage.length), 6)
  console.log('[es:rebuild] 阶段耗时：')
  for (const timing of timings) {
    console.log(`  ${timing.stage.padEnd(width)} ${String(timing.ms).padStart(6)} ms`)
  }
}

async function main (): Promise<void> {
  const config = loadConfig()
  const pool = createPool(config)
  const client = createElasticsearchClient({ node: config.esUrl })

  try {
    const db = createDb(pool)
    const adapter = new ElasticsearchProductIndexAdapter(client)
    console.log(`[es:rebuild] 目标：${config.esUrl}，别名 products`)

    const result = await rebuildProductIndex(adapter, {
      loadSnapshot: () => loadProductSnapshot(db),
      log: (line) => console.log(line),
    })

    console.log('')
    console.log(
      `[es:rebuild] 完成：${result.index}，文档 ${result.documentCount} 件，总耗时 ${result.totalMs} ms`,
    )
    printTimings(result.timings)
    if (result.deletedIndices.length > 0) {
      console.log(`[es:rebuild] 已删除旧索引：${result.deletedIndices.join('、')}`)
    }
    for (const warning of result.cleanupWarnings) {
      console.warn(`[es:rebuild] 清理提示：${warning}`)
    }
  } finally {
    await client.close()
    await pool.end()
  }
}

await runIfMain(import.meta.url, async () => {
  try {
    await main()
  } catch (error) {
    console.error('[es:rebuild] 失败：', error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
})
