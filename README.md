# 智汇云舟

该项目旨在创建一个基于React18 的学习平台,有直播,文章等,集成AI功能

## 📝 提交规范

### 提交信息格式

使用 [Conventional Commits](https://www.conventionalcommits.org/) 规范：

```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

### 提交类型说明

| 类型       | 说明                         | 示例                        |
| ---------- | ---------------------------- | --------------------------- |
| `feat`     | 新功能                       | `feat: 添加用户登录功能`    |
| `fix`      | Bug修复                      | `fix: 修复登录表单验证问题` |
| `docs`     | 文档更新                     | `docs: 更新API文档`         |
| `style`    | 代码格式(不影响功能)         | `style: 格式化代码`         |
| `refactor` | 重构(既不是新功能也不是修复) | `refactor: 重构用户服务`    |
| `perf`     | 性能优化                     | `perf: 优化列表渲染性能`    |
| `test`     | 添加或修改测试               | `test: 添加登录功能测试`    |
| `chore`    | 构建过程或辅助工具变动       | `chore: 更新依赖包`         |

### 作用域说明

常用作用域包括：`auth`, `ui`, `api`, `utils`, `config` 等

## 项目开发规范

### 命名规范

- prop 命名使用 `kebab-case` 形式，如 `user-name`。
- 组件 命名使用 `PascalCase` 形式，如 `UserProfile`。
- 文件夹名称 采用 `kebab-case` 形式，如 `user-profile`。
- 变量命名 使用 `camelCase` 形式，如 `userName`。
- 常量命名 使用全大写和下划线连接，如 `API_BASE_URL`。
- 函数命名 使用 `camelCase` 形式，如 `fetchUserData()`。
- 类名命名 使用 `PascalCase`，如 `UserCard`。
- 接口命名 使用 `I` 前缀 + `PascalCase`，如 `IUser`。
- CSS 类名命名 遵循 BEM (Block Element Modifier) 方法论：如 `.user-card`

### 📏 开发规范

为了确保代码质量和团队协作效率，本项目制定了以下开发规范，请所有开发者严格遵守。

#### 📋 规范目录

- [分支管理](#分支管理)
- [提交规范](#提交规范)
- [命名规范](#命名规范)
- [代码组织](#代码组织)
- [注释规范](#注释规范)

---

### 🌳 分支管理

#### 分支策略

本项目采用 **Git Flow** 工作流：

```
main (主分支 - 生产环境)
├── develop (开发分支 - 测试环境)
│   ├── feature/user-login (功能分支)
│   ├── feature/dashboard (功能分支)
│   └── bugfix/header-style (修复分支)
└── hotfix/security-fix (热修复分支)
```

#### 分支命名规范

| 分支类型 | 命名格式          | 示例                    | 用途             |
| -------- | ----------------- | ----------------------- | ---------------- |
| 功能开发 | `feature/功能名`  | `feature/user-auth`     | 新功能开发       |
| Bug修复  | `bugfix/问题描述` | `bugfix/login-error`    | Bug 修复         |
| 热修复   | `hotfix/紧急修复` | `hotfix/security-patch` | 生产环境紧急修复 |
| 发布分支 | `release/版本号`  | `release/v1.2.0`        | 发布前准备       |

#### 分支操作流程

```bash
# 1. 创建功能分支
git checkout develop
git pull origin develop
git checkout -b feature/user-profile

# 2. 开发完成后推送
git add .
git commit -m "feat: add user profile page"
git push origin feature/user-profile

# 3. 创建 Pull Request 到 develop 分支
# 4. 代码审查通过后合并，删除功能分支
```

#### 分支保护规则

- ✅ `main` 分支：禁止直接推送，需要 2人审查
- ✅ `develop` 分支：禁止直接推送，需要 1人审查
- ✅ 所有分支合并前必须通过 CI/CD 检查

---

### 📝 提交规范

#### Conventional Commits 规范

我们采用 [Conventional Commits](https://www.conventionalcommits.org/) 规范：

```
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
```

#### 提交类型 (type)

| 类型       | 描述       | 示例                                       |
| ---------- | ---------- | ------------------------------------------ |
| `feat`     | 新功能     | `feat: add user login functionality`       |
| `fix`      | Bug 修复   | `fix: resolve header navigation issue`     |
| `docs`     | 文档更新   | `docs: update API documentation`           |
| `style`    | 代码格式化 | `style: format code with prettier`         |
| `refactor` | 代码重构   | `refactor: optimize user service logic`    |
| `perf`     | 性能优化   | `perf: improve list rendering performance` |
| `test`     | 测试相关   | `test: add unit tests for user service`    |
| `build`    | 构建系统   | `build: update webpack configuration`      |
| `ci`       | CI/CD 配置 | `ci: add github actions workflow`          |
| `chore`    | 其他杂务   | `chore: update dependencies`               |
| `revert`   | 回滚提交   | `revert: rollback user login changes`      |

#### 作用域 (scope)

作用域用于指明提交影响的范围：

```bash
feat(auth): add OAuth login support
fix(ui): resolve button hover state
docs(api): update user endpoints documentation
perf(dashboard): optimize chart rendering
```

#### 提交描述规范

##### ✅ 好的提交信息

```bash
feat(auth): implement JWT token refresh mechanism
fix(ui): resolve mobile navigation menu overflow
docs(readme): add development setup instructions
perf(api): optimize database query for user list
refactor(utils): extract common validation functions
```

##### ❌ 不好的提交信息

```bash
fix bug
update code
add stuff
changes
wip
...
```

#### 提交信息模板

创建提交信息模板文件 `.gitmessage`：

```
# <type>[optional scope]: <description>
# |<----  Using a Maximum Of 50 Characters  ---->|

# Explain why this change is being made
# |<----   Try To Limit Each Line to a Maximum Of 72 Characters   ---->|

# Provide links or keys to any relevant tickets, articles or other resources
# Example: Github issue #23

# --- COMMIT END ---
# Type can be
#    feat     (new feature)
#    fix      (bug fix)
#    refactor (refactoring production code)
#    style    (formatting, missing semi colons, etc; no code change)
#    docs     (changes to documentation)
#    test     (adding or refactoring tests; no production code change)
#    chore    (updating grunt tasks etc; no production code change)
# --------------------
# Remember to
#    Capitalize the subject line
#    Use
```
