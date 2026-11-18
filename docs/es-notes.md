# Elasticsearch 本地落地记录（V1–V3 堆与耗时 · V13–V14 分片与磁盘）

> 本文件记录 Elasticsearch 的安装位置、配置、启停接线与实测数据。
> 对应工单 #19（Phase 4-01），决策依据 C47 / C59 / C60 与台账 §8；
> §7–§9 的索引映射与全量重建实测对应工单 #20（Phase 4-02），决策依据 C62 / D74 与 ADR 0003。
> §11 的商品联想实测对应工单 #22（Phase 4-04），决策依据 D74 与 ADR 0002 / 0003。
> 下文所有数值均为**实测**；推论与未测项单独标注。

## 1. 环境前提

采集时间：2026-11-18 10:24–10:32（Asia/Shanghai），与下文各条时间戳对应。

| 项 | 值 | 来源 |
|---|---|---|
| 操作系统 | Windows 10.0.26300.9974 | `cmd` 启动横幅 |
| Node.js | v26.13.1 | `node -v` |
| 物理内存 | 总计 16,092 MB；采集时可用 507 MB | `Get-CimInstance Win32_OperatingSystem` |
| D 盘可用 | 启动前 41,448,276 KB ≈ 39.5 GiB；采集时 39,776,744 KB ≈ 37.9 GiB | `df -k /d` |
| ES 安装包 | 674,226,618 B | `stat` 下载结果 |
| 中文插件包 | 3,616,470 B | 同上 |

两个包体积与台账 §3.1 的 HEAD 结果一致，说明下载完整。

> 内存前提值得注意：采集时可用物理内存只有 507 MB，而 ES 常驻工作集约 0.9 GB，靠 Windows 换页与文件缓存维持。
> 这是本机并发运行其他程序时的常态，不影响功能验证，但会影响耗时的稳定性（见 §5 的 28.2 s 与 33.0 s 差异）。

## 2. 安装与配置

### 2.1 目录（C59）

| 用途 | 路径 |
|---|---|
| 安装 | `D:\Dev\elasticsearch-9.5.6\` |
| 数据 | `D:\Dev\elasticsearch-data\` |
| 日志 | `D:\Dev\elasticsearch-logs\` |

安装包与插件包留在 `D:\Dev\es-download\`，重新安装时不必再次下载。

### 2.2 复现安装

```bash
# 下载（643 MiB，约 3 分钟）
curl -L -o elasticsearch-9.5.6-windows-x86_64.zip \
  https://artifacts.elastic.co/downloads/elasticsearch/elasticsearch-9.5.6-windows-x86_64.zip
# 解压到 D:\Dev\，得到 D:\Dev\elasticsearch-9.5.6\
cd /d/Dev && tar -xf es-download/elasticsearch-9.5.6-windows-x86_64.zip
# 装官方中文插件（版本必须与 ES 严格一致）
cd /d/Dev/elasticsearch-9.5.6 && ./bin/elasticsearch-plugin.bat install --batch analysis-smartcn
```

插件走在线安装成功；离线包（`analysis-smartcn-9.5.6.zip`）已下载备用，未使用。
安装时出现 `warning: ignoring JAVA_HOME=...; using bundled JDK` 属正常——ES 用自带 JDK，不受系统 Java 影响。

### 2.3 `config/elasticsearch.yml`

| 配置项 | 值 | 依据 |
|---|---|---|
| `network.host` | `127.0.0.1` | 只绑回环地址 |
| `http.port` | `9201` | 9200 被本机其他程序占用（台账 §3.6） |
| `transport.port` | `9301` | 同上 |
| `path.data` | `D:\Dev\elasticsearch-data` | C59 |
| `path.logs` | `D:\Dev\elasticsearch-logs` | C59 |
| `xpack.security.enabled` | `false` | 跳过安全自动配置（否则会生成 TLS 并把 HTTP 绑到 0.0.0.0） |
| `discovery.type` | `single-node` | **补充项**，见下 |
| `cluster.routing.allocation.disk.threshold_enabled` | `true` | C60，不关闭磁盘判定 |
| `...watermark.low` | `20gb` | C60 |
| `...watermark.high` | `10gb` | C60 |
| `...watermark.flood_stage` | `5gb` | C60 |

补充项说明：`discovery.type: single-node` 不在台账列出的配置清单里，但首次启动必须有它（或 `cluster.initial_master_nodes`）才会自选主节点；
否则节点起得来、集群状态却不是 green。加上它之后 `_cluster/health` 返回 `green`（见 §4）。

### 2.4 堆（C46）

`config/jvm.options.d/heap.options`：

```
-Xms512m
-Xmx512m
```

只此一处，安装根目录下的 `config/jvm.options` 未改动。

## 3. 启停接线（C47）

### 3.1 文件

| 文件 | 职责 |
|---|---|
| `start.bat` | 先 `node scripts\es-dev.mjs`，再 `node scripts\dev.mjs`；两行**不用 `&&` 串联**，ES 失败也照常启动后端 |
| `stop.bat` | 先 `node scripts\stop.mjs`，再 `node scripts\es-stop.mjs`；后端退出码非零时最后以该码退出 |
| `scripts/es-dev.mjs` | 探测 → 复用或拉起 → 等待就绪 → 写运行记录 |
| `scripts/es-stop.mjs` | 校验归属 → 终止 → 清理记录 |

### 3.2 探测与复用

探测 `http://127.0.0.1:9201/`，再读 `_cluster/health`；根路径有响应且集群状态为 `yellow`/`green` 即视为可用，直接复用，不创建进程。

