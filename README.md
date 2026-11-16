# shop-backend

Web 前端开发技术课程大作业 · 题目二「电商商品列表及详情页开发」的后端仓库。

## 项目概述

提供商品列表、详情、分类、相关推荐与模拟购买校验接口，并生成 `openapi.json` 作为前后端契约。前端为独立仓库 `shop-frontend`。

## 技术栈

| 层 | 选型 |
|---|---|
| 框架 | Fastify 5 |
| 类型 | TypeScript + TypeBox 1.x + `@fastify/type-provider-typebox` 6 |
| ORM | Drizzle ORM + mysql2 |
| 数据库 | MySQL 8.1（库 `shop_homework`，账号 `shop_app`） |
| 搜索 | Elasticsearch 9.5.6 + `analysis-smartcn`（Phase 4 落地） |
| 契约 | 生成 `openapi.json` |

## 端口

- 后端 API：`3001`
- Elasticsearch：`9201` / `9301`（Phase 4）

## 当前状态

Phase 0（项目初始化与对齐）已完成仓库初始化与文档骨架。应用骨架自 Phase 1 起落地，数据库与迁移自 Phase 2 起落地。

## 配置

复制 `.env.example` 为 `.env` 并填入本机实际值。`.env` 已被 `.gitignore` 忽略，不得提交。

## 相关仓库

- 前端：`shop-frontend`
- 规划文档（决策台账、推进计划）不在本仓库内。

## 文档

- `AGENTS.md` — 本仓库的 agent 操作说明
- `CHANGELOG.md` — 变更记录
