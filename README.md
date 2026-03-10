# Joplin to Minote

将 Joplin 导出的 Markdown 笔记批量导入到小米云笔记（Xiaomi Cloud Notes）。

## 功能

- **批量导入**：支持单个文件或整个目录递归导入
- **文件夹分类**：根据本地子目录自动创建小米云文件夹并分类
- **进度与断点续传**：记录导入状态，Cookie 过期后可续传
- **时间顺序**：按文件创建时间排序导入（旧→新）
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
# 导入整个 Joplin 导出目录（含文件夹分类）
npm run import -- -d ./joplin-export --organize-by-folder -c "serviceToken=xxx;userId=123;..."

# 按创建时间排序导入
npm run import -- -d ./joplin-export --organize-by-folder --preserve-order -c "..."

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

## License

MIT
