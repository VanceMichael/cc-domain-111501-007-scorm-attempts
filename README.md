# 课程运行记录的提交边界与尝试归属采集

Node.js 22.23.4 ESM 资料接入服务。现有服务提供单文件预览、原始字节留存和重复导入；自动结构化接入由managed模式调用。`docs/protocol.md`说明获授权来源的资料范围、引用语义和修订行为，`fixtures/raw`是极小本地合成原件，不含真实机构账号或个人数据。

## 环境与可执行命令

只需要Linux、Node.js 22.23.4和npm，无第三方包。package-lock.json与源码共同保存，安装、测试和运行不下载任何资料或依赖。

```sh
npm run build
npm test
npm run demo
```

build逐个检查src、simulator、scripts、test、acceptance内的ESM语法；test验证旧版预览、来源HTTP缓存与故障响应、存储重开。demo当场创建空目录并启动真实回环HTTP服务、调用采集器后打印取得的记录、来源证据和请求列表；结束时关闭服务并清理临时目录。它不是日志回放，也不会把预览结果说成完整接入。固定小样本预计数秒，可在90秒内现场展示。

## 调用边界

`collect({base,repository,mode})`是采集入口，默认旧预览模式；`mode:'managed'`供上层请求结构化接入。返回值延续imported和complete，complete只能表示协议下已核对的完成状态，不可由HTTP200或预览成功推断。`Repository`中的records、evidence、cursors、notes是现有持久化接口，可为业务一致性扩展结构及事务；旧记录和原始字节应继续可读。

`createSource({scenario:'legacy'|'feature'})`创建本地来源，提供base/state/requests/close；legacy只含首个文件，feature开放整组关联资料。测试用state.round、failDoc、missingDoc驱动来源变动，采集端只经HTTP观察这些变化，不读取模拟器内部数据。详细字段及公开行为矩阵见协议。

## 特性验收与恢复

```sh
npm run acceptance
```

acceptance与基线回归分开，覆盖运行调用生命周期、确认值与工作值分离、跨文档与数组身份、修订只确认一次、缺件/临时失败下的未决保留、ETag 304重投、原始留存后中断再启动，以及独立进程重开存储。实现不依赖固定样本答案。

## 解释层结构

`src/interpreter.mjs`按seq重放调用：Initialize只声明会话并从确认快照恢复工作集，SetValue成功只写工作集，Commit/Terminate成功才替换确认快照，Terminate失败不结束会话。每个attempt最多一个`completion`事实；交互与目标按数组下标归集在所属attempt内，`cmi.location`/`cmi.suspend_data`进入`recovery`。GetValue保留`empty-value`、`uninitialized`、`error`三种观察及顺序。`interpretation.calls`保留原始调用顺序、来源路径、修订与摘要，供管理员逐条核对。不执行课程代码，也不计算成绩。

## 离线容器

```sh
docker build --pull=false -t scorm-attempts:local .
docker run --rm --network none scorm-attempts:local npm test
docker run --rm --network none scorm-attempts:local npm run demo
```

Dockerfile使用node:22.23.4-bookworm-slim，不安装额外依赖。镜像准备好后正式命令禁网运行，来源和接入器在同一应用容器中通过回环HTTP协作，无需浏览器、设备、外部数据库或额外容器。