- 根路径有响应但状态 `red`：报告并退出，不启动第二个进程。
- 端口有监听但根路径无响应：报告占用进程号并退出，不改用其他端口（端口以 `ES_HTTP_PORT` 覆盖）。

### 3.3 等待与超时

拉起后每秒轮询一次 `/_cluster/health?wait_for_status=yellow&timeout=2s`，默认超时 180 s（`ES_READY_TIMEOUT_MS`）。
超时输出日志目录里最新 `.log` 的末尾 20 行（只读末尾 64 KiB），并终止本次创建的进程，避免留下半启动实例。

### 3.4 运行记录 `.run/es.json`

与后端的 `.run/dev.json` **分开**：两个进程生命周期独立，混在一份记录里会互相覆盖。

```json
{
  "name": "elasticsearch",
  "pid": 12672,
  "startTime": "2026-11-18T02:31:14.xxxZ",
  "execPath": "D:\\Dev\\elasticsearch-9.5.6\\jdk\\bin\\java.exe",
  "httpPort": 9201,
  "esHome": "D:\\Dev\\elasticsearch-9.5.6",
  "startedAt": "...",
  "startupMs": 33041
}
```

`pid` 取**监听 9201 的进程**（即服务 JVM），不是启动器 JVM。`es-stop.mjs` 终止前校验 `startTime` 与 `execPath`，
任一不符即拒绝终止并保留记录——进程号会被系统复用，仅凭存活无法证明归属。

> **ES 9.5.6 是两段 JVM**：`elasticsearch.bat` 先起启动器 JVM，再由它拉起服务 JVM。
> 因此机器上会同时存在两个 `java.exe`。实测服务 JVM 被终止后启动器自行退出（两次停止后 `java.exe` 列表为空）。

### 3.5 降级

ES 未就绪不阻断后端：后端照常监听 3001，普通浏览可用，带关键词的请求仍返回 503 `SEARCH_NOT_AVAILABLE`。
（关键词读路径与商品联想已分别在 #21 / #22 切到 ES；本工单只保证降级不破坏启动。）

## 4. 部署核对（实测输出摘要）

```text
$ curl -s http://127.0.0.1:9201/
{"name":"CYSPC","cluster_name":"elasticsearch","version":{"number":"9.5.6","build_type":"zip",...},"tagline":"You Know, for Search"}

$ curl -s 'http://127.0.0.1:9201/_cat/plugins?v&h=name,component,version'
name  component        version
CYSPC analysis-smartcn 9.5.6

$ netstat -ano | findstr ":9201 :9301"
  TCP    127.0.0.1:9201         0.0.0.0:0              LISTENING       12672
  TCP    127.0.0.1:9301         0.0.0.0:0              LISTENING       12672

$ curl -s 'http://127.0.0.1:9201/_cluster/settings?include_defaults=true&filter_path=defaults.cluster.routing.allocation.disk'
{ "defaults": { "cluster": { "routing": { "allocation": { "disk": {
  "threshold_enabled": "true",
  "watermark": { "low": "20gb", "high": "10gb", "flood_stage": "5gb", ... } } } } } } }

$ curl -s 'http://127.0.0.1:9201/_cluster/health'
{ "status": "green", "number_of_nodes": 1, ... }
```

