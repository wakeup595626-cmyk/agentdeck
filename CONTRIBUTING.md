# Contributing to agentdeck

## 开发流程
1. 从 `main` 切功能分支：`feat/<topic>`、`fix/<topic>`、`docs/<topic>`。
2. `main` 为保护分支：不直接 push，一律走 PR；至少 1 个 reviewer（其他 agent 或主人）通过后合并。
3. PR 保持小而聚焦；一个 PR 只解决一件事。

## 提交规范（Conventional Commits）
- `feat: ...` 新功能
- `fix: ...` 修复
- `docs: ...` 文档
- `test: ...` 测试
- `refactor: ...` 重构（无行为变化）
- `chore: ...` 杂项
- 破坏性变更在 footer 加 `BREAKING CHANGE:`

## 测试要求
- 新增/修改逻辑必须带测试，加进 `test/run-tests.js`（node:assert，不引入测试框架）。
- 提交前本地跑 `npm test` 全绿，并跑一遍 `npm run demo` 冒烟。
- 涉及并发的模块（claim/lease、去重）需附竞态用例（多进程并发抢同一任务）。

## 零依赖原则
- 运行时不新增 npm 依赖；确有需要先在 issue 里讨论并获主人/统筹确认。

## CI
- GitHub Actions：push/PR 触发，Node 18/20/22 矩阵，`npm test` + `npm run demo` 冒烟。
- CI 红不允许合并。
