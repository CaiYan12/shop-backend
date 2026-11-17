# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added

- 初始化仓库文档：`README.md`、`AGENTS.md`、`CHANGELOG.md`、`.gitignore`、`.env.example`。
- 数据层 schema 与迁移：商品类型、商品、商品图片、规格组合四张表，含 CHECK、唯一索引与逐列 collation（`drizzle/0000`–`0004`）。
- 种子导入：按稳定键 upsert 的清单式导入（`src/db/seed.ts`、`src/db/seed-data.ts`），导入前校验清单。
- 图片校验：`pnpm verify:images` 校验清单引用的图片归属与存在性（`src/db/verify-images.ts`）。
- 测试：配置、迁移、种子、派生摘要与图片校验的集成测试（`test/`）。

### Changed

- `src/server.ts` 改由 `loadConfig()` 取服务端口，默认值集中在 `src/config.ts` 的 `DEFAULT_PORT`。
