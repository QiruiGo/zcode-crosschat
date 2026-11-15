---
description: 写一份交接检查点到 .crosschat/checkpoints/<你>/（身份/我的任务/待领池/journal 摘要/未读/建议下一步/note），压缩或换会话前先用它落盘。
argument-hint: "[一句话备注]"
skills: crosschat
---

按 `crosschat` 技能的协议处理本请求：

$ARGUMENTS

1. 调用 `xc_team({action:"checkpoint"[, note:"<上面的一句话备注>"]})`——由服务端直接落盘，不要自己写文件。
2. 把返回的 `path`、`bytes`、开放任务数、未读数原样回报用户；写失败时如实说明错误码（如 `checkpoint_write_failed`）与恢复动作，不得声称已落盘。
3. 若返回 `capacity.level = RED`，提醒用户：先按 longtask 压缩前 checklist 落 journal，再接受压缩。