`_nodes/settings` 同步确认：`path.data`、`path.logs`、`http.port=9201`、`transport.port=9301`、
`network.host=127.0.0.1`、`xpack.security.enabled=false` 均已生效。

## 5. V2 · 启动耗时

测量方式：`scripts/es-dev.mjs` 从创建进程（`spawn`）到 `_cluster/health` 首次返回 `yellow`/`green` 的墙钟差，
结果写入 `.run/es.json` 的 `startupMs`。复现：`cat .run/es.json` 或看 `node scripts/es-dev.mjs` 的末行输出。

| 序 | 场景 | 耗时 | `startupMs` | 时间戳（UTC） |
|---|---|---|---|---|
| 1 | 首次启动：空数据目录 + 首次加载插件 | **35.0 s** | 35,041 | 2026-11-18T02:24:48.413Z |
| 2 | 二次启动：已有数据目录 | **28.2 s** | 28,186 | 2026-11-18T02:28:55.986Z |
| 3 | 三次启动：已有数据目录，同时跑构建与测试 | 33.0 s | 33,041 | 2026-11-18T02:31:14Z |
| — | 复用已有实例 | 1–2 s | 不写记录 | 多次 |

判读：首次与二次的差约 7 s，主要来自首次加载插件与初始化数据目录；第 3 次比第 2 次慢 4.8 s，
当时机器正在跑 `pnpm build` / `pnpm check:terms`，且可用物理内存仅 500 MB 量级。
**28–35 s 是本机实测区间，不是额定值**；机器空闲时偏向下界。

## 6. V1 · 堆与进程总内存

### 6.1 堆（由 `jvm.options.d/heap.options` 决定）

| 指标 | 值 | 来源 |
|---|---|---|
| `jvm.mem.heap_max_in_bytes` | 536,870,912 B = **512 MiB** | `_nodes/stats/jvm` |
| `jvm.mem.pools.old.max_in_bytes` | 536,870,912 B = **512 MiB** | 同上 |
| `jvm.mem.heap_used_in_bytes` | 193,966,760 B ≈ 185 MiB | 快照 2026-11-18T02:32:03Z |
| `jvm.mem.pools.old.used_in_bytes` | 74,322,408 B ≈ 71 MiB | 同上 |

`-Xms` 与 `-Xmx` 同为 512 MiB，`heap_max` 与老年代 `max` 都是 536,870,912 B，说明配置来自 `jvm.options.d` 且未被根 `jvm.options` 覆盖。

### 6.2 进程总内存

| 进程 | 角色 | Working set | Private bytes |
|---|---|---|---|
| 12672 | 服务 JVM（监听 9201/9301） | 885.3 MB | 941.5 MB |
| 4060 | 启动器 JVM | 43.5 MB | 35.6 MB |
| 合计 | | **≈ 928.8 MB** | ≈ 977.1 MB |

| 指标 | 值 | 来源 |
|---|---|---|
| `process.mem.total_virtual_in_bytes` | 983,584,768 B ≈ 938 MiB | `_nodes/stats/process` |

采集时间 2026-11-18T02:32:03Z。另在首次启动后 02:26:14Z 采集过一组：服务 JVM working set 920 MB、
private 978.3 MB、`total_virtual_in_bytes` 1,025,716,224 B（≈978 MiB）。

判读：
- **堆固定 512 MiB 不随重启变化**，这是本工单要锁定的常数。
- **进程总内存大于堆，约为堆的 1.8 倍**：差值是 JVM 自身（metaspace、代码缓存、线程栈）与 Lucene 堆外缓存。
  首次与后续采样间 working set 从 920 MB 变到 885 MB，属正常波动（GC 与文件缓存），不作为退化。
- 进程总内存按**两个 java 进程**合计：ES 9.5.6 的启动器 JVM 常驻约 40 MB，漏算它会低估约 4%。

## 7. V3 · 全量重建导入耗时

测量方式：`pnpm es:rebuild` 内部按阶段计时，末行输出总耗时；下表取自四次连续重建的实际输出。
复现命令：`date -u +START=%FT%TZ; pnpm es:rebuild; date -u +END=%FT%TZ`。
采集时间：2026-11-18T02:39:53Z–02:43:44Z（Asia/Shanghai 10:39–10:43），ES 9.5.6、16 件商品、单次 bulk 16 条。

