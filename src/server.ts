import Fastify from 'fastify'
import { TypeBoxValidatorCompiler } from '@fastify/type-provider-typebox'
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import { Type } from 'typebox'
import { describeConfig, loadConfig } from './config.ts'

/**
 * Phase 1 的 V7 夹具：验证 TypeBox 1.x + provider 6 的类型推导与运行时校验。
 * 正式契约（列表 / 详情 / 推荐 / 购买校验）在 Phase 3 建立，见 C37–C38。
 */
const Product = Type.Object({
  id: Type.Integer(),
  name: Type.String(),
  price: Type.Number(),
})

const app = Fastify({ logger: true })
  .setValidatorCompiler(TypeBoxValidatorCompiler)
  .withTypeProvider<TypeBoxTypeProvider>()

app.get('/health', {
  schema: {
    response: {
      200: Type.Object({
        status: Type.String(),
      }),
    },
  },
}, async () => ({ status: 'ok' }))

app.get('/api/products', {
  schema: {
    querystring: Type.Object({
      page: Type.Optional(Type.Integer({ minimum: 1 })),
      pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
      keyword: Type.Optional(Type.String({ maxLength: 100 })),
    }),
    response: {
      200: Type.Object({
        page: Type.Integer(),
        pageSize: Type.Integer(),
        keyword: Type.Optional(Type.String()),
        items: Type.Array(Product),
      }),
    },
  },
}, async (request) => {
  const { page = 1, pageSize = 8, keyword } = request.query
  return {
    page,
    pageSize,
    ...(keyword === undefined ? {} : { keyword }),
    items: [],
  }
})

// 配置优先级：进程环境变量 > .env > 程序默认（D53）。
const config = loadConfig()
app.log.info(`[config] ${describeConfig(config)}`)

const address = await app.listen({ port: config.port, host: '127.0.0.1' })
app.log.info(`[server] 实际监听 ${address}`)
