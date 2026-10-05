# 数据中心变更窗口与回滚方案审阅平台

面向机房运维、系统、安全和业务负责人的生产变更审阅工作台。工程使用 Angular CLI 独立构建，所有变更记录会写入浏览器 `localStorage`，首次运行通过 `HttpClient` 加载 `public/mock/change-requests.json`。

## 技术栈

- Angular 22 + Angular CLI + TypeScript
- Clarity Angular 18 + Clarity UI
- NgRx Store + Effects
- Angular Router + HttpClient
- RxJS

## 功能

- 变更列表搜索，以及按状态、资源类型和风险等级筛选
- 新建变更方案，维护资源、依赖、执行步骤、回滚步骤、值守人员和窗口
- 依赖关系图与共享资源窗口甘特图
- 依赖遗漏、窗口冲突、回滚不可执行、关键服务观察窗口不足校验
- 网络、系统、安全、业务负责人顺序会签，会签记录绑定方案版本
- 执行步骤勾选、实时日志入口、执行偏离记录、完成或回滚判定
- 回滚演练：回滚步骤、资源依赖、演练批次与会签绑定同一方案版本
- 演练批次占用隔离链路，按共享资源与正式变更排队，冲突资源未释放不可开始
- 演练成功冻结拓扑与命令摘要并签发凭证，仅该凭证可放行开始执行
- 拓扑、命令或窗口变化即推进方案版本：未执行批次作废，已执行批次保留原凭证
- 两名值班员同时提交同一版本时先到生效，后到的批次保留为冲突记录
- 演练批次写前日志：写入失败后从完整批次恢复，重复重放不新增凭证
- 旧方案没有凭证的列入待补清单，不能开始执行
- 审批冻结、审计轨迹和复盘 Markdown 导出
- 基于 NgRx 的状态流转与 localStorage 持久化

## 运行

```bash
npm install
npm start
```

默认开发地址为 `http://localhost:18469`。

生产构建：

```bash
npm run build
```

构建输出位于 `dist/pair-wise-gsb-69/browser`。

## 目录

```text
src/app/
  components/             依赖图、甘特图、校验、审计组件
  models/                 领域模型和校验规则
  pages/                  列表、新建、详情工作区
  services/               HttpClient 数据加载、localStorage、复盘导出
  store/                  NgRx actions、reducer、effects、selectors
```
