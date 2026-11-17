import { resolve } from 'node:path'
import { BACKEND_ROOT } from './backend-root.ts'

/**
 * 契约产物的位置与序列化形式（D64）。
 *
 * 生成脚本与测试共用这里，保证「写出的文件」与「测试断言的文本」是同一份格式：
 * 两空格缩进 + 末尾换行，因此同一份文档总是序列化成同一个文件。
 */

/** 可提交的契约产物：仓库根的 openapi.json，前端据此生成类型（D65）。 */
export const OPENAPI_FILE = resolve(BACKEND_ROOT, 'openapi.json')

/** 把 OpenAPI 文档序列化为可提交的文本。 */
export function serializeOpenApiDocument (document: unknown): string {
  return `${JSON.stringify(document, null, 2)}\n`
}