| 阶段 | 第 1 次（建 v1） | 第 2 次（建 v2，删 v1） | 第 3 次（建 v3，删 v2） | 第 4 次（建 v4，内容核对） |
|---|---:|---:|---:|---:|
| 读取现有索引与别名 | 32 ms | 27 ms | 24 ms | 23 ms |
| 建索引 | 328 ms | 277 ms | 220 ms | 183 ms |
| 读取 MySQL 快照 | 26 ms | 26 ms | 27 ms | 24 ms |
| bulk 导入 | 222 ms | 69 ms | 72 ms | 31 ms |
| refresh | 155 ms | 61 ms | 74 ms | 53 ms |
| 全量校验 | 112 ms | 17 ms | 30 ms | 11 ms |
| 切换别名 | 85 ms | 58 ms | 41 ms | 26 ms |
| 校验别名 | 3 ms | 3 ms | 2 ms | 7 ms |
| 冒烟查询 | 51 ms | 6 ms | 9 ms | 8 ms |
| 删除旧物理索引 | 0 ms | 72 ms | 67 ms | 65 ms |
| **总耗时** | **1,019 ms** | **618 ms** | **567 ms** | **433 ms** |

- **V3 的「导入耗时」取 bulk 阶段：首次 222 ms，后续 31–72 ms**（16 条文档、单次 bulk、含 HTTP 往返）。
- 第 1 次包含索引初始化与首次写入，明显慢于后续；第 2–5 次总耗时 433–618 ms。
- 五次都以退出码 0 结束，均完成别名切换并删除上一版物理索引；收尾时别名指向 `products_v5`。

## 8. V13 · 磁盘水位与分片

采集时间：2026-11-18T02:39:53Z–02:43:44Z。全部命令在 `http://127.0.0.1:9201` 上执行。

### 8.1 建索引与写入

首次重建 `products_v1` 后（02:40:29Z）：

```text
$ curl -s "http://127.0.0.1:9201/_cat/indices?v&h=index,health,status,pri,rep,docs.count,store.size"
index       health status pri rep docs.count store.size
products_v1 green  open     1   0         16     27.7kb

$ curl -s "http://127.0.0.1:9201/_cat/shards?v&h=index,shard,prirep,state,docs,store,node"
index       shard prirep state   docs store  node
products_v1     0      p STARTED   16 27.7kb CYSPC
```

- 1 主分片、0 副本；单节点下分片直接 `STARTED`，`_cluster/health` 为 `green`。
- `_cat/indices` 默认只列出商品索引；集群另有隐藏系统数据流（`.ds-ilm-history-7-…`、`.ds-.logs-elasticsearch.deprecation-…`），
  因此同一时刻 `_cluster/health` 的 `active_primary_shards` 是 3。判断商品索引本身仍以 `_cat/indices` 与自己索引的行为准。

### 8.2 全量重建

第二次重建创建 `products_v2`、切换别名后删除 `products_v1`；第三次同理得到 `products_v3`。
第四次重建（02:42:58Z–02:42:59Z）用于内容一致性核对：切换前后各取一次 `products/_search` 的 `_id` 与 `_source`
（按 `productId` 升序）做 SHA-256，两次都是 `3ac9013ed5c2be6955cc57fa5dc9ed530a6e246cc14f714ec30c33d0ca5534e9`，
说明连续重建的文档内容一致；该次总耗时 433 ms。

第三次重建后（02:42:21Z，当时版本 `products_v3`）的别名与文档数：

```text
$ curl -s "http://127.0.0.1:9201/_alias?pretty"
{ "products_v3" : { "aliases" : { "products" : { } } } }

$ curl -s "http://127.0.0.1:9201/products/_count"
{"count":16,"_shards":{"total":1,"successful":1,"skipped":0,"failed":0}}
```

第五次重建（02:43:42Z–02:43:44Z）用于重建期间查询连续性核对，结果见 §8.6；收尾时别名指向 `products_v5`，`_count` 仍为 16。

### 8.3 停服重启后的分片恢复

在 `products_v2` 为当前版本时停止并重新拉起 ES：

```text
$ date -u +%FT%TZ; node scripts/es-stop.mjs; date -u +%FT%TZ
2026-11-18T02:40:43Z
[es] Elasticsearch 已停止，端口 9201 已释放
2026-11-18T02:40:45Z
```

