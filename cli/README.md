# 小米笔记导入 CLI 工具

独立的命令行工具，用于将 Markdown 文件批量导入到小米云笔记，无需启动 Obsidian。

## 安装依赖

```bash
npm install
```

## 使用方法

### 方式一：浏览器 Cookie（推荐，已验证可用）

**重要提示**：小米云桌面应用缓存的 Cookie 与网页版不同，且经过加密，无法直接用于 API 调用。建议从浏览器获取 Cookie。

#### 获取浏览器 Cookie 步骤：

1. **登录** [i.mi.com/note](https://i.mi.com/note)（建议使用 Chrome 浏览器）
2. 按 **F12** 打开开发者工具 → 切换到 **Network** 标签
3. **刷新页面** 或 **创建一条测试笔记**
4. 找到任意请求（如 `page?syncTag=...` 或 `note`）
5. 点击请求 → 查看 **Request Headers** → 找到 **Cookie** 字段
6. **右键** → **Copy value** 复制完整的 Cookie 字符串
7. 确保 Cookie 包含 `serviceToken=` 字段

#### 使用 Cookie 导入：

```bash
# 导入单个文件
npm run import -- -f ./my-note.md -c "serviceToken=xxx;userId=123;..."

# 导入整个文件夹
npm run import -- -d ./notes-folder -c "serviceToken=xxx;..."
```

**Cookie 示例格式：**
```
serviceToken=U7s/v0q0JE/UQMNZhVxzLUZi4YLT...; userId=1281412878; i.mi.com_isvalid_servicetoken=true; ...
```

### 方式二：自动读取应用 Cookie（实验性功能）

如果你希望尝试从已登录的小米云桌面应用读取 Cookie：

```bash
# 导入单个文件
npm run import -- -f ./my-note.md

# 导入整个文件夹
npm run import -- -d ./notes-folder
```

**限制说明**：
- 应用 Cookie 数据库通常被应用锁定，无法同时访问
- 应用使用与网页版不同的认证机制（passToken 而非明文的 serviceToken）
- 如遇到错误，请使用方式一（浏览器 Cookie）

### 导入到指定文件夹

```bash
npm run import -- -f ./note.md -c "xxx" --folderId 12345
```

## 命令行参数

| 参数 | 简写 | 说明 | 必需 |
|------|------|------|------|
| `--file` | `-f` | 单个 Markdown 文件路径 | 是（与 dir 二选一） |
| `--dir` | `-d` | 文件夹路径（递归导入所有 .md 文件） | 是（与 file 二选一） |
| `--cookie` | `-c` | 小米云服务 Cookie（从浏览器获取） | 推荐 |
| `--folderId` | | 目标文件夹 ID | 否（默认：0 未分类） |
| `--host` | | 小米云服务主机 | 否（默认：i.mi.com） |
| `--verbose` | `-v` | 显示详细日志 | 否 |
| `--help` | `-h` | 显示帮助信息 | 否 |

## 使用示例

### 基础用法

```bash
# 导入单个笔记（使用浏览器 Cookie）
npm run import -- -f ./todo.md -c "serviceToken=xxx;..."

# 导入文件夹（包含子文件夹）
npm run import -- -d ./my-notes -c "serviceToken=xxx;..."

# 显示详细日志
npm run import -- -d ./notes -c "xxx" -v
```

### 使用 npm 脚本

```bash
npm run import -- -f ./note.md -c "xxx"
```

## 注意事项

1. **Cookie 来源**：请从浏览器 Network 面板复制 Cookie，而非 Application 面板（后者可能不包含所有字段）
2. **Cookie 有效期**：Cookie 可能会过期（通常几小时到几天），如果导入失败请重新获取
3. **频率限制**：工具内置 500ms 延迟避免请求过快
4. **内容格式**：支持纯文本导入，Markdown 格式会保留
5. **图片处理**：支持导入带图片的笔记，但图片会显示为占位符（需要小米云官方客户端重新上传才能正常显示）
6. **重复导入**：每次导入都会创建新笔记，不会检测重复

## 故障排除

### "创建笔记失败: 未知错误"
- **原因**：Cookie 无效或不完整
- **解决**：
  1. 重新登录 i.mi.com
  2. 从浏览器 Network 面板重新复制 Cookie（确保包含 `serviceToken`）
  3. 确保复制的是完整的 Cookie 字符串，没有截断

### "读取 Cookie 失败"
- 如果使用 `-c` 参数：检查 Cookie 字符串是否正确粘贴
- 如果自动读取：这是预期行为，请使用浏览器 Cookie

### "必须指定文件或文件夹"
- 使用 `-f` 指定单个文件，或 `-d` 指定文件夹

## 技术说明

这个 CLI 工具直接调用小米云服务的私有 API：
- `POST /note/note` - 创建空笔记
- `POST /note/note/{id}` - 更新笔记内容

API 需要正确的 `serviceToken` 进行认证，该 Token 只能从浏览器登录态中获取。
