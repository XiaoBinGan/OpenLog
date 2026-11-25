# 加速卡兼容矩阵

回答一个问题：**换硬件怎么办**。每一行都标了实现状态，并写清判定依据 —— 没有「大概支持」。

状态只有四种，定义见 §4：

| 标记 | 含义 |
|---|---|
| **已用真机验证** | 在真实机器 + 真实 GPU 上跑通，证据落在本仓库的部署清单/实测记录里 |
| **仅 fixture 验证** | 代码路径完整、单测覆盖正反例，但没有在对应硬件上跑过 |
| **已实现** | 代码存在且被渲染/预检路径调用；验证级别见括注 |
| **未实现** | 没有这条代码路径；调用会明确失败或降级，不会静默假装支持 |

---

## 1. 一页结论

| 厂商 | Kubernetes 资源键 | 切分能力 | 探测命令 | 本层状态 |
|---|---|---|---|---|
| **NVIDIA** | `nvidia.com/gpu`、`nvidia.com/gpumem`、`nvidia.com/gpucores` | HAMi vGPU 切分（显存 + 算力，单卡默认 10 槽） | `nvidia-smi` | **已实现 · 已用真机验证** |
| **AMD** | `amd.com/gpu` | 整卡，不切分、不限算力 | `rocm-smi` | **已实现 · 仅 fixture 验证** |
| **Ascend** | `huawei.com/Ascend910`（+ 可选 `huawei.com/Ascend910-memory`） | 整卡为主；显存配额只有装切分版插件才有，算力配额不存在 | `npu-smi` | **已实现 · 仅 fixture 验证** |
| **generic** | 节点上实际存在的 `<domain>.com/gpu` | 整卡计数，不切分 | 无（看资源键/标签） | **已实现 · 仅 fixture 验证** |

真机验证覆盖的是「RTX 4090 + RTX 5090 + 2 × Tesla T4 的 k3s + HAMi 集群」，证据见
`deploy/k8s/cluster/README.md` 的「实测结论（2026-11-23，243 + 154.225）」。AMD / Ascend 没有
对应硬件，只有 fixture。**接口文档、CI 绿、别人集群能跑，都不算真机验证。**

