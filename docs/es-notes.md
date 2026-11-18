# Elasticsearch 本地落地记录（V1 堆与进程总内存 · V2 启动耗时）

> 本文件记录 Elasticsearch 的安装位置、配置、启停接线与实测数据。
> 对应工单 #19（Phase 4-01），决策依据 C47 / C59 / C60 与台账 §8。
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
（把关键词切到 ES 是 #20 的范围，本工单只保证降级不破坏启动。）

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

## 7. 未验证项与风险

| 项 | 状态 |
|---|---|
| V13 磁盘水位真实触发（首次建索引 / 写入 / 重建 / 重启分片恢复） | **未验证**，属 #20 及后续索引工单范围；本次只核对配置已生效 |
| V14 安装目录 / 索引数据目录 / 日志目录分项占用 | **未测量**，同上 |
| 关键词走 ES 后的耗时与降级冷却 | **未验证**，#20 范围；当前 503 是 Phase 3 占位实现 |
| 重启机器后 ES 是否可用 | 未验证；ES 不会开机自启，需 `start.bat` 或 `node scripts/es-dev.mjs` 拉起 |
| 并发启动两个 `start.bat` | 未验证。设计上第二个会走复用路径，但没有做并发压测 |

风险：
- `discovery.type: single-node` 是本工单补充的设置，台账配置清单里没有列；去掉它首次启动不会自选主节点。若要回退到台账字面清单，需同时补 `cluster.initial_master_nodes`。
- ES 运行常驻约 0.9 GB，本机可用物理内存只有 507 MB，运行期间换页明显；答辩前应确认没有其他大内存程序同时运行。
- 堆 512 MiB 是初值；若后续全量重建或大查询触发频繁 GC，需要按 V1 复测后调整（只改 `jvm.options.d/heap.options`）。
