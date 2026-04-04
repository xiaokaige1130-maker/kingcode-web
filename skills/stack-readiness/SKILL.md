# Stack Readiness

来源：改写自 GitHub `rknall/claude-skills` 的 `stack-validator` skill。

在这些场景启用：

- 用户要检查某个部署项目是否“能上线”
- 用户要做部署前巡检
- 用户要检查目录结构、环境变量、Compose 配置、密钥和服务依赖是否合理

使用规则：

- 重点做检测和汇总，不默认直接改项目。
- 优先看会影响上线和稳定性的缺陷，不纠结低价值格式问题。
- 默认用中文短答。

优先检查项：

- `docker-compose.yml` 是否存在明显问题
- `.env` 和 `.env.example` 是否对齐
- `config`、`secrets`、临时目录是否合理
- secrets 是否放错地方
- 是否存在 root 拥有的异常文件
- Docker / Compose 配置是否适合生产运行

默认输出结构：

1. 当前是否具备上线条件
2. 阻断上线的关键问题
3. 建议先修哪几个点
4. 哪些只是次要优化项

如果用户要求更细，再展开成详细检查项。
