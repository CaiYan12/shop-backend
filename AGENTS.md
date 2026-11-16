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
```

启停（Windows）：

```bat
start.bat           # 启动 dist/server.js，端口 3001
stop.bat            # 停止并释放端口
```

- `start.bat` 依赖 `dist/server.js`，首次使用前需先 `pnpm build`。
- 端口在 `scripts/dev.mjs` 单点定义，通过 `PORT` 环境变量下发给子进程。
- 启动记录写入 `.run/dev.json`（已 gitignore）。`stop.bat` 会校验 pid 存活 + 端口归属，不符时**拒绝终止**。

## Agent skills

### Issue tracker

Issues and specs live in this repo's GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical roles with default label strings. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `GLOSSARY.md` + `docs/adr/`. See `docs/agents/domain.md`.

