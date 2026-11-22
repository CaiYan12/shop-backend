# Phase 8 · 后端 API 覆盖映射（票 B1 / #27）

把 Phase 8 的六个 API 验收项（搜索、筛选、排序、分页、购买校验、非法参数）逐项映射到本仓库
`test/` 里现有的 `app.inject` 路由用例，并给出缺口判定。

- 依据：`session-tmp/phase8-spec.md` 的 A1 行与「API 覆盖映射（初稿）」表；票 B1（CaiYan12/shop-backend#27）；父 spec CaiYan12/shop-frontend#25。
- 范围：只做映射与缺口判定。不新建测试框架、不改 API 契约、不改业务数据、不动 `package.json` / lock / CI。
- 用例形态：下表全部是 `app.inject` 路由用例（进程内注入，不监听端口），由 `pnpm test`
  （`node --test --test-concurrency=1 --test-global-setup=test/global-setup.ts "test/**/*.test.ts"`）执行。
- 用例名已与实跑结果核对：环境就绪后 `pnpm test` **206 条全绿**（2026-11-22，pass 206 / fail 0，
  日志见 `session-tmp/phase8-evidence/B1/08-test.log`）。

## 基线与总数

| 项 | 值 | 来源 |
|---|---|---|
| `pnpm test` 基线 | 206 条 | spec A1 行「基线 206」 |
| 核对方式 | 28 个 `test/*.test.ts` 中 `^test(` 逐文件求和 = 206 | 当前工作区源码；无子测试（未使用 `t.test` / `describe`） |
| 本票新增用例 | 0 条（无缺口，见文末） | 见「缺口判定」 |
| 实测总数 | **206 条，全绿（pass 206 / fail 0）** | `session-tmp/phase8-evidence/B1/08-test.log`（2026-11-22，duration ≈ 117.8 s） |

## 映射表