停止约 2 s。随后 `node scripts/es-dev.mjs` 重新拉起；`.run/es.json` 记录 `startupMs: 33464`、
`startedAt: 2026-11-18T02:40:49.951Z`。重启后：

```text
$ curl -s "http://127.0.0.1:9201/_cluster/health"
{"status":"green", ..., "active_primary_shards":3, "unassigned_shards":0, ...}

$ curl -s "http://127.0.0.1:9201/_cat/shards?v&h=index,shard,prirep,state,docs,store,node"
products_v2  0 p STARTED 16 27.8kb CYSPC

$ curl -s "http://127.0.0.1:9201/products/_count"
{"count":16, ...}
```

分片在重启后自动恢复 `STARTED`，别名 `products` 仍指向 `products_v2`，文档数与停服前一致。

### 8.4 `_cluster/settings` 回读

```text
$ curl -s "http://127.0.0.1:9201/_cluster/settings?include_defaults=true&filter_path=defaults.cluster.routing.allocation.disk.watermark"
{"defaults":{"cluster":{"routing":{"allocation":{"disk":{"watermark":{
  "low":"20gb","high":"10gb","flood_stage":"5gb", ...
}}}}}}}
```

与 C60 的 20gb / 10gb / 5gb 一致；重启后的回读同样一致。

`_cat/allocation`（02:40:29Z）：

```text
shards disk.indices disk.used disk.avail disk.total disk.percent node
     3       50.6kb   413.7gb     37.9gb    451.6gb           91 CYSPC
```

判读：D 盘剩余 37.9 GB，仍高于 `high` 的 10 GB，重建期间没有触发分片迁移或只读。
**水位实际触发迁移未做**：需要把可用空间压到 10 GB 以下，代价与风险不成比例；V13 要求的阈值回读与各阶段分片状态均已实测。

### 8.5 映射回读（D74）

`GET /products/_mapping` 的字段类型：`name` / `brand` / `model` 为 `search_as_you_type` 且 `analyzer: smartcn`；
`categoryName` 为 `text` + `smartcn`；`slug` / `categorySlug` 为 `keyword`；`productId` / `sales` 为 `integer`；
`displayPriceCents` 为 `long`。创建请求为 1 主分片、0 副本。

另在临时索引 `probe_long_amount`（同名 `long` 映射）写入 `displayPriceCents: 9999999999`，
用 `range: { gte: 2147483648 }` 查询命中 1 条，验证超 32 位金额可导入、可筛选；临时索引已删除。

### 8.6 重建期间查询不中断

在第五次重建（v4 → v5，02:43:42Z–02:43:44Z，总耗时 539 ms）期间，以 50 ms 间隔连续查询 `products/_count`
共 100 次，全部返回 HTTP 200 且 `count` 为 16：

```text
QUERY_OK=100 QUERY_BAD=0
```

查询脚本放在 `.run/query-continuity.sh`（已 gitignore），与重建并发执行；
`_aliases` 单请求同时 add 新索引 / remove 旧索引，是查询不中断的原因。

## 9. V14 · 磁盘占用分项

测量命令：`du -sk /d/Dev/elasticsearch-9.5.6 /d/Dev/elasticsearch-data /d/Dev/elasticsearch-logs`（KB，1024 进制）。

| 时点 | 安装目录 | 数据目录 | 日志目录 | 说明 |
|---|---:|---:|---:|---|
| 重建前（02:39:53Z） | 1,007,848 KB ≈ 984.2 MiB | 248 KB ≈ 0.24 MiB | 1,256 KB ≈ 1.23 MiB | 空数据目录 |
| 首次重建后（02:40:29Z） | 1,007,848 KB | 340 KB ≈ 0.33 MiB | 1,256 KB | products_v1 / 16 docs |
| 重建与重启后（02:42:10Z） | 1,007,848 KB | 308 KB ≈ 0.30 MiB | 1,444 KB ≈ 1.41 MiB | products_v2 / v1 已删；重启日志增加 |

- 安装目录 ≈ 984 MiB，含自带 JDK；与 #19 记录的下载包 674,226,618 B 不冲突，zip 与解压后目录是两回事。
- 数据目录只有数百 KB：16 件商品的倒排索引很小，`_cat/indices` 报告的 `store.size` 为 27.7–27.8 KB，其余是 Lucene 段与事务日志开销。
- 日志目录随启动次数增长：本次停服重启新增约 188 KB。日志按默认策略滚动，长期占用需另行观察。
- 重建不会累积旧索引：每次切换成功后删除上一版，数据目录在 v1（340 KB）与 v2（308 KB）之间没有随版本数增长。

