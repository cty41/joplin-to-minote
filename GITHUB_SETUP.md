# GitHub 上传说明

仓库已初始化并完成首次提交。要推送到 GitHub：

## 1. 在 GitHub 创建仓库

1. 登录 [GitHub](https://github.com)
2. 点击 **New repository**
3. 仓库名：`joplin-to-minote`
4. 选择 **Public**
5. **不要**勾选 "Add a README"（本地已有）
6. 点击 **Create repository**

## 2. 添加远程并推送

将 `<username>` 替换为你的 GitHub 用户名：

```bash
cd e:\Code\joplin-to-minote
git remote add origin https://github.com/<username>/joplin-to-minote.git
git push -u origin main
```

例如用户名为 `chengtianyi`：

```bash
git remote add origin https://github.com/chengtianyi/joplin-to-minote.git
git push -u origin main
```
