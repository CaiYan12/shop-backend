import { fileURLToPath } from 'node:url'

/**
 * 后端仓库根目录：本文件位于 <root>/src/（构建后为 <root>/dist/），上溯一级即根。
 * 相对路径一律从这里解析，因此脚本在任何工作目录下被调用都得到同一结果。
 */
export const BACKEND_ROOT = fileURLToPath(new URL('../', import.meta.url))