## 10. 未验证项与风险

| 项 | 状态 |
|---|---|
| V13 首次建索引 / 写入 / 全量重建 / 重启分片恢复 / `_cluster/settings` 回读 | **已验证**（§8）；水位实际触发迁移未做（见 §8.4） |
| V14 安装目录 / 数据目录 / 日志目录分项占用 | **已测量**（§9）：≈984.2 MiB / 0.24–0.33 MiB / 1.23–1.41 MiB |
| V11 商品联想五类输入 | **已验证**（§11）：单字 / 半词 / 品牌前缀符合预期；完整词与型号前缀有额外召回，原因见 §11 |
| 高亮转义与联想前缀标记（#23） | **已验证**（§12）：真机返回 `&lt;b&gt;x&lt;&#x2F;b&gt;`，`<em>` 是唯一标签；联想前缀需 `matched_fields` 指向 `._index_prefix` |
| 关键词搜索耗时与降级冷却 | 读路径已由 #21 落地（本文件未记录耗时）；**5 秒冷却窗口未做**，#24 范围 |
| 重启机器后 ES 是否可用 | 未验证；ES 不会开机自启，需 `start.bat` 或 `node scripts/es-dev.mjs` 拉起 |
| 并发启动两个 `start.bat` | 未验证。设计上第二个会走复用路径，但没有做并发压测 |

风险：
- `discovery.type: single-node` 是本工单补充的设置，台账配置清单里没有列；去掉它首次启动不会自选主节点。若要回退到台账字面清单，需同时补 `cluster.initial_master_nodes`。
- ES 运行常驻约 0.9 GB，本机可用物理内存只有 507 MB，运行期间换页明显；答辩前应确认没有其他大内存程序同时运行。
- 堆 512 MiB 是初值；若后续全量重建或大查询触发频繁 GC，需要按 V1 复测后调整（只改 `jvm.options.d/heap.options`）。

## 11. V11 · 商品联想实测（#22）

采集时间：2026-11-18 11:00–11:02（Asia/Shanghai）。ES 9.5.6，别名 `products`，`_count` = 16。

测量方式：`node .run/v11-suggest.mjs`（临时脚本，`.run/` 已 gitignore 且不提交）——用应用工厂注入真实的
`ElasticsearchProductSearchAdapter`，经 `app.inject` 请求 `GET /api/products/suggestions?q=…&limit=10`；
分词用 `POST /products/_analyze` 的 `field` 参数（name / brand / model 三个字段结果相同，下表合并一列）。
「预期命中」按种子清单逐件的名称 / 品牌 / 型号比对得出，不是跑完查询再倒推。

| 类别 | 输入 | 预期命中（按种子清单） | 实际命中（按返回顺序） | 结论 |
|---|---|---|---|---|
| 单字 | `耳` | airpods-max、apple-earpods、sony-wh-1000xm3、sony-wh-ch500（名称含「耳机」共 4 件） | 同上 4 件，顺序一致 | 符合预期 |
| 半词 | `降噪` | airpods-max、sony-wh-1000xm3（名称含「降噪」共 2 件） | 同上 2 件 | 符合预期 |
| 完整词 | `机械键盘` | keychron-k8、logitech-g613、cherry-g80-3850（名称含「机械键盘」共 3 件） | logitech-g613、keychron-k8、cherry-g80-3850、logitech-g15 | **多命中 1 件**：`logitech-g15` 的名称是「游戏键盘」，被分词出的「键盘」命中 |
| 品牌前缀 | `App` | Apple 的 4 件：airpods-max、apple-earpods、apple-watch-series-8、apple-watch-ultra | 同上 4 件，顺序一致 | 符合预期 |
| 型号前缀 | `A2096` | airpods-max（型号 A2096，精确 1 件） | airpods-max、apple-watch-series-8、apple-watch-ultra | **多命中 2 件**：见下文 smartcn 分词 |

分词结果（`_analyze`，name / brand / model 相同）：

| 输入 | smartcn 分词 |
|---|---|
| `耳` | `耳` |
| `降噪` | `降`、`噪` |
| `机械键盘` | `机械`、`键盘` |
| `App` | `app` |
| `A2096` | `a`、`2096` |

