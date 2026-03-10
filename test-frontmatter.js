const fs = require('fs');
const path = require('path');

function parseFrontMatter(content) {
	const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
	if (!match) {
		return { frontMatter: {}, content };
	}
	
	const yamlStr = match[1];
	const frontMatter = {};
	const lines = yamlStr.split('\n');
	
	// 先解析所有单行字段
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const colonIndex = line.indexOf(':');
		if (colonIndex === -1) continue;
		
		const key = line.slice(0, colonIndex).trim();
		const value = line.slice(colonIndex + 1).trim();
		
		if (!key) continue;
		
		if (key === 'tags') {
			if (value === '') {
				// 多行数组格式
				const tags = [];
				for (let j = i + 1; j < lines.length; j++) {
					const tagLine = lines[j];
					if (tagLine.match(/^\s{2}-\s/)) {
						tags.push(tagLine.replace(/^\s{2}-\s/, '').trim());
					} else if (tagLine.match(/^\S/)) {
						// 遇到新的顶级字段，结束
						break;
					}
				}
				if (tags.length > 0) {
					frontMatter.tags = tags;
				}
			} else {
				frontMatter.tags = value.split(',').map(t => t.trim());
			}
		} else if (['latitude', 'longitude', 'altitude'].includes(key)) {
			const numValue = parseFloat(value);
			if (!isNaN(numValue)) {
				frontMatter[key] = numValue;
			}
		} else {
			frontMatter[key] = value;
		}
	}
	
	const contentWithoutFm = content.slice(match[0].length);
	return { frontMatter, content: contentWithoutFm };
}

function formatMetadata(fm) {
	const lines = [];
	
	if (fm.author) lines.push(`作者：${fm.author}`);
	if (fm.tags && fm.tags.length > 0) lines.push(`标签：${fm.tags.join(', ')}`);
	if (fm.updated) lines.push(`更新时间：${fm.updated}`);
	if (fm.created) lines.push(`创建时间：${fm.created}`);
	if (fm.latitude !== undefined && fm.longitude !== undefined) {
		lines.push(`位置：${fm.latitude}, ${fm.longitude}`);
	}
	
	if (lines.length > 0) {
		return lines.join('\n') + '\n\n---\n\n';
	}
	
	return '';
}

function getMarkdownFilesWithMetadata(dirPath) {
	const files = [];
	
	function traverse(currentPath) {
		const entries = fs.readdirSync(currentPath, { withFileTypes: true });
		
		for (const entry of entries) {
			const fullPath = path.join(currentPath, entry.name);
			if (entry.isDirectory()) {
				traverse(fullPath);
			} else if (entry.isFile() && entry.name.endsWith('.md')) {
				const content = fs.readFileSync(fullPath, 'utf-8');
				const { frontMatter } = parseFrontMatter(content);
				const stats = fs.statSync(fullPath);
				
				let updatedTime;
				if (frontMatter.updated) {
					updatedTime = new Date(frontMatter.updated);
				} else {
					updatedTime = stats.mtime;
				}
				
				const createTime = frontMatter.created 
					? new Date(frontMatter.created) 
					: stats.birthtime || stats.ctime;
				
				files.push({
					filePath: fullPath,
					frontMatter,
					updatedTime,
					createTime
				});
			}
		}
	}
	
	traverse(dirPath);
	return files;
}

// 主函数
const testDir = 'C:\\Users\\天一\\Documents\\joplintest';
console.log('测试 Front Matter 解析和排序功能\n');
console.log('='.repeat(60));

const files = getMarkdownFilesWithMetadata(testDir);

console.log(`\n找到 ${files.length} 个 Markdown 文件\n`);

// 按 updated 时间排序
files.sort((a, b) => a.updatedTime.getTime() - b.updatedTime.getTime());

console.log('按 updated 时间排序（旧→新）:\n');
files.forEach((f, i) => {
	console.log(`${i + 1}. ${path.basename(f.filePath)}`);
	console.log(`   标题：${f.frontMatter.title || '无'}`);
	console.log(`   更新时间：${f.updatedTime.toLocaleString('zh-CN')}`);
	console.log(`   作者：${f.frontMatter.author || '无'}`);
	console.log(`   标签：${f.frontMatter.tags?.join(', ') || '无'}`);
	console.log();
});

console.log('='.repeat(60));
console.log('\nFront Matter 格式化示例:\n');

const firstFile = files[0];
const metadata = formatMetadata(firstFile.frontMatter);
console.log(`文件：${path.basename(firstFile.filePath)}`);
console.log('格式化后的元数据:');
console.log(metadata);
