/**
 * 统一错误信封与业务码（D62）：
 * 响应体固定为 `{ error: { code, message, details? } }`，
 * `details` 的元素固定为 `{ path, message }`，用于字段级校验错误。
 */

export const ERROR_CODES = [
  'VALIDATION_FAILED',
  'PRODUCT_NOT_FOUND',
  'VARIANT_NOT_FOUND',
  'VARIANT_NOT_IN_PRODUCT',
  'SEARCH_NOT_AVAILABLE',
  'NOT_FOUND',
  'INTERNAL_ERROR',
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

/** 业务码到 HTTP 状态码的固定映射（D62）。 */
export const ERROR_STATUS: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 400,
  PRODUCT_NOT_FOUND: 404,
  VARIANT_NOT_FOUND: 404,
  VARIANT_NOT_IN_PRODUCT: 409,
  SEARCH_NOT_AVAILABLE: 503,
  NOT_FOUND: 404,
  INTERNAL_ERROR: 500,
}

export interface ErrorDetail {
  /** 字段位置，例如 `querystring/page`、`body/quantity`。 */
  path: string
  message: string
}

export interface ErrorBody {
  code: ErrorCode
  message: string
  details?: ErrorDetail[]
}

export interface ErrorEnvelope {
  error: ErrorBody
}

/** 业务错误：携带业务码与可选字段级明细，由统一错误处理器映射为信封。 */
export class AppError extends Error {
  readonly code: ErrorCode
  readonly details?: ErrorDetail[]

  constructor (code: ErrorCode, message: string, details?: ErrorDetail[]) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.details = details
  }
}

export function errorEnvelope (
  code: ErrorCode,
  message: string,
  details?: ErrorDetail[],
): ErrorEnvelope {
  return {
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
    },
  }
}
