# TypeBox 与 Fastify 集成笔记

本文件记录四条会反复踩到的行为，供实现与审查共用。领域词汇见 `GLOSSARY.md`。

## 1. `TypeBoxValidatorCompiler` 不应用 schema 的 `default`

`@fastify/type-provider-typebox` 的校验器是 `Compile(schema)` + `Value.Convert`，
**不会**像 ajv 的 `useDefaults` 那样把 `default` 填进请求值。因此：

- schema 里的 `default` 只用于文档（写进 OpenAPI），不改变运行时；
- handler 必须自己兜底（如 `query.page ?? 1`），这些兜底**不是死代码**。

## 2. 请求侧不能用 `addSchema` + `$ref`

`TypeBoxValidatorCompiler` 调用 `Compile(schema)` 时不传引用上下文，因此
`fastify.addSchema(...)` 注册的 schema 在**请求侧**（body / querystring / params / headers）
用 `$ref` 引用会恒返回 400（`body schema is false`）。

- 请求 schema：直接复用同一个 TypeBox 对象（内联），或用同一 schema 内的 `$defs` + `$ref`；
- 响应 schema：`addSchema` + `$ref` 正常，序列化器能解析，且未声明字段会被剥离。

## 3. OpenAPI 3.1 与 `const`

`@fastify/swagger` 的 `convertConstToEnum` 默认 `true`，会把 `Type.Literal` 转成单值 `enum`，
**与 OpenAPI 版本无关**。要保留 `const` 必须显式设 `convertConstToEnum: false`（见 `src/app.ts`）。

## 4. `Value.Convert` 会把小数字面量截断成整数

查询参数默认先经 `Value.Convert`：`Type.Integer` 会把字符串 `"2.5"` 截断成 `2`（向零取整），
再通过 `minimum` / `maximum` 与整数校验。因此 schema 上的「整数」约束对 `2.5` 这类字面量不生效。

这是**整个 API 的既有行为**：`page` / `pageSize` / `priceMinCents` / 联想 `limit` 等所有整数
查询参数都按同一口径处理，不为单个参数另加原始字符串校验。若某处确实需要严格整数语义，
应先改这条全局口径并补对应测试，而不是只收紧一个接口。
