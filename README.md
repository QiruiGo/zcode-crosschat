# zcode-crosschat

为 zcode（GLM 系 CLI agent）设计的跨对话协作插件——让多个独立 zcode 会话之间互相派发任务、执行并回传结果，对齐 Claude Code 生态的跨对话协作能力。

## Status

开发中（WIP）。本插件的设计源于对 opencode/DeepSeek 生态中最受欢迎的同类插件的调研与机制分析，设计文档将随开发推进发布。

## 目标能力

1. 会话 A → 会话 B 任务派发
2. 会话 B 执行并回传结果
3. 过程可观测（日志/文件）
4. 任务状态跟踪
5. 并行多会话编排

> 以上均为设计目标，尚未实现任何功能。

## License

[MIT](./LICENSE)