判读：

- **单字与不完整中文可用**：`search_as_you_type` 的 `._2gram` / `._3gram` 子字段让「耳」与「降噪」这类输入命中；
  「降噪」虽被拆成「降」+「噪」，仍由 2-gram 字段命中两件商品。
- **完整词按分词 OR 召回**：「机械键盘」拆成「机械」+「键盘」，「键盘」让「游戏键盘」的 `logitech-g15` 也进入结果；
  `bool_prefix` 的打分仍把两段都命中的三件「机械键盘」排在前面，因此**排序可用，但召回比字面预期宽**。
- **型号前缀受 smartcn 影响**（#21 已记录同类现象）：`A2096` 被切成 `a` + `2096`；`2096` 只命中 `airpods-max`，
  但 `a` 作为前缀命中品牌 `Apple` 的文档，于是另两件 Apple 商品一并进入结果。
  本票按要求**如实记录、不擅自改映射**；若要收紧型号前缀，可另行评估给 `model` 加 `keyword` 子字段或按字段加权，
  属新决策，不在 #22 范围。
- 五类输入都返回 HTTP 200；`limit=10` 时各输入返回 2–4 条，符合「最多 limit 条」。
- 本次只验证联想；高亮（#23）见 §12，失败冷却窗口（#24）不在本记录范围。

## 12. 命中高亮与转义实测（#23）

采集日期：2026-11-18（Asia/Shanghai）。ES 9.5.6，映射沿用 `PRODUCT_INDEX_DEFINITION`。

种子数据里没有 HTML，因此用临时索引 `highlight-probe`（写完即删）：按同一份映射常量建索引，
放两条文档，其中一条的 `name` 为：

```
Sony <b>x</b> 无线降噪头戴耳机 <script>alert(1)</script>
```

脚本：`.run/v23-highlight.mjs`（`.run/` 已 gitignore，不提交）。它构造真实的
`ElasticsearchProductSearchAdapter`，但把客户端换成「捕获请求 → 把索引名换成临时索引 → 转发给真实 ES」的转发器，
因此验证的是适配器自己发出的 highlight 配置，而不是另抄一份查询。

实际发出的 highlight 配置：

| 接口 | 配置 |
|---|---|
| 列表 | `encoder: 'html'`、`pre_tags: ['<em>']`、`post_tags: ['</em>']`；`fields` 为 `name` / `brand` / `model`，各自 `number_of_fragments: 0` |
| 联想 | 同上；`fields` 只有 `name` / `brand`，各自带 `matched_fields: [字段, '字段._index_prefix']` |

实测返回片段（原样）：

| 接口 | 片段 |
|---|---|
| 列表（probe-html） | `Sony &lt;b&gt;x&lt;&#x2F;b&gt; 无线<em>降</em><em>噪</em>头戴耳机 &lt;script&gt;alert(1)&lt;&#x2F;script&gt;` |
| 列表（probe-airpods） | `Apple AirPods Max 头戴式<em>降</em><em>噪</em>耳机` |
| 联想 q=AirP | `Apple <em>AirPods Max 头</em>戴式降噪耳机` |

结论：

- **转义生效**：原文的 `<b>` / `</b>` / `<script>` / `</script>` 全部变成实体，片段里不再出现裸的 `<`、`>`；
  斜杠被编码成 `&#x2F;`（ES 的 html 编码器行为），前端按文本渲染即可。
- **`<em>` 是唯一标签**：把所有片段里的 `<em>` / `</em>` 去掉后，剩余文本不含 `<` 或 `>`
  （脚本里的 `TAGS_OUTSIDE_EM` 为空数组 `[]`）。
- **联想的高亮依赖 `matched_fields`**：只写根字段 `name` 时，`bool_prefix` 的命中落在 `._2gram` / `._3gram` /
  `._index_prefix` 子字段上，`AirP` 这类输入返回的命中**没有任何片段**（只写根字段的对照实测为空）；
  把根字段与 `._index_prefix` 合并后才标出前缀。
- **已知偏差**：`._index_prefix` 是边向前缀，覆盖范围会连带标记后面的词（`AirP` 标成 `AirPods Max 头`）；
  属该子字段行为，如实记录，不在本票收紧。
- 临时索引已删除：脚本末尾 `DELETE`，输出 `PROBE_INDEX_DELETED=highlight-probe`。

