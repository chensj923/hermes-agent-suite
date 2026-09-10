---
name: git-workflow
description: 在工作区使用 git 的规范：先看状态、小步提交、不擅自 push 与 reset
---

# Git 使用规范

## 动手前先看清楚

```powershell
git status
git log --oneline -10
```

## 提交规范

- 一次提交只做一件事。
- 提交信息用中文或英文均可，但要说清"改了什么、为什么"，例如：`fix: 修复登录页重复提交`。
- 提交前用 `git diff` 自己审一遍，不要把调试代码、临时文件、密钥提交进去。

## 禁止擅自执行的操作

以下操作会改变历史或影响远端，**必须先征得用户同意**：

- `git push`（尤其 `--force`）
- `git reset --hard`
- `git clean -fd`
- `git rebase`、`git commit --amend`（会改写历史）
- 删除分支、改 `.gitignore` 之外的大范围文件移动

## 常见查看命令

```powershell
git diff                 # 未暂存的改动
git diff --staged        # 已暂存的改动
git log -p -3            # 最近三次提交的详细内容
git branch -a            # 全部分支
```