| 验收项 | 用例文件 | 具体测试名 | 覆盖结论 |
|---|---|---|---|
| 搜索 | `test/product-search.test.ts`（主）；`test/search-cooldown.test.ts`（503 降级与冷却，辅助） | 1. `关键词命中按搜索端口给出的顺序返回，展示字段由 MySQL 补齐且与 MySQL 路径一致`<br>2. `筛选条件、页码与每页数量原样传到搜索端口；未显式指定排序时 sort 为 undefined`<br>3. `分页与总数映射：total 取搜索总数，totalPages 按其与每页数量计算`<br>4. `搜索端口不可用返回 503 与 SEARCH_NOT_AVAILABLE，无关键词的普通浏览不受影响`<br>5. `搜索端口的非可用性异常走 500，不被误映射为 503`<br>6. `列表项带命中高亮：按 slug 合并回同一条目，命中顺序不变，片段原样透传`<br>7. `关键词 trim 后为空不调用搜索端口，关键请求参数校验先于搜索调用` | 覆盖。关键词路径的命中顺序、MySQL 补齐字段、分页总数、503 / 500 降级、命中高亮、空关键词分流都有路由级断言；`search-cooldown.test.ts` 另覆盖冷却窗口与「400 先于 503」。 |
| 筛选 | `test/product-list.test.ts`；搜索路径的筛选透传在 `test/product-search.test.ts` | 1. `商品类型筛选只返回该类型，未知类型返回空结果且 totalPages 为 0`<br>2. `价格区间含端点：19999 / 20000 / 20001 分探针分别命中正确区间`<br>3. `最低销量含端点：等于下限的商品命中`<br>4. `筛选条件可组合：商品类型与最低销量同时生效`<br>5. `筛选条件、页码与每页数量原样传到搜索端口；未显式指定排序时 sort 为 undefined`（关键词路径） | 覆盖。类型、价格区间（含两端点）、最低销量（含端点）、组合筛选都有字面期望；关键词路径断言筛选条件原样传给搜索端口且缺省字段为 `undefined`（不伪造值）。 |
| 排序 | `test/product-list.test.ts`；搜索路径在 `test/product-search.test.ts` | 1. `三种排序次序正确：价格升序、价格降序、销量降序`（同一用例末尾断言 `sort=unknown` 返回 400）<br>2. `同值按固定次序：逐页取回不重复、不遗漏`<br>3. `筛选条件、页码与每页数量原样传到搜索端口；未显式指定排序时 sort 为 undefined`（三种显式 sort 逐个透传，未指定时不兜底） | 覆盖。三种排序的次序按种子数据的字面列表断言（不按实现公式重算）；同值用固定次序保证分页不重不漏；关键词路径只断言透传（命中顺序由搜索端口决定）。 |
| 分页 | `test/product-list.test.ts`；关键词路径在 `test/product-search.test.ts` | 1. `默认请求返回第一页 8 件，按销量降序并带齐卡片字段`<br>2. `分页：页码与每页数量生效，超出末页返回空列表并保留请求页码与真实总数`<br>3. `分页参数越界返回 400 与 VALIDATION_FAILED，明细指向具体字段`<br>4. `分页与总数映射：total 取搜索总数，totalPages 按其与每页数量计算`（关键词路径） | 覆盖。默认页 / 每页数量、末页之后的空列表与保留页码、`totalPages` 为 0 与计算规则、`page` / `pageSize` 越界 400 都有断言；MySQL 与关键词两条路径的规则一致。 |
| 购买校验 | `test/purchase-check.test.ts` | 1. `可购买分支返回 200，并带齐商品、规格组合、数量、单价、小计与库存`<br>2. `库存不足分支返回 blocked + INSUFFICIENT_STOCK 与剩余库存，金额仍按当前库价计算`<br>3. `价格变化分支返回 blocked + PRICE_CHANGED、请求价与当前价`<br>4. `库存不足且价格变化同时发生时，原因为 INSUFFICIENT_STOCK 且 priceChanged 为 true`<br>5. `预期价与当前价一致时仍可购买，且 priceChanged 为 false`<br>6. `预期价 0 分是合法输入：按价格变化阻止，并原样回显请求价`<br>7. `数量等于库存时仍可购买（边界含端点）`<br>8. `商品不存在返回 404 与 PRODUCT_NOT_FOUND`<br>9. `规格组合不存在返回 404 与 VARIANT_NOT_FOUND`<br>10. `规格组合不属于该商品返回 409 与 VARIANT_NOT_IN_PRODUCT，且先于库存判定`<br>11. `数量越界返回 400 与 VALIDATION_FAILED，明细指向 body/quantity`<br>12. `校验前后库存与价格不变（只校验不写库）`（经详情接口观察） | 覆盖。三类结果分支（`purchasable` / `INSUFFICIENT_STOCK` / `PRICE_CHANGED`）与两原因并存、库存边界、404 / 409 判定顺序、数量 400、只读不写库都有直断言。 |
| 非法参数 | `test/product-list.test.ts`、`test/product-search.test.ts`、`test/purchase-check.test.ts`（明细见下节） | 1. `分页参数越界返回 400 与 VALIDATION_FAILED，明细指向具体字段`<br>2. `价格下限大于上限返回 400 与 VALIDATION_FAILED，明细指向价格下限`<br>3. `请求校验先于搜索调用：跨字段价格错误与关键词同时出现时返回 400`<br>4. `关键词 trim 后超过 100 字符返回 400 与 VALIDATION_FAILED`<br>5. `关键词 trim 后为空不调用搜索端口，关键请求参数校验先于搜索调用`<br>6. `数量越界返回 400 与 VALIDATION_FAILED，明细指向 body/quantity`<br>7. `三种排序次序正确：价格升序、价格降序、销量降序`（末尾断言 `sort=unknown` 返回 400） | 覆盖。五类可修正参数（分页、排序、价格跨界、关键词超长、数量越界）都断言 `400 + VALIDATION_FAILED` 且 `details[0].path` 指向具体字段；跨字段校验先于搜索调用。 |

### 非法参数明细

