# Joplin to Minote

将 Joplin 导出的 Markdown 笔记批量导入到小米云笔记（Xiaomi Cloud Notes）。

## 功能

- **批量导入**：支持单个文件或整个目录递归导入
- **文件夹分类**：根据本地子目录自动创建小米云文件夹并分类（默认启用）
- **Front Matter 支持**：自动解析 YAML Front Matter，提取标题、创建时间等元数据
- **时间顺序**：默认按 Front Matter 中的创建时间排序导入（旧→新），保持原始笔记顺序
- **进度与断点续传**：记录导入状态，Cookie 过期后可续传
- **图片上传**：支持 Joplin 格式的图片引用，配合 Playwright 上传真实图片

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 获取 Cookie

1. 登录 [i.mi.com/note](https://i.mi.com/note)（Chrome 推荐）
2. 按 F12 → Network → 创建一条测试笔记
3. 复制任意请求的 Request Headers 中的 `Cookie` 值
4. 确保包含 `serviceToken` 和 `userId`

### 3. 导入

```bash
# 导入整个 Joplin 导出目录（自动按文件夹分类 + Front Matter 时间排序）
npm run import -- -d ./joplin-export -c "serviceToken=xxx;userId=123;..."

# 禁用自动文件夹分类，所有笔记导入到同一文件夹
npm run import -- -d ./joplin-export --flat -c "..."

# 禁用 Front Matter 时间排序（按文件名导入）
npm run import -- -d ./joplin-export --no-sort -c "..."

# 查看帮助
npm run import:help
```

## 目录结构

```
joplin-to-minote/
├── cli/
│   ├── import-note.ts    # 主入口 CLI
│   └── README.md         # 详细 CLI 文档
├── automation/           # Playwright 图片上传（可选）
│   ├── auto-upload-real.js
│   ├── batch-upload.js
│   └── README.md
├── package.json
└── README.md
```

## 文档

- [CLI 使用说明](cli/README.md) - 完整命令行参数、Cookie 获取、故障排除
- [图片上传说明](automation/README.md) - Playwright 自动化上传图片流程

## 注意事项

- **Cookie 安全**：Cookie 包含登录凭证，不要分享或提交到版本控制
- **非官方 API**：本工具使用小米云网页版私有 API，可能随官方更新失效
- **Cookie 有效期**：通常几小时，大量导入建议使用 `--state-file` 和 `--resume`
- **Front Matter 格式**：支持标准 YAML Front Matter，优先使用 `created` 字段，其次 `updated` 字段
- **API 限流**：小米云有请求频率限制，如遇 503 错误请等待 15-30 分钟后使用 `--resume` 继续

## Front Matter 示例

```yaml
---
title: 笔记标题
created: 2023-01-01T10:00:00Z
updated: 2023-12-31T10:00:00Z
author: 作者名
tags:
  - 标签 1
  - 标签 2
---

笔记正文内容...
```

工具会自动：
1. 提取 `title` 作为笔记标题
2. 使用 `created` 时间排序导入（从老到新）
3. 保留所有 Front Matter 信息到笔记内容中

## License

MIT
