# AGENTS.md

本文件是 `shop-backend` 仓库的 agent 操作说明。全局规则以 `~/.dsh/AGENTS.md` 为准；本文件只补充项目上下文。

## 项目

- 课程大作业题目二「电商商品列表及详情页开发」的后端仓库。
- 前端为独立仓库 `shop-frontend`；两个仓库通过本仓库生成的 `openapi.json` 对接。
- 规划文档（决策台账、推进计划）位于 `D:\pages\webqianduan\big-homework\`，不在本仓库内。

## 约束

- 动手前先读规划文档中的决策台账；标为「已确认」的决策不得擅自修改。
- 不提交、不 push，除非用户明确授权。
- 不把 `.env`、口令、token 写入仓库；只保留 `.env.example` 占位示例。
- 文档与提交信息用中文；代码标识符保持实际大小写，不做归一化。
- 未验证的结论不写成事实；事实、推论、建议分开写。
- TypeBox 与 Fastify 的四条易踩行为（`default` 不生效、请求侧 `$ref` 不可用、`const` 默认被转 `enum`、`Value.Convert` 会截断小数字面量）见 `docs/typebox-notes.md`。

## 双仓库约定

本作业由两个独立仓库组成：`shop-frontend` 与 `shop-backend`。

- 跨仓库的契约变更（接口路径、字段、错误码、分页 / 排序 / 价格规则）必须在同一阶段内两边闭环，不允许只改一侧。
- 涉及跨仓库的改动，提交信息里引用同一决策编号（如 `C38`）。
- 一次只在一个仓库里开工；需要同时改两边时，先落后端契约，再改前端消费，避免对着未落地的契约写代码。
- 清理阶段（分支合并、worktree 清理）两个仓库各做一次。

## 命令

```bash
pnpm install        # 安装依赖（精确版本，见 pnpm-lock.yaml）
pnpm build          # 原生 TypeScript 7 编译到 dist/
pnpm start          # 运行 dist/server.js（默认 3001）
pnpm dev            # node --watch 直接运行 src/server.ts
pnpm type-check     # tsc -p tsconfig.json
pnpm test           # node --test（重建 shop_homework_test 后跑全部测试）
pnpm test:es        # 真实 ES 验收（隔离 products_es_test* 索引与别名；ES 不可达时非零退出）
pnpm db:create      # 建库（首次部署必须先于 db:migrate）
pnpm db:generate    # 由 schema 生成迁移（手写迁移须同步补 meta 快照）
pnpm db:migrate     # 应用迁移（重复执行为 no-op）
pnpm db:seed        # 导入种子数据（按稳定键 upsert，可重复执行）
pnpm verify:images  # 校验种子引用的图片存在且归属正确
pnpm es:rebuild     # 全量重建商品索引并切换 products 别名（需 MySQL 与 Elasticsearch 在线）
```

启停（Windows）：

```bat
start.bat           # 拉起 Elasticsearch（已有可用实例则复用）后启动 dist/server.js，端口 3001
stop.bat            # 停止后端并释放端口，再停止本次入口创建的 Elasticsearch
```

- `start.bat` 依赖 `dist/server.js`，首次使用前需先 `pnpm build`。
- Elasticsearch 由 `scripts/es-dev.mjs` 管理：先探测 `http://127.0.0.1:9201/`，可用则复用，否则拉起并等待就绪（超时输出日志末尾）。**ES 没起来不阻断后端**：普通浏览可用，关键词搜索返回 503。
- ES 的启动记录写入 `.run/es.json`（含 pid、进程启动时间、可执行路径）。`stop.bat` 用后两项校验归属，不符时**拒绝终止**；不是本次入口创建的实例不会被停。安装位置、配置与实测记录见 `docs/es-notes.md`。
- 直接跑 `pnpm dev` / `pnpm start` 不经过上述入口，需另行保证 Elasticsearch 已就绪。
- 首次部署顺序：`db:create` → `db:migrate` → `db:seed` → `verify:images`。
- 新建 worktree 的准备工作（`.env` 由人手动复制、依赖单独安装、读 `node_modules` 的路径写法、`FRONTEND_PUBLIC_DIR` 的基准）见 `docs/worktree-setup.md`。
- 提交前由 pre-commit hook 自动跑 `type-check` / `check:terms` / `test` / `build`；`pnpm install` 时经 `prepare` 安装。
- 应用侧默认端口在 `src/config.ts` 的 `DEFAULT_PORT`；`scripts/dev.mjs` 通过 `PORT` 环境变量下发，覆盖该默认值。
- 启动记录写入 `.run/dev.json`（已 gitignore）。`stop.bat` 会校验 pid 存活 + 端口归属，不符时**拒绝终止**。
- **依赖构建白名单**：pnpm 12 用 `pnpm-workspace.yaml` 的 `allowBuilds`（**映射形式** `'包名': true`）决定哪些依赖可以跑构建脚本。写在 `package.json` 的 `pnpm` 字段**不生效**，写成列表会报 `expected mapping start`。本仓库用它放行 `esbuild`（`drizzle-kit` 的传递依赖）。

## Agent skills

### Issue tracker

Issues and specs live in this repo's GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical roles with default label strings. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `GLOSSARY.md` + `docs/adr/`. See `docs/agents/domain.md`.