代码位置：`server/infra/accelerator/{index,nvidia,amd,ascend,generic}.js`；
统一的注入接口见文末的 [附录：适配器契约](#附录适配器契约)。

---

## 2. 三家实现差异

### 2.1 能力声明（代码里的 `capabilities`）

| 能力位 | NVIDIA | AMD | Ascend | generic |
|---|---|---|---|---|
| `canShare`（能切分） | `true` | `false` | `true`（按节点实际上报决定） | `false` |
| `canLimitCores`（能限算力） | `true` | `false` | `false` | `false` |
| `memUnitMiB`（显存配额单位） | `1`（MiB 精确） | `0`（无此概念） | `1`（有 `-memory` 键时） | `0` |
| `wholeCardResource` | `nvidia.com/gpu` | `amd.com/gpu` | `huawei.com/Ascend910` | `null`（键从节点读） |

`capabilities` 说的是「该厂商**能**做什么」；`readCapacity(node).canShare` 说的是「**这台节点
实际上报了什么**」。两者会不一致，这是刻意的：

- 纯 device-plugin 的 NVIDIA 集群：`capabilities.canShare = true`，但 `readCapacity().canShare = false`
  —— 没有 HAMi 就没人切分。
- 只注册了整卡键的 Ascend 集群：`capabilities.canShare = true`，实际只能整卡。

**判断某个节点能不能切分，看 `readCapacity`，不要看 `capabilities`。**

### 2.2 资源键与渲染语义

| 输入（`resources`） | NVIDIA | AMD | Ascend |
|---|---|---|---|
| `accelerators: 0` | `{}`（不写任何键） | `{}` | `{}` |
| `accelerators: N, memoryMiB: 0, coresPercent: 0` | `{"nvidia.com/gpu": N}`，不挂 `hami-scheduler` | `{"amd.com/gpu": N}` | `{"huawei.com/Ascend910": N}` |
| `accelerators: N, memoryMiB: M>0` | 再加 `nvidia.com/gpumem: M` | **抛错**（AMD 只有整卡申请） | 再加 `huawei.com/Ascend910-memory: M` |
| `+ coresPercent: C>0` | 再加 `nvidia.com/gpucores: C` | **抛错**（同上） | **抛错**（无算力配额资源） |
| `coresPercent: C>0` 且 `memoryMiB: 0` | **抛错**（整卡不能再限算力） | **抛错** | 先抛算力那条错 |
| `coresPercent > 100` | **抛错**（百分比点越界） | **抛错** | 先抛算力那条错 |

抛出的错误带 `code: 'ACCELERATOR_INVALID'`，`message` 是可直接展示给用户的中文（含当前值与
该改成什么），不是堆栈：

| 厂商 | 典型原文 |
|---|---|
| NVIDIA | `申请算力配额（coresPercent）时必须同时给显存配额（memoryMiB > 0）：memoryMiB=0 表示整卡，整卡不能再单独限算力` |
| AMD | `AMD 加速卡只支持整卡申请（没有 vGPU 切分资源）：请把 memoryMiB 与 coresPercent 设为 0（当前 memoryMiB=8192、coresPercent=20）` |
| Ascend | `昇腾没有算力配额资源（不存在 coresPercent 对应的扩展资源）：请把 coresPercent 设为 0（当前 10）` |
| generic | `兜底（generic）适配器没有固定的加速卡资源键：请用 readCapacity(node).resourceKey 取到该集群的真实资源键后显式传入 resourceKey` |

一律**抛错而不是静默丢字段**：显存细分在 AMD 上无法表达，静默丢弃会让人以为 8192 MiB 的限制
生效了，实际拿到的是整卡。同理「整卡 + 限算力」「昇腾 + 限算力」都是用户意图无法表达，必须喊停。

### 2.3 容量与占用怎么读

| 维度 | NVIDIA + HAMi | AMD | Ascend | generic |
|---|---|---|---|---|
| 卡数来源 | 节点注解 `hami.io/node-nvidia-register`（JSON 数组，真机唯一可靠来源）→ 退路 `nvidia.com/gpu` capacity（此时 `gpumem` 按槽位**均分**：`49000 MiB / 10 槽 = 4900 MiB/卡`，不是真实单卡容量） | `amd.com/gpu` 的 capacity/allocatable | `huawei.com/Ascend*` 资源键（按 `huawei.com/ascend` 前缀匹配，型号在键名里） | 第一个数量 > 0 的 `<domain>.com/gpu` |
| 单卡型号 | register 里的 `type` | 节点标签 `amd.com/gpu.product` / `-product-name` / `-family`（写法随发行版） | 资源键名本身（`Ascend910` / `Ascend910B` / `Ascend310P`） | 未知（只数张数） |
| 单卡显存 | register 里的 `devmem` | **未知**（`totalMemMiB: 0`） | 未知（除非装了切分插件） | 未知 |
| 槽位 | `Σ count`（`deviceSplitCount` 默认 10/卡） | 1/卡 | 1/卡 | 1/卡 |
| 占用来源 | Pod 注解 `hami.io/vgpu-devices-allocated`（旧版 `assigned`），节点归属靠 `hami.io/vgpu-node`（旧 `hami.io/vgpu-node-allocated`） | Pod 声明的 `amd.com/gpu` 数量（多容器求和） | Pod 声明的 `huawei.com/Ascend*` 数量 | 同 AMD |
| 占用能否对到具体 UUID | 只能按张数（占位 ID `nvidia.com/gpu#alloc-0` 不对应真实 UUID） | 不能 | 不能 | 不能 |

推论，三条都要记住：

- **AMD / Ascend 上「显存分配 vs 实测」这张卡是空的**：没有显存份额的概念，`allocMemMiB` 恒为 0。
  这不是采集坏了。
- **`server/k8s/hami.js` 只解析 `hami.io/vgpu-*`**，AMD / Ascend 集群的「GPU 分配（HAMi）」区域
  为空是预期行为。
- **`nvidia.com/gpumem|gpucores` 在真机 capacity 里不存在**（这是最常被读错的一处）：容量只在
  `hami.io/node-nvidia-register` 注解里。

### 2.4 监控侧（`/gpu` 页面的采集）

这一层与 infra 编排层**不是同一套代码**，别把两者的验证结论互相顶替：

| 维度 | NVIDIA | AMD | Ascend（+ 沐熙） |
|---|---|---|---|
| 型号 | `nvidia-smi --query-gpu=name` | `rocm-smi --showproductname --csv` | `npu-smi info` / `npuinfo64` |
| 显存 | `memory.used/total` | `--showmeminfo vram --csv` | `--query-gpu … memory.used` |
| 利用率 | `utilization.gpu` | `--showutilization --csv` | 部分版本缺此列 → 记 0，不是「真的空转」 |
| 进程 | `--query-compute-apps=…` | `--showpids` | `--query-processes --format=csv`（列序随版本变，解析按列名找） |
| 温度/功耗 | 有 | `--showtemp` / `--showpower` | 有（字段名随版本变） |
| 状态 | 生产在用 | 解析有单测，**未在 AMD 卡上跑过** | 解析有单测，**未在昇腾卡上跑过** |

`npu-smi` 的进程表列序在不同固件版本间会变，解析器按列名（`npu`/`device`/`index`）找而不是按
位置 —— 这是已知最脆弱的一处，换固件后第一件事是核对这张表。

---

## 3. 调度后端差异

| 后端 | 资源表达 | 本层实现 | 状态 |
|---|---|---|---|
| **HAMi 切分**（vGPU） | `gpu` + `gpumem` + `gpucores`，`schedulerName: hami-scheduler` | 渲染三件套；容量预检按**单卡**算余量与槽位；`GET /api/k8s/clusters/:id/policy` 读 binpack/spread 与超卖比 | **已实现 · 已用真机验证** |
| **官方 device-plugin 整卡** | `nvidia.com/gpu: N`（无 gpumem/gpucores） | `memoryMiB: 0` → 不挂 HAMi 调度器，只申请整卡；预检按整卡空闲判定 | **已实现 · 仅 fixture 验证**（真机集群都跑 HAMi，没有纯 device-plugin 集群可验） |
| **MIG**（A100/H100 硬切分） | `nvidia.com/mig-1g.10gb` 之类 profile 键 | 无：`accelerators` 只表达张数，没有 profile 概念，也没有 profile↔显存换算 | **未实现** |
| **k8s DRA**（1.34+，`resource.k8s.io/v1`） | `ResourceClaim` / `DeviceClass` / `ResourceClaimTemplate` | 能力位留了位置，但没有任何 DRA 对象的渲染或读取 | **未实现（接口预留）** |

与后端相关的四条现实约束：

- **HAMi 是单卡语义**：一个副本的显存/算力必须由同一张卡提供。集群总剩余 20 GiB 而每张卡只剩
  10 GiB 时，12 GiB 的副本照样放不下。预检的 `reasons` 里会明说这一条。
- **整卡模式要求那张卡完全空闲**：`memoryMiB: 0` 时 HAMi 不再切分，卡上已有别的容器就交不出来。
- **MIG 与 HAMi 互斥**：MIG 是驱动层硬切固定 profile，HAMi 是软切分；两者同时上会出现「申请了
  `gpumem` 却拿到 MIG 实例」这种无法解释的行为。本层不生成 MIG 资源，也就不会踩这个坑 ——
  需要 MIG 请在集群侧建好 profile，把每个 profile 当一个整卡用（`accelerators: 1, memoryMiB: 0`）。
- **槽位是最容易忽略的上限**：卡上 10 个僵尸容器把 slot 占满时，显存空着也排不进去。

---

## 4. 状态判定口径

| 标记 | 判定条件（全部满足才配得上） | 本次取证方式 |
|---|---|---|
| **已用真机验证** | ① 代码路径完整 ② 在真实 GPU 上执行过 ③ 结果有记录（含失败的、效果打折的） | `deploy/k8s/cluster/README.md` 实测表：显存隔离、超卖拦截、同卡多租户、故障隔离、算力准入 5 项 ✅、算力限流 ⚠️ 弱；注解解析口径由 `server/__tests__/k8s-hami.test.js`、`k8s-gpu-usage.test.js` 固化 |
| **仅 fixture 验证** | ① 代码路径完整 ② 单测用构造的节点/Pod 对象覆盖正例与反例 ③ **没有**在对应硬件上执行过 | AMD / Ascend / 整卡 device-plugin 复用同一套渲染与预检代码，硬件不在手上，断言只在 fixture 上跑过 |
| **未实现** | 代码里没有这条路径；调用会明确报错或降级，不静默假装 | MIG、DRA：渲染层无 profile 概念、无 `resource.k8s.io` 对象 |
| **接口预留** | 只有能力位或注释，没有可执行路径 | DRA |

逐行依据：

| 行 | 标记 | 依据 |
|---|---|---|
| NVIDIA + HAMi | 已用真机验证 | 真机：配额 4096 MiB 的容器内 `nvidia-smi` 显示 `memory.total=4096`（物理卡 32607）；申请 32 GiB → `Pending` + `CardInsufficientMemory`；3 个 reranker 共卡各锁 5888 MiB 互不越界；配额 4 GiB 的进程申请 12 GiB → `HAMI-core OOM`，同卡邻居仍 `Running`；算力占满 → `CardInsufficientCore` |
| NVIDIA 算力限流 | 已用真机验证（**效果弱**） | 3000×4096² matmul：配额 10 点 12.95s vs 不限 10.26s，仅慢 26%，远小于名义 10 倍。`gpucores` 是调度准入硬约束，运行时限流对大 kernel 基本无效 |
| NVIDIA 整卡（device-plugin） | 仅 fixture 验证 | `memoryMiB: 0` 分支不挂 `hami-scheduler`，单测断言渲染与预检；真机集群没有纯 device-plugin 环境 |
| NVIDIA MIG | 未实现 | 渲染只产出张数，没有 MIG profile 键，也没有 profile↔显存换算 |
| k8s DRA 1.34+ | 未实现（接口预留） | 无 `ResourceClaim` / `DeviceClass` 渲染 |
| AMD `amd.com/gpu` | 仅 fixture 验证 | 资源键与整卡语义在 fixture 上验证；`rocm-smi` 的**监控侧**解析在 `server/gpu.js`（有单测），但那不等于 infra 层在 AMD 卡上跑过。另：`totalMemMiB`/`totalCores` 在 AMD 上无法从节点读出，预检只能按张数判断 |
| Ascend `huawei.com/Ascend910` | 仅 fixture 验证 | 同上；`npu-smi` 监控侧解析存在（列序随固件变，属已知脆弱点）；`-memory` 键只在装了切分版插件的集群才有，未验 |
| generic（兜底） | 仅 fixture 验证 | 用于 mock 集群与未知厂商；资源键从节点实际资源里取，取不到就不写任何加速卡资源 |

---

## 5. 新增一家卡的步骤清单

以厂商 `acme`、资源键 `acme.com/gpu` 为例。顺序不能乱：第 2 步漏了会得到「校验通过、渲染时
抛错」的半成品。

| # | 做什么 | 改哪个文件 | 怎么验 |
|---|---|---|---|
| 1 | 写适配器：`vendor`、`capabilities`、`detectFromNode(node)`、`readCapacity(node)`、`readAllocation(pod)`、`renderResources({accelerators, memoryMiB, coresPercent})`、`probeCommand()`、`peakFlops(modelName, dtype)` | 新建 `server/infra/accelerator/acme.js`（可 `import` `generic.js` 的 `wholeCardDevices` / `matchPeak` / `coerceCount` 等工具，别重复实现） | 纯函数直接单测；`renderResources` 必须返回 `Record<string,string>`，非法组合抛 `code: 'ACCELERATOR_INVALID'` |
| 2 | 注册：`ADAPTERS` 表、`DETECT_ORDER`（具体厂商在前，`generic` 永远最后）、`VENDOR_ALIASES`（容忍 `ACME` / `acme.com` 写法，认不出回落 `generic`） | `server/infra/accelerator/index.js` | `getAdapter('acme')` 返回新适配器；`getAdapter('nonsense')` 回落 `generic` 而不是 `undefined`；`detectAccelerator(node)` 在混合节点上按 `DETECT_ORDER` 取第一个 |
| 3 | 加厂商枚举 | `server/infra/model.js#ACCELERATOR_VENDORS` | `validateModelService({resources:{vendor:'acme'}})` 通过；非法值仍被拒 |
| 4 | 峰值算力表补条目（否则 MFU 永远 `—`） | 适配器内的 `PEAKS`（`nvidia.js` 这样做），或 `server/gpu-mfu.js#GPU_PEAK_FLOPS`（监控侧 MFU 用） | `getAdapter('acme').peakFlops('ACME A1000')` 返回数值；`lookupPeakTflops` 对同一型号也给值 |
| 5 | 复核容量预检的厂商语义 | `server/infra/capacity.js`（`DEFAULT_DEVICE_SLOTS`、整卡判定、`memoryMiB: 0` 与 `coresPercent: 0` 的不对称） | fixture：整卡模式下卡片被占用时 `fits: false`；差 1 MiB 也判放不下（别被四舍五入藏起来） |
| 6 | 补测试：正例 + 反例（缺字段、非法配额、未知型号、探测失败、同卡多租户） | `server/__tests__/infra-accelerator.test.js` | `npx vitest run server/__tests__/infra-accelerator.test.js` 全绿 |
| 7 | 真机验收：节点打设备插件标签、装 device-plugin、`probeCommand()` 能跑、`readCapacity` 的卡数与 `/k8s` 面板一致、起一个 1 副本小配额服务并确认容器内配额生效 | 集群侧 + `/infra` | 容器内用该厂商工具确认（`rocm-smi` / `npu-smi`），不是看 YAML |
| 8 | 回来升级本文件的矩阵：把「仅 fixture 验证」改成「已用真机验证」，并写清取证方式 | `docs/INFRA-COMPAT.md` | 依据必须是可复现的命令输出 |

---

## 6. 峰值算力表：来源与局限

两张表，别混用：

| 表 | 位置 | 谁在用 | 覆盖 |
|---|---|---|---|
| 适配器 `PEAKS` | `server/infra/accelerator/{nvidia,amd,ascend}.js` | 容量预检 / 推荐配额的算力折算 | NVIDIA 16 个型号、AMD 4 个（MI300X/MI250X/MI210/MI100）、Ascend 2 个（910B/310P） |
| 监控 `GPU_PEAK_FLOPS` | `server/gpu-mfu.js` | `/gpu` 与 `/k8s` 的 **MFU** 分母 | 18 个 NVIDIA 型号 |

值是 **FP16/BF16 稠密** TFLOPS；FP8 只对表里写明的型号有意义，其余为 `null`（不折算）。
来源：各型号公开规格页的稠密 Tensor Core 峰值。**两张表都是硬编码**，新卡必须补代码。

局限（每一条都会让数字偏大或偏小，看到异常先对这里）：

| 局限 | 后果 |
|---|---|
| **覆盖有限** | 表里没有的型号 → `peakFlops()` 返回 `null` → MFU `available:false` + 「未知 GPU 型号…的峰值算力」。这不是「MFU 为 0」 |
| **硬编码** | 新卡要改代码；改完必须跑 `gpu-mfu` / `infra-accelerator` 的单测 |
| **别名宽松** | `rtx 4090` 会同时命中桌面版与笔电版（后者峰值明显更低）→ MFU 偏小，看着像「跑得差」，其实是表不准 |
| **稠密口径** | 表里没有稀疏（2:4）值；引擎若用稀疏 kernel，实测会超过「100% MFU」 |
| **只分两族精度** | 只有 `fp16`/`bf16` 与 `fp8`；TF32 / INT8 一律按 FP16 峰值比较，结论只对 FP16/BF16 推理成立 |
| **单卡峰值** | MFU 分母取「相关卡的 `min(峰值)`」，是单卡口径；多卡张量并行的聚合效率不在这个数字里，也不要把 8 卡 MFU 相加 |
| **AMD 只有 fp16** | AMD 表里没有 FP8 值，查 FP8 返回 `null`，不编数字 |
| **Ascend 只收两型** | `Ascend910B` / `Ascend310P`；`Ascend910`（无 B 后缀）等其它写法返回 `null` |
| **两张表不一致** | 监控侧 `GPU_PEAK_FLOPS` 有 `H800` 与 `L40`，适配器侧 `PEAKS` 没有 → 同一块 H800：`/gpu` 的 MFU 有值，容量预检的算力折算却是 `null`。补表时两处一起补 |

补表流程：改表 → `npx vitest run server/__tests__/gpu-mfu.test.js server/__tests__/infra-accelerator.test.js`
→ 在 `/gpu` 页对一个已知负载核对 MFU 是否落在合理区间（推理通常 5%–60%，超过 100% 一定是表错了）。

---

## 7. 已知降级与不兼容

| 场景 | 行为 | 怎么发现 |
|---|---|---|
| `resources.vendor` 不在枚举里 | `validateModelService` 报错，不渲染 | 错误信息列出允许值 |
| 厂商名认不出（`'intel'`、拼错） | `getAdapter` 回落 `generic`（**不猜**）；generic 下 `accelerators > 0` 又没给 `resourceKey` 时抛错 | 错误提示「没有指定加速卡厂商」/「需要同时传 resourceKey」 |
| 适配器模块加载失败 | 渲染抛中文错误：缺 `renderAcceleratorResources()` 或 `getAdapter()` | `apply` 停在渲染步骤，集群没动 |
| 型号亲和没有匹配节点 | 预检 `fits:false`，`reasons` 明说「等于可用卡数为 0」；强行提交则 Pod `Pending` + `FailedScheduling` | 先看预检，不要先看 Pod 事件 |
| 节点缺 `openlog.io/accelerator-model` 标签却用了亲和 | 永远 `Pending`（没有节点匹配 `nodeAffinity`） | 预检里型号亲和那条；`kubectl get node --show-labels` |
| 在 HAMi 集群上用整卡模式 | 不挂 `hami-scheduler`，由默认调度器分配；HAMi 的 binpack / 超卖对它不起作用 | `GET /api/k8s/clusters/:id/policy` 的策略与实际落点不符时先怀疑这个 |
| AMD 上要显存份额 / 算力配额 | 渲染直接抛错（`ACCELERATOR_INVALID`），不生成对象：只有整卡申请这一条路 | `apply` 停在渲染步骤，`detail` 里带「请把 memoryMiB 与 coresPercent 设为 0」 |
| Ascend 上要算力配额 | 渲染直接抛错（昇腾没有算力配额资源） | 同上；错误原文点名 `coresPercent` |
| 用 `vendor: generic` 提交服务定义 | 渲染抛错：generic 没有固定资源键，而 `ModelService` 里没有 `resourceKey` 字段可传 —— generic 只用于预检/mock | `apply` 停在渲染；正式定义请显式给 `nvidia` / `amd` / `ascend` |
| `nvidia-smi` 采不到（权限/驱动/SSH 不通） | 实测字段 `measured: false`，分配侧照常 | `/k8s` 的 GPU 使用率卡显示 `—` 而不是 0 |
| 峰值算力表里没有这张卡 | MFU `available:false` + `reason` | 同上；此时只能用分配/实测两层判断 |

---

## 附录：适配器契约

四家实现同一套接口（`server/infra/accelerator/index.js` 的 `ADAPTERS`）：

| 成员 | 签名 | 说明 |
|---|---|---|
| `vendor` | `string` | `nvidia` / `amd` / `ascend` / `generic` |
| `capabilities` | `{ canShare, canLimitCores, memUnitMiB, wholeCardResource }` | 「该厂商能做什么」，与节点实际能力可能不同 |
| `detectFromNode` | `(node) => boolean` | 证据：资源键、HAMi 注解、设备插件标签。只看 `allocatable` 会漏掉「卡已分完」的节点 |
| `readCapacity` | `(node) => { devices[], totalMemMiB, totalCores, slots, canShare, resourceKey, source }` | `source` 标明数据来自 `register` / `resource` / `none`，不猜 |
| `readAllocation` | `(pod) => { devices[], totalMemMiB, totalCores, nodeName, source }` | 整卡厂商只能按张数，占位 ID 不对应真实 UUID |
| `renderResources` | `({accelerators, memoryMiB, coresPercent}) => Record<string,string>` | 非法组合抛 `code: 'ACCELERATOR_INVALID'`，`message` 可直接展示 |
| `probeCommand` | `() => string` | `nvidia-smi` / `rocm-smi` / `npu-smi`；generic 无 |
| `peakFlops` | `(modelName, dtype) => number\|null` | 只认 `fp16`/`bf16`/`fp8`；认不出返回 `null`（不编数字） |

另外三个模块级函数：

| 函数 | 作用 |
|---|---|
| `getAdapter(vendor)` | 厂商名归一化（别名表）+ **任何输入都不抛**，认不出回落 `generic` |
| `detectAccelerator(node)` | 按 `DETECT_ORDER`（nvidia → amd → ascend → generic）取第一个；无证据返回 `null` |
| `renderAcceleratorResources({vendor, accelerators, memoryMiB, coresPercent, resourceKey})` | 上层唯一该调用的渲染入口（含归一化与回落） |
