import { createServer } from 'node:net'

/**
 * 取一个当前空闲的本机回环端口。
 * 互斥测试用它避开固定端口，避免与同机其它服务或并行用例冲突。
 * 取到后立即关闭探测用监听，真正的互斥绑定由 acquireRebuildLock 完成。
 */
export async function freePort (): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => {
        if (port > 0) resolve(port)
        else reject(new Error('未能取得空闲端口。'))
      })
    })
  })
}
