import { pathToFileURL } from 'node:url'

/**
 * CLI 入口守卫：仅当模块被直接执行（而非被 import）时运行主函数。
 *
 * 必须传入调用方的 import.meta.url：本模块自身的 URL 无法代表调用方。
 */
export async function runIfMain (moduleUrl: string, main: () => Promise<void>): Promise<void> {
  const entry = process.argv[1]
  if (entry === undefined || moduleUrl !== pathToFileURL(entry).href) return
  await main()
}
