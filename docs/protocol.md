# 课程运行记录的提交边界与尝试归属采集接入约定

## 来源获取

获授权供应方网关 `/runtime` 返回文件目录、相对path、原始格式、修订号与href。GET `/raw/路径` 获得原始字节，ETag与内容绑定，条件请求304不带正文。legacy只开放第一项，feature开放完整本地资料；不需要访问真实机构或下载生产数据。目录不是完成性证明，文件可有503或404，源缺件和字段未决分别记录。真实格式范围以本文profile为准，不要求实现所引标准所有未使用扩展。

## 数据解释

授权导出的运行调用按seq给出，Initialize声明session对应learner/course/attempt，后续行只带session；seq全源唯一但不是业务结果身份。这里不执行课程包。SetValue成功仅写工作集，Commit结果false不更新确认快照，成功才确认；Terminate成功亦提交并结束会话，异常失败不假定终结。输出id=learner:course:attempt，confirmed及working分别表示已确认和未确认值。本例confirmed.cmi.completion_status=incomplete，working中为completed；不生成已结课事实。GetValue空字符串结合error保留两种不同观察。

## 解释语义与落地结构

`mode:'managed'`按seq对全部来源调用做一次有序重放，结果由源码事实决定，不靠固定样本答案。规则如下：

1. `Initialize`声明会话归属；成功时工作集从确认快照恢复，暂停前未提交的值不会跨会话保留。同一learner/course/attempt再次Initialize仍是同一尝试，不新增业务记录。
2. `SetValue`仅在`result:'true'`且`error:'0'`时写入工作集；失败写入`rejected`，不改确认快照。
3. `Commit`成功才以工作集替换确认快照并记为一次确认；失败只记录`rejected`。
4. `Terminate`成功先提交再结束会话；失败不结束会话、不提交。每个尝试最多产生一个`completion`事实，重复投递或补发不会新增。
5. `GetValue`是观察而非写入。`error:'0'`的空字符串是`empty-value`，`error:'403'`是`uninitialized`，两者都按出现顺序保留在`reads`中。
6. `cmi.interactions.N.*`、`cmi.objectives.N.*`按数组下标归集到所属尝试的`confirmedViews`/`workingViews`；下标在不同尝试间可复用，因此分组从不跨尝试。`cmi.location`与`cmi.suspend_data`作为恢复位置进入`recovery`。
7. 原始调用按seq保存在`interpretation.calls`，含documents.path、revision、digest与seq，供逐条核对，与规范化结果分离但共用同一解释版本。
8. 无Initialize可归属的调用进入`interpretation.unresolved`，不臆造尝试；文档缺失、临时失败或不可解析以带`source`和`revision`的notes保留，已确认内容不因单文档失败而消失。
9. 同一seq在后续投递中内容不同即为引用冲突：保留首次读取，并把两处来源位置记入`interpretation.conflicts`；存在冲突时`complete`为false。

解释版本记录在`interpretation.interpretation`。管理员视图区分`confirmed`（平台已确认）与`working`（含未提交值），并以`rejected`说明被拒绝的调用。不计算成绩：`cmi.score.*`只作为GetValue观察保留，`completion`只反映已确认的`cmi.completion_status`。

## 修订和补件

本地测试可用 `source.state.round=2` 驱动一次修订：追加seq10成功Commit，之后confirmed可变为completed，但重复导入seq10只形成一次确认事件。 `state.failDoc`、`state.missingDoc`可设为目录document.id，分别模拟临时失败与缺件，清空后恢复。采集端只能经HTTP观察，不允许读取source.state或fixture.expectedIds作为采集结果。fixture.expectedIds仅是公开验收对照。原始资料及解释版本需要可核对；失败不能使已确认内容凭空消失。把已取得的文件索引、源端修订、规范化记录及字段来源协同持久化；存储结构可扩展，不规定实现架构。重投时以ETag条件请求识别未变文档，304复用已留存字节，不把未变内容重复解释为新事件。

完整性至少区分取得文件与解释关系两个层次；已隔离的未知字段不能被称作已解释。notes为现有人工诊断入口，可扩展结构，但信息应包含具体资料位置和未决原因。文件级原始证据由Repository.retain保留。legacy的人工预览入口继续可用；managed模式负责结构化接入。

## 验证矩阵

1. 按样本跨文件完成 运行调用生命周期采集 与 提交确认与暂存值分离，不以读取目录或预览摘要代替。
2. 对同一原始资料重复投递及重开存储，规范化身份不膨胀，来源证据仍可追溯。
3. 尝试/会话/数组身份 不因缺件或顺序改变而被默认值掩盖；补件后只重解释受影响对象。
4. 使用round=2比较新旧解释，说明 返回错误与未知值保真 如何留痕。
5. 在原始资料已保存、关系尚未提交等边界终止进程，再启动能识别待完成工作；不得靠固定样本答案实现。

`acceptance/managed.test.mjs`覆盖关键正例、重启重投、修订、缺件、临时失败、不可解析资料、引用冲突与进程终止恢复，并按以上矩阵保留异常和来源变化测试。资料未齐时保留可解释未决，不为“通过”填充不存在的源值。
