import Fastify from 'fastify'
import { TypeBoxValidatorCompiler } from '@fastify/type-provider-typebox'
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import { Type } from 'typebox'

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
        items: Type.Array(Type.Object({
          id: Type.Integer(),
          name: Type.String(),
          price: Type.Number(),
        })),
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

const port = Number(process.env.PORT ?? 3001)

await app.listen({ port, host: '127.0.0.1' })