| 参数 / 场景 | 期望 | 用例（文件） |
|---|---|---|
| `page=0`、`page=201` | 400，`details[0].path = querystring/page` | `分页参数越界返回 400 与 VALIDATION_FAILED，明细指向具体字段`（`product-list.test.ts`） |
| `pageSize=0`、`pageSize=51` | 400，`details[0].path = querystring/pageSize` | 同上 |
| `sort=unknown` | 400，`details[0].path = querystring/sort` | `三种排序次序正确：价格升序、价格降序、销量降序`（`product-list.test.ts`，末尾 400 断言） |
| `priceMinCents > priceMaxCents` | 400，`details[0].path = querystring/priceMinCents` | `价格下限大于上限返回 400 与 VALIDATION_FAILED，明细指向价格下限`；`请求校验先于搜索调用：跨字段价格错误与关键词同时出现时返回 400`（`product-list.test.ts`） |
| `keyword` trim 后超过 100 字符 | 400，`details[0].path = querystring/keyword` | `关键词 trim 后超过 100 字符返回 400 与 VALIDATION_FAILED`（`product-list.test.ts`）；`关键词 trim 后为空不调用搜索端口，关键请求参数校验先于搜索调用`（`product-search.test.ts`） |
| `quantity` 为 0 / 1000 / 1.5 | 400，`details[0].path = body/quantity` | `数量越界返回 400 与 VALIDATION_FAILED，明细指向 body/quantity`（`purchase-check.test.ts`） |
| 空串 / 纯空白 / 超长空白 `keyword` | **不是非法参数**：按无关键词处理，200 且结果与基线一致 | `空串、纯空白与超长空白关键词都按无关键词处理`（`product-list.test.ts`）；`关键词 trim 后为空不调用搜索端口，关键请求参数校验先于搜索调用`（`product-search.test.ts`） |

请求体层面的框架级错误不属上述业务参数校验，另由 `test/app.test.ts` 的探针路由覆盖，列此备查：
`查询参数校验失败返回 400 与 VALIDATION_FAILED，details 带字段位置`、
`畸形 JSON 请求体返回 400 与 VALIDATION_FAILED，仍走统一信封`、
`不支持的 Content-Type 返回 415 与 VALIDATION_FAILED`、
`超过 bodyLimit 的请求体返回 413 与 VALIDATION_FAILED`。

## 对初稿表的修正

spec「API 覆盖映射（初稿）」把「空关键词」放在**非法参数**行。实际行为与断言是：trim 后为空的
`keyword` 按无关键词处理并返回 200，不是 400。本文件按实际断言把它记在「搜索」的形态说明里，
在「非法参数明细」单列一行并标为**不是非法参数**。

## 缺口判定

六项验收逐项检查后，**每一项都至少有一条现成的 `app.inject` 路由用例直接断言其可观察行为**，
因此本票**没有发现需要补测的缺口，新增用例 0 条**，整套总数保持 206。

不补测的边界及理由（按「只有确实缺口才在原套件补测」「不改契约」处理）：

- **请求体缺必填字段 / `slug` 不符合 pattern / `category` 空串 / 负价**：与已测参数走同一套
  TypeBox schema 校验与统一错误映射；`400 + VALIDATION_FAILED + details[].path` 的信封形状已由
  上述五类用例与 `app.test.ts` 的 `details` 断言证明，重复补测只增加条数，不增加行为主张。
- **413 / 415 / 畸形 JSON**：属于框架层错误映射，已由 `app.test.ts` 探针路由覆盖（不在六项业务验收内）。
- **商品联想 / 详情 / 相关推荐 / 分类**：不属于本票的六项 API 验收，保持原覆盖。

若 review 要求把这些边界也纳入，应另开票处理：会改变测试总数（206 → 更大），
正式验收记录里「基线 206」的表述需要同步改写。

## 复现方式（环境就绪后）

```bash
# 整套基线（需要 .env 指向测试库；global-setup 会重建 shop_homework_test）
pnpm test

# 本文件引用的四个文件定向复跑
node --test --test-concurrency=1 --test-global-setup=test/global-setup.ts \
  "test/product-list.test.ts" "test/product-search.test.ts" \
  "test/purchase-check.test.ts" "test/search-cooldown.test.ts"
```

## 本轮检查结果

证据目录：`session-tmp/phase8-evidence/B1/`

| 命令 | 结果 | 证据文件 |
|---|---|---|
| `pnpm type-check` | 退出码 0 | `01-type-check.log` |
| `pnpm build` | 退出码 0（产出 `dist/`，已 gitignore） | `02-build.log` |
| `pnpm lint` | 不适用：本分支 `package.json` 无 `lint` 脚本（Oxlint 属 L1 票范围，本票不改 `package.json`） | `03-lint.log` |
| `pnpm test` | **206 条全绿**（pass 206 / fail 0，duration ≈ 117.8 s） | `08-test.log` |
