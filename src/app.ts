import Fastify from 'fastify'
import type { FastifyError, FastifyServerOptions } from 'fastify'
import { TypeBoxValidatorCompiler } from '@fastify/type-provider-typebox'
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import { Type } from 'typebox'
import type { AppConfig } from './config.ts'
import type { Database } from './db/client.ts'
import { AppError, ERROR_STATUS, errorEnvelope, type ErrorDetail } from './errors.ts'
import { registerCategoryRoutes } from './routes/categories.ts'
import { registerProductRoutes } from './routes/products.ts'
import { registerProductSchemas } from './schemas/product.ts'

declare module 'fastify' {
  interface FastifyInstance {
    /** 由应用工厂注入的数据库句柄；生命周期归调用方，应用关闭时不会关闭它。 */
    db: Database
    /** 由应用工厂注入的配置；应用工厂自身不读环境文件。 */
    config: AppConfig
  }
}

export interface CreateAppOptions {
  /** 已构造的数据库句柄；应用工厂不创建连接池。 */
  db: Database
  /** 已解析的配置；应用工厂不读环境文件。 */
  config: AppConfig
  /** 是否输出请求日志；测试默认关闭。 */
  logger?: boolean
}

function buildFastify (options: FastifyServerOptions) {
  return Fastify(options)
    .setValidatorCompiler(TypeBoxValidatorCompiler)
    .withTypeProvider<TypeBoxTypeProvider>()
}

export type AppInstance = ReturnType<typeof buildFastify>

/** Fastify 校验错误在运行时附带的字段（@fastify/error 的类型未声明）。 */
interface ValidationIssue {
  instancePath?: string
  message?: string
}

interface ValidationFailure extends Error {
  validation?: ValidationIssue[]
  validationContext?: string
}

/** 把 Fastify 的校验错误映射为 `{ path, message }`：path 形如 `querystring/page`。 */
function validationDetails (error: ValidationFailure): ErrorDetail[] {
  const context = error.validationContext ?? ''
  return (error.validation ?? []).map((issue) => ({
    path: `${context}${issue.instancePath ?? ''}`,
    message: issue.message ?? '不符合约束',
  }))
}

function registerErrorHandler (app: AppInstance): void {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof AppError) {
      return reply
        .status(ERROR_STATUS[error.code])
        .send(errorEnvelope(error.code, error.message, error.details))
    }

    const validationError = error as FastifyError & ValidationFailure
    if (validationError.validation !== undefined) {
      return reply
        .status(400)
        .send(errorEnvelope('VALIDATION_FAILED', '请求参数校验失败。', validationDetails(validationError)))
    }

    // 内部异常只返回通用消息，完整异常进服务端日志。
    request.log.error({ err: error }, '未预期异常')
    return reply.status(500).send(errorEnvelope('INTERNAL_ERROR', '服务内部错误。'))
  })
}

/**
 * 应用工厂：接收已构造的数据库句柄与配置，返回未监听的实例。
 * 不创建连接池、不读环境文件、不监听端口；监听与连接池归属由启动入口负责。
 */
export async function createApp ({
  db,
  config,
  logger = false,
}: CreateAppOptions): Promise<AppInstance> {
  const app = buildFastify({ logger })
  app.decorate('db', db)
  app.decorate('config', config)

  // 文档插件必须先于业务路由注册，才能收集到路由 schema（D64）。
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: '商品列表与详情 API',
        version: '0.1.0',
      },
      servers: [{ url: `http://127.0.0.1:${config.port}` }],
      tags: [
        { name: '商品' },
        { name: '商品类型' },
        { name: '购买校验' },
      ],
    },
  })
  await app.register(swaggerUi, { routePrefix: '/documentation' })

  // 共享响应 schema 只注册一次，路由通过 `$ref` 引用（D64、D67）。
  registerProductSchemas(app)

  // 业务路由必须在文档插件之后挂载，才能被收集进契约（D64）。
  registerProductRoutes(app)
  registerCategoryRoutes(app)

  app.get('/openapi.json', {
    schema: { hide: true },
  }, async () => app.swagger())

  app.get('/health', {
    schema: {
      hide: true,
      response: {
        200: Type.Object({
          status: Type.String(),
        }),
      },
    },
  }, async () => ({ status: 'ok' }))

  app.setNotFoundHandler((_request, reply) => {
    return reply.status(404).send(errorEnvelope('NOT_FOUND', '请求的接口不存在。'))
  })

  registerErrorHandler(app)

  return app
}
