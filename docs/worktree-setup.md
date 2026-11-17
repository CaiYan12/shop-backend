# 新建 worktree 的准备工作

本文件是给 agent 与人的操作说明。`AGENTS.md` 只放指针，细节在这里。

## 1. `.env` 必须由人手动复制

`.env` 被 `.gitignore` 覆盖，`git worktree add` 不会带过去。agent 复制会被 CC Safety Net 按 `secret.basename.env` 规则拦截，**不要绕过**。

新建 worktree 后，请由人执行（PowerShell）：

```powershell
$src = 'D:\pages\webqianduan\big-homework\shop-backend\.env'
Copy-Item $src '<新 worktree 路径>\.env' -Force
```

agent 只能核对文件是否存在（列目录即可），**不得读取或回显内容**。

## 2. 依赖要单独装

worktree 里没有 `node_modules`，进 worktree 后先 `pnpm install`。`prepare` 会自动安装 pre-commit hook。

## 3. 读 `node_modules` 里的包类型

pnpm 的 `node_modules/<包>` 是符号链接，OPS 文件工具拒绝穿过符号链接，`ops_glob` 也不列隐藏目录（`.pnpm`、`.env`、`.github`）。

- 列目录用 shell `ls`，不要指望 `ops_glob`
- 读包内类型文件用 `.pnpm` 下的真实路径，例如
  `node_modules/.pnpm/drizzle-orm@0.45.4_mysql2@3.24.6_@types+node@26.6.6_/node_modules/drizzle-orm/mysql-core/columns/index.d.ts`

## 4. 图片校验脚本的目录基准

`pnpm verify:images` 的 `FRONTEND_PUBLIC_DIR` 默认 `../shop-frontend/public`，**相对后端仓库根解析**。

- 主检出布局下默认值正确
- worktree 布局下会解析到 `worktrees/shop-backend/shop-frontend/public`（不存在），需显式指定：
  `FRONTEND_PUBLIC_DIR="D:/pages/webqianduan/big-homework/shop-frontend/public" pnpm verify:images`
