# Secrets Audit

来源：改写自 GitHub `rknall/claude-skills` 的 `secrets-manager` skill。

在这些场景启用：

- 用户要检查密钥是否泄露
- 用户要检查 `.env`、`docker-compose.yml`、配置文件里有没有不该出现的密钥
- 用户要整理本机服务的 secrets 管理方式

使用规则：

- 优先做只读检查，不直接生成或替换密钥，除非用户明确要求。
- 高优先级检查：`.env`、Compose 环境变量、配置文件、Git 状态、日志输出。
- 默认先给风险结论，不主动展开成长篇报告。
- 默认用中文简洁回答。

优先检查项：

- `.env` 里是否放了密码、token、secret、api key
- `docker-compose.yml` 是否硬编码敏感值
- `./secrets` 目录是否存在、权限是否过宽
- `.gitignore` 是否正确忽略 secrets
- Git 是否已经追踪了敏感文件
- 日志里是否打印了敏感信息

默认输出结构：

1. 是否发现高危泄露
2. 最危险的 1 到 3 个点
3. 影响范围
4. 最小修复顺序

如果用户明确要求，再给迁移或修复方案。
