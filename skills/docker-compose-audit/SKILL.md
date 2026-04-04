# Docker Compose Audit

来源：改写自 GitHub `rknall/claude-skills` 的 `docker-validation` skill。

在这些场景启用：

- 用户要检查 Dockerfile
- 用户要检查 Docker Compose 配置
- 用户要看容器部署是否符合生产最佳实践

使用规则：

- 优先检查生产可用性和安全性，不纠结低价值格式问题。
- 先看 Dockerfile、Compose 文件，再结合本机 `docker compose config`、`docker compose ps`、日志一起判断。
- 默认用中文简洁输出，不贴大段配置。

优先检查项：

- 是否使用 `latest`
- 是否缺失健康检查
- 是否 root 用户运行
- Compose 是否有过时写法
- 环境变量、端口、卷挂载是否存在明显风险
- 多阶段构建是否合理

默认输出结构：

1. 当前配置是否适合上线
2. 最大的 1 到 3 个风险点
3. 风险影响
4. 最先该改什么

如果用户要求修复，再进入具体改法或配置调整。
