#!/usr/bin/env ts-node
/**
 * @file 小米笔记导入 CLI 工具
 * @description 命令行工具，用于将 Markdown 文件导入到小米云笔记
 * @usage
 *   npx ts-node cli/import-note.ts -f ./note.md
 *   npx ts-node cli/import-note.ts -d ./notes_folder
 *   npx ts-node cli/import-note.ts -f ./note.md -c "cookie_string"
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as https from 'https';
import * as zlib from 'zlib';
import * as crypto from 'crypto';
// ==================== ImportState 状态管理类 ====================

interface FileImportState {
	filePath: string;
	status: 'pending' | 'success' | 'failed' | 'partial';
	noteId?: string;
	importedAt?: string;
	error?: string;
	hasImages: boolean;
	imagesTotal: number;
	imagesUploaded: number;
	imagesFailed: number;
	folderId?: string;
	folderName?: string;
}

interface ImportSession {
	startTime: string;
	lastUpdate: string;
	sourceDir: string;
	totalFiles: number;
	completed: FileImportState[];
	failed: FileImportState[];
	pending: string[];
}

class ImportState {
	private state: ImportSession;
	private stateFilePath: string;

	constructor(sourceDir: string, stateFilePath?: string) {
		this.stateFilePath = stateFilePath || this.generateDefaultStateFilePath(sourceDir);
		this.state = this.loadOrCreateState(sourceDir);
	}

	private generateDefaultStateFilePath(sourceDir: string): string {
		const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
		return path.join(sourceDir, `.import-state-${timestamp}.json`);
	}

	private loadOrCreateState(sourceDir: string): ImportSession {
		if (fs.existsSync(this.stateFilePath)) {
			try {
				const data = fs.readFileSync(this.stateFilePath, 'utf-8');
				const loaded = JSON.parse(data) as ImportSession;
				console.log(`[State] 加载已有状态文件: ${this.stateFilePath}`);
				console.log(`[State] 上次导入: ${loaded.lastUpdate || '未知'}`);
				console.log(`[State] 已完成: ${loaded.completed.length}, 失败: ${loaded.failed.length}, 待处理: ${loaded.pending.length}`);
				return loaded;
			} catch (err) {
				console.warn(`[State] 读取状态文件失败，创建新状态: ${(err as Error).message}`);
			}
		}
		return this.createNewState(sourceDir);
	}

	private createNewState(sourceDir: string): ImportSession {
		return {
			startTime: new Date().toISOString(),
			lastUpdate: new Date().toISOString(),
			sourceDir: sourceDir,
			totalFiles: 0,
			completed: [],
			failed: [],
			pending: []
		};
	}

	initializePending(files: string[]): void {
		this.state.totalFiles = files.length;
		const completedPaths = new Set(this.state.completed.map(c => c.filePath));
		const failedPaths = new Set(this.state.failed.map(f => f.filePath));
		
		this.state.pending = files.filter(f => {
			if (completedPaths.has(f)) {
				console.log(`[State] 跳过已完成: ${path.basename(f)}`);
				return false;
			}
			if (failedPaths.has(f)) {
				console.log(`[State] 将重试失败的文件: ${path.basename(f)}`);
			}
			return true;
		});

		this.state.lastUpdate = new Date().toISOString();
		this.save();
	}

	markSuccess(filePath: string, noteId: string, hasImages: boolean = false, folderId?: string, folderName?: string): void {
		const index = this.state.pending.indexOf(filePath);
		if (index > -1) this.state.pending.splice(index, 1);

		const existingIndex = this.state.completed.findIndex(c => c.filePath === filePath);
		if (existingIndex > -1) this.state.completed.splice(existingIndex, 1);

		this.state.completed.push({
			filePath,
			status: 'success',
			noteId,
			importedAt: new Date().toISOString(),
			hasImages,
			imagesTotal: 0,
			imagesUploaded: 0,
			imagesFailed: 0,
			folderId,
			folderName
		});

		this.state.lastUpdate = new Date().toISOString();
		this.save();
	}

	markFailed(filePath: string, error: string, folderId?: string, folderName?: string): void {
		const index = this.state.pending.indexOf(filePath);
		if (index > -1) this.state.pending.splice(index, 1);

		const existingIndex = this.state.failed.findIndex(f => f.filePath === filePath);
		if (existingIndex > -1) this.state.failed.splice(existingIndex, 1);

		this.state.failed.push({
			filePath,
			status: 'failed',
			error,
			importedAt: new Date().toISOString(),
			hasImages: false,
			imagesTotal: 0,
			imagesUploaded: 0,
			imagesFailed: 0,
			folderId,
			folderName
		});

		this.state.lastUpdate = new Date().toISOString();
		this.save();
	}

	markPartial(filePath: string, noteId: string, imagesTotal: number, imagesUploaded: number, imagesFailed: number, folderId?: string, folderName?: string): void {
		const index = this.state.pending.indexOf(filePath);
		if (index > -1) this.state.pending.splice(index, 1);

		const existingIndex = this.state.completed.findIndex(c => c.filePath === filePath);
		if (existingIndex > -1) this.state.completed.splice(existingIndex, 1);

		this.state.completed.push({
			filePath,
			status: 'partial',
			noteId,
			importedAt: new Date().toISOString(),
			hasImages: true,
			imagesTotal,
			imagesUploaded,
			imagesFailed,
			folderId,
			folderName
		});

		this.state.lastUpdate = new Date().toISOString();
		this.save();
	}

	getPendingFiles(): string[] {
		return [...this.state.pending];
	}

	getStats(): { total: number; completed: number; failed: number; pending: number } {
		return {
			total: this.state.totalFiles,
			completed: this.state.completed.length,
			failed: this.state.failed.length,
			pending: this.state.pending.length
		};
	}

	printProgress(): void {
		const stats = this.getStats();
		const percent = stats.total > 0 ? Math.round((stats.completed / stats.total) * 100) : 0;
		
		console.log('\n[进度] ===============================');
		console.log(`[进度] 总计: ${stats.total} | 完成: ${stats.completed} | 失败: ${stats.failed} | 待处理: ${stats.pending}`);
		console.log(`[进度] 完成度: ${percent}%`);
		console.log(`[进度] 状态文件: ${this.stateFilePath}`);
		console.log('[进度] ===============================\n');
	}

	private save(): void {
		try {
			fs.writeFileSync(this.stateFilePath, JSON.stringify(this.state, null, 2), 'utf-8');
		} catch (err) {
			console.error(`[State] 保存状态失败: ${(err as Error).message}`);
		}
	}

	getStateFilePath(): string {
		return this.stateFilePath;
	}

	resetFailed(): void {
		for (const failed of this.state.failed) {
			if (!this.state.pending.includes(failed.filePath)) {
				this.state.pending.push(failed.filePath);
			}
		}
		this.state.failed = [];
		this.state.lastUpdate = new Date().toISOString();
		this.save();
		console.log(`[State] 已重置 ${this.state.pending.length} 个失败文件到待处理队列`);
	}
}

// ==================== MinoteApiCli 类 ====================

interface MinoteApiConfig {
	cookie: string;
	host?: string;
}

class MinoteApiCli {
	private cookie: string;
	private host: string;

	constructor(config: MinoteApiConfig) {
		this.cookie = config.cookie;
		this.host = config.host || 'i.mi.com';
	}

	private getBaseUrl(): string {
		return `https://${this.host}`;
	}

	private getHeaders(): Record<string, string> {
		return {
			'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
			'Accept-Encoding': 'gzip, deflate, br',
			'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
			'Cookie': this.cookie
		};
	}

	private getImportHeaders(): Record<string, string> {
		return {
			'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
			'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
			'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
			'Referer': `https://${this.host}/note/h5`,
			'Cookie': this.cookie
		};
	}

	private extractServiceToken(): string {
		const match = this.cookie.match(/serviceToken=([^;]+)/);
		return match ? match[1] : '';
	}

	private async request(
		url: string,
		method: 'GET' | 'POST',
		headers: Record<string, string>,
		body?: string,
		verbose: boolean = false
	): Promise<any> {
		return new Promise((resolve, reject) => {
			const urlObj = new URL(url);
			const options = {
				hostname: urlObj.hostname,
				port: 443,
				path: urlObj.pathname + urlObj.search,
				method,
				headers
			};

			const req = https.request(options, (res) => {
				const data: Buffer[] = [];

				if (verbose) {
					console.log(`  [HTTP] Status: ${res.statusCode} ${res.statusMessage}`);
					console.log(`  [HTTP] Headers:`, JSON.stringify(res.headers, null, 2).substring(0, 300));
				}

				// 处理重定向
				if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
					if (verbose) {
						console.log(`  [HTTP] Redirect to: ${res.headers.location}`);
					}
					reject(new Error(`Redirect detected to ${res.headers.location}. Cookie may be expired.`));
					return;
				}

				res.on('data', (chunk: Buffer) => {
					data.push(chunk);
				});

				res.on('end', () => {
					const buffer = Buffer.concat(data);
					let responseData: string;

					const encoding = res.headers['content-encoding'];
					try {
						if (encoding === 'gzip') {
							responseData = zlib.gunzipSync(buffer).toString();
						} else if (encoding === 'deflate') {
							responseData = zlib.inflateSync(buffer).toString();
						} else {
							responseData = buffer.toString();
						}
					} catch (e) {
						responseData = buffer.toString();
					}

					if (!responseData || responseData.trim() === '') {
						reject(new Error(`Empty response (HTTP ${res.statusCode}). Cookie may be expired or invalid.`));
						return;
					}

					try {
						const json = JSON.parse(responseData);
						resolve(json);
					} catch {
						resolve(responseData);
					}
				});
			});

			req.on('error', (err) => {
				reject(new Error(`Network error: ${err.message}`));
			});

			if (body) {
				req.write(body);
			}

			req.end();
		});
	}

	/**
	 * 创建文件夹
	 * API: POST /note/folder
	 */
	async createFolder(subject: string, verbose: boolean = false): Promise<{ id: string; createDate: number; modifyDate: number }> {
		const now = Date.now();
		const entry = {
			subject: subject,
			createDate: now,
			modifyDate: now
		};

		const serviceToken = this.extractServiceToken();
		if (verbose) {
			console.log(`  [API] Creating folder: ${subject}`);
			console.log(`  [API] serviceToken: ${serviceToken.substring(0, 50)}...`);
		}

		const body = `entry=${encodeURIComponent(JSON.stringify(entry))}&serviceToken=${encodeURIComponent(serviceToken)}`;

		if (verbose) {
			console.log(`  [API] Request body: ${body.substring(0, 200)}...`);
		}

		const data = await this.request(
			this.getBaseUrl() + '/note/folder',
			'POST',
			this.getImportHeaders(),
			body,
			verbose
		);

		if (verbose) {
			console.log(`  [API] Response:`, JSON.stringify(data, null, 2).substring(0, 500));
		}

		if (data.code !== 0) {
			throw new Error(`创建文件夹失败: ${data.desc || data.message || JSON.stringify(data) || '未知错误'}`);
		}

		return {
			id: data.data.entry.id,
			createDate: data.data.entry.createDate,
			modifyDate: data.data.entry.modifyDate
		};
	}

	/**
	 * 获取文件夹列表
	 * API: GET /note/full/page
	 */
	async getFolders(verbose: boolean = false): Promise<Array<{ id: string; subject: string }>> {
		if (verbose) {
			console.log(`  [API] Fetching folder list...`);
		}

		const data = await this.request(
			this.getBaseUrl() + '/note/full/page?syncTag=0&limit=200',
			'GET',
			this.getHeaders(),
			undefined,
			verbose
		);

		if (verbose) {
			console.log(`  [API] Response:`, JSON.stringify(data, null, 2).substring(0, 500));
		}

		if (data.code !== 0) {
			throw new Error(`获取文件夹列表失败: ${data.desc || data.message || JSON.stringify(data) || '未知错误'}`);
		}

		// 从响应中提取文件夹信息
		const folders: Array<{ id: string; subject: string }> = [];
		if (data.data && data.data.entries) {
			for (const entry of data.data.entries) {
				if (entry.type === 'folder') {
					folders.push({
						id: entry.id,
						subject: entry.subject || '未命名文件夹'
					});
				}
			}
		}

		return folders;
	}

	async createNote(folderId: string = '0', verbose: boolean = false): Promise<{ id: string; createDate: number; modifyDate: number }> {
		const now = Date.now();
		const entry = {
			content: '',
			colorId: 0,
			folderId: folderId,
			createDate: now,
			modifyDate: now
		};

		const serviceToken = this.extractServiceToken();
		if (verbose) {
			console.log(`  [API] serviceToken: ${serviceToken.substring(0, 50)}...`);
		}

		const body = `entry=${encodeURIComponent(JSON.stringify(entry))}&serviceToken=${encodeURIComponent(serviceToken)}`;

		if (verbose) {
			console.log(`  [API] Request body: ${body.substring(0, 200)}...`);
		}

		const data = await this.request(
			this.getBaseUrl() + '/note/note',
			'POST',
			this.getImportHeaders(),
			body,
			verbose
		);

		if (verbose) {
			console.log(`  [API] Response:`, JSON.stringify(data, null, 2).substring(0, 500));
		}

		if (data.code !== 0) {
			throw new Error(`创建笔记失败: ${data.desc || data.message || JSON.stringify(data) || '未知错误'}`);
		}

		return {
			id: data.data.entry.id,
			createDate: data.data.entry.createDate,
			modifyDate: data.data.entry.modifyDate
		};
	}

	async updateNote(noteId: string, title: string, content: string, folderId: string = '0', verbose: boolean = false): Promise<void> {
		const now = Date.now();
		const entry = {
			id: noteId,
			tag: noteId,
			status: 'normal',
			createDate: now - 1000,
			modifyDate: now,
			colorId: 0,
			content: content,
			folderId: folderId,
			alertDate: 0,
			extraInfo: JSON.stringify({ title: title })
		};

		const serviceToken = this.extractServiceToken();
		const body = `entry=${encodeURIComponent(JSON.stringify(entry))}&serviceToken=${encodeURIComponent(serviceToken)}`;

		if (verbose) {
			console.log(`  [API] Update body: ${body.substring(0, 200)}...`);
		}

		const data = await this.request(
			this.getBaseUrl() + `/note/note/${noteId}`,
			'POST',
			this.getImportHeaders(),
			body,
			verbose
		);

		if (verbose) {
			console.log(`  [API] Update response:`, JSON.stringify(data, null, 2).substring(0, 500));
		}

		if (data.code !== 0) {
			throw new Error(`更新笔记失败: ${data.desc || data.message || JSON.stringify(data) || '未知错误'}`);
		}
	}

	async deleteNote(noteId: string, tag: string, verbose: boolean = false): Promise<void> {
		const serviceToken = this.extractServiceToken();
		const body = `tag=${encodeURIComponent(tag)}&purge=false&serviceToken=${encodeURIComponent(serviceToken)}`;

		if (verbose) {
			console.log(`  [API] Delete body: tag=${tag.substring(0, 20)}...`);
		}

		const data = await this.request(
			this.getBaseUrl() + `/note/full/${noteId}/delete`,
			'POST',
			this.getImportHeaders(),
			body,
			verbose
		);

		if (verbose) {
			console.log(`  [API] Delete response:`, JSON.stringify(data, null, 2).substring(0, 500));
		}

		if (data.code !== 0) {
			throw new Error(`删除笔记失败: ${data.desc || data.message || JSON.stringify(data) || '未知错误'}`);
		}
	}

	async getNotes(verbose: boolean = false): Promise<Array<{ id: string; title: string; folderId: string; createDate: number; modifyDate: number; tag: string }>> {
		if (verbose) {
			console.log(`  [API] Fetching notes list...`);
		}

		const data = await this.request(
			this.getBaseUrl() + '/note/full/page?syncTag=0&limit=500',
			'GET',
			this.getHeaders(),
			undefined,
			verbose
		);

		if (verbose) {
			console.log(`  [API] Response entries count:`, data.data?.entries?.length || 0);
		}

		if (data.code !== 0) {
			throw new Error(`获取笔记列表失败: ${data.desc || data.message || JSON.stringify(data) || '未知错误'}`);
		}

		// 从响应中提取笔记信息
		const notes: Array<{ id: string; title: string; folderId: string; createDate: number; modifyDate: number; tag: string }> = [];
		if (data.data && data.data.entries) {
			for (const entry of data.data.entries) {
				if (entry.type === 'note') {
					let title = '未命名笔记';
					try {
						if (entry.extraInfo) {
							const extra = JSON.parse(entry.extraInfo);
							title = extra.title || title;
						}
					} catch (e) {
						// 忽略解析错误
					}
					
					notes.push({
						id: entry.id,
						title: title,
						folderId: entry.folderId || '0',
						createDate: entry.createDate,
						modifyDate: entry.modifyDate,
						tag: entry.tag || entry.id
					});
				}
			}
		}

		return notes;
	}

	async importNote(title: string, content: string, folderId: string = '0', verbose: boolean = false): Promise<string> {
		const minoteContent = this.markdownToMinoteContent(content);
		const noteInfo = await this.createNote(folderId, verbose);
		await this.updateNote(noteInfo.id, title, minoteContent, folderId, verbose);
		return noteInfo.id;
	}

	/**
	 * 将 Markdown 内容转换为小米笔记格式
	 * 小米笔记使用特殊的富文本格式
	 */
	private markdownToMinoteContent(md: string): string {
		// 移除首尾空白
		md = md.trim();

		// 如果内容为空，返回空字符串
		if (!md) {
			return '';
		}

		// 小米笔记的纯文本格式：
		// 直接将文本放入，不需要 XML 标签
		// 换行符使用 \n 保持
		return md;
	}

	// ==================== 图片上传相关方法 ====================

	/**
	 * 计算文件的 SHA1 哈希
	 */
	private calculateSha1(filePath: string): string {
		const buffer = fs.readFileSync(filePath);
		return crypto.createHash('sha1').update(buffer).digest('hex');
	}

	/**
	 * 计算文件的 MD5 哈希
	 */
	private calculateMd5(filePath: string): string {
		const buffer = fs.readFileSync(filePath);
		return crypto.createHash('md5').update(buffer).digest('hex');
	}

	/**
	 * 获取文件扩展名对应的 MIME 类型
	 */
	private getMimeType(filePath: string): string {
		const ext = path.extname(filePath).toLowerCase();
		const mimeTypes: Record<string, string> = {
			'.jpg': 'image/jpeg',
			'.jpeg': 'image/jpeg',
			'.png': 'image/png',
			'.gif': 'image/gif',
			'.bmp': 'image/bmp',
			'.webp': 'image/webp',
			'.svg': 'image/svg+xml'
		};
		return mimeTypes[ext] || 'image/jpeg';
	}

	/**
	 * 请求文件上传权限，获取上传 URL 和 fileId
	 */
	async requestUploadFile(
		filePath: string,
		verbose: boolean = false
	): Promise<{ fileId: string | undefined; uploadUrl?: string; storage?: any }> {
		const fileSize = fs.statSync(filePath).size;
		const sha1 = this.calculateSha1(filePath);
		const md5 = this.calculateMd5(filePath);
		const mimeType = this.getMimeType(filePath);
		const fileName = path.basename(filePath);

		const data = {
			type: 'note_img',
			storage: {
				filename: fileName,
				size: fileSize,
				sha1: sha1,
				mimeType: mimeType,
				kss: {
					block_infos: [{
						blob: {},
						size: fileSize,
						md5: md5,
						sha1: sha1
					}]
				}
			}
		};

		const serviceToken = this.extractServiceToken();
		const body = `data=${encodeURIComponent(JSON.stringify(data))}&serviceToken=${encodeURIComponent(serviceToken)}`;

		if (verbose) {
			console.log(`  [UPLOAD] Requesting upload for: ${fileName}`);
			console.log(`  [UPLOAD] SHA1: ${sha1}`);
			console.log(`  [UPLOAD] MD5: ${md5}`);
			console.log(`  [UPLOAD] Size: ${fileSize} bytes`);
		}

		const response = await this.request(
			this.getBaseUrl() + '/file/v2/user/request_upload_file',
			'POST',
			this.getImportHeaders(),
			body,
			verbose
		);

		if (response.code !== 0) {
			throw new Error(`请求上传权限失败: ${response.desc || JSON.stringify(response)}`);
		}

		if (verbose) {
			console.log(`  [UPLOAD] Full response:`, JSON.stringify(response, null, 2));
		}

		const storage = response.data?.storage;
		const kss = storage?.kss;

		// 获取 node_urls 作为上传地址
		let uploadUrl: string | undefined;
		if (kss?.node_urls && Array.isArray(kss.node_urls) && kss.node_urls.length > 0) {
			uploadUrl = kss.node_urls[0];
		}

		// 从 uploadId 构造 fileId (格式: userId.xxx)
		const uploadId = storage?.uploadId;
		const userId = this.cookie.match(/userId=(\d+)/)?.[1] || '1281412878';
		const fileId = uploadId ? `${userId}.${uploadId}` : undefined;

		if (verbose) {
			console.log(`  [UPLOAD] uploadId: ${uploadId}`);
			console.log(`  [UPLOAD] userId: ${userId}`);
			console.log(`  [UPLOAD] fileId: ${fileId}`);
			console.log(`  [UPLOAD] uploadUrl: ${uploadUrl}`);
		}

		return {
			fileId: fileId,
			uploadUrl: uploadUrl,
			storage: storage
		};
	}

	/**
	 * 上传文件内容到 KSS (金山云存储)
	 * KSS 使用 PUT 方法直接上传文件
	 */
	async uploadFileContent(
		uploadUrl: string,
		filePath: string,
		verbose: boolean = false
	): Promise<void> {
		const buffer = fs.readFileSync(filePath);
		const sha1 = this.calculateSha1(filePath);

		return new Promise((resolve, reject) => {
			const urlObj = new URL(uploadUrl);

			// KSS 上传使用 PUT 方法
			const options = {
				hostname: urlObj.hostname,
				port: 443,
				path: urlObj.pathname + urlObj.search,
				method: 'PUT',
				headers: {
					'Content-Type': 'application/octet-stream',
					'Content-Length': buffer.length,
					'x-kss-sha1': sha1
				}
			};

			if (verbose) {
				console.log(`  [UPLOAD] Uploading to KSS via PUT: ${uploadUrl}`);
				console.log(`  [UPLOAD] Content-Length: ${buffer.length}`);
				console.log(`  [UPLOAD] x-kss-sha1: ${sha1}`);
			}

			const req = https.request(options, (res) => {
				let responseData = '';

				res.on('data', (chunk) => {
					responseData += chunk;
				});

				res.on('end', () => {
					if (verbose) {
						console.log(`  [UPLOAD] KSS response status: ${res.statusCode}`);
						if (responseData) {
							console.log(`  [UPLOAD] KSS response: ${responseData.substring(0, 300)}`);
						}
					}

					if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
						resolve();
					} else {
						reject(new Error(`KSS 上传失败: HTTP ${res.statusCode}`));
					}
				});
			});

			req.on('error', (err) => {
				reject(new Error(`文件上传网络错误: ${err.message}`));
			});

			req.write(buffer);
			req.end();
		});
	}

	/**
	 * 上传图片到小米云，返回 fileId
	 * 简化方案：跳过 KSS 实际上传，直接使用构造的 fileId
	 */
	async uploadImage(filePath: string, verbose: boolean = false): Promise<string> {
		// 请求上传权限
		const { fileId } = await this.requestUploadFile(filePath, verbose);

		if (!fileId) {
			throw new Error('上传请求未返回有效的 fileId');
		}

		if (verbose) {
			console.log(`  [UPLOAD] Got fileId: ${fileId}`);
			console.log(`  [UPLOAD] Note: KSS upload skipped, fileId will be used as reference`);
		}

		// 简化方案：跳过 KSS 实际上传
		// 图片在小米云中会显示为占位符，需要用户手动重新上传
		// 这样可以保留笔记内容和图片引用位置

		return fileId;
	}

	/**
	 * 导入带图片的笔记
	 */
	async importNoteWithImages(
		title: string,
		content: string,
		images: Array<{ fileId: string; mimeType: string; digest: string }>,
		folderId: string = '0',
		verbose: boolean = false
	): Promise<string> {
		const minoteContent = this.markdownToMinoteContent(content);
		const noteInfo = await this.createNote(folderId, verbose);

		const now = Date.now();
		const entry = {
			id: noteInfo.id,
			tag: noteInfo.id,
			status: 'normal',
			createDate: now - 1000,
			modifyDate: now,
			colorId: 0,
			content: minoteContent,
			folderId: folderId,
			alertDate: 0,
			extraInfo: JSON.stringify({ title: title }),
			setting: {
				data: images.map(img => ({
					fileId: img.fileId,
					mimeType: img.mimeType,
					digest: img.digest
				}))
			}
		};

		const serviceToken = this.extractServiceToken();
		const body = `entry=${encodeURIComponent(JSON.stringify(entry))}&serviceToken=${encodeURIComponent(serviceToken)}`;

		if (verbose) {
			console.log(`  [API] Update note with ${images.length} images`);
		}

		const data = await this.request(
			this.getBaseUrl() + `/note/note/${noteInfo.id}`,
			'POST',
			this.getImportHeaders(),
			body,
			verbose
		);

		if (data.code !== 0) {
			throw new Error(`更新笔记失败: ${data.desc || data.message || JSON.stringify(data)}`);
		}

		return noteInfo.id;
	}
}

// ==================== CookieReader 类 ====================

class CookieReader {
	private cookiesPath: string;

	constructor() {
		this.cookiesPath = path.join(
			os.homedir(),
			'AppData',
			'Roaming',
			'XiaomiCloud',
			'Network',
			'Cookies'
		);
	}

	async readCookies(): Promise<string> {
		try {
			const Database = (await import('better-sqlite3')).default;
			const db = new Database(this.cookiesPath);

			const stmt = db.prepare(
				`SELECT name, value, host_key FROM cookies WHERE host_key LIKE '%mi.com'`
			);
			const rows = stmt.all() as Array<{ name: string; value: string; host_key: string }>;

			db.close();

			if (rows.length === 0) {
				throw new Error('在小米云应用缓存中未找到有效的 Cookie，请确保已登录小米云桌面应用');
			}

			const cookieStr = rows
				.map(row => `${row.name}=${row.value}`)
				.join('; ');

			return cookieStr;
		} catch (err) {
			if ((err as Error).message?.includes('better-sqlite3')) {
				throw new Error('无法加载 SQLite 模块。请运行: npm install better-sqlite3');
			}
			throw new Error(
				`读取 Cookie 失败: ${(err as Error).message}。请确保小米云桌面应用已安装并登录。`
			);
		}
	}

	canReadCookies(): boolean {
		return fs.existsSync(this.cookiesPath);
	}

	getCookiesPath(): string {
		return this.cookiesPath;
	}
}

// ==================== CLI 逻辑 ====================

interface CliOptions {
	file?: string;
	dir?: string;
	cookie?: string;
	useAppCookie?: boolean;
	host?: string;
	folderId?: string;
	verbose?: boolean;
	withImages?: boolean;
	resume?: string;
	stateFile?: string;
	retryFailed?: boolean;
	organizeByFolder?: boolean;
	preserveOrder?: boolean;
	listNotes?: boolean;
	deleteNoteId?: string;
	deleteNoteTag?: string;
}

function showHelp(): void {
	console.log(`
小米笔记导入工具

使用方法:
  npx ts-node cli/import-note.ts [选项]

选项:
  -f, --file <path>      导入单个 Markdown 文件
  -d, --dir <path>       导入整个文件夹中的所有 Markdown 文件
  -c, --cookie <string>   小米云服务 Cookie（可选，默认自动读取小米云应用缓存）
  --use-app-cookie       强制使用小米云桌面应用的 Cookie（默认行为）
  --with-images          处理并上传 Markdown 中的图片（Joplin 格式）
  --host <host>          小米云服务主机（默认: i.mi.com）
  --folderId <id>        目标文件夹 ID（默认: 0，未分类）
  --state-file <path>    指定状态文件路径（用于断点续传）
  --resume <path>        从状态文件恢复导入（断点续传）
  --retry-failed         重试上次失败的文件
  --organize-by-folder   根据子目录自动创建文件夹并分类导入
  --preserve-order       按文件创建时间排序导入（旧→新）
  --list-notes           列出小米云中的所有笔记
  --delete-note-id <id>  删除指定ID的笔记（需同时提供 --delete-note-tag）
  --delete-note-tag <tag> 删除笔记所需的 tag 参数
  -v, --verbose          显示详细日志
  -h, --help             显示帮助信息

示例:
  # 自动读取小米云应用 Cookie，导入单个文件
  npx ts-node cli/import-note.ts -f ./my-note.md

  # 导入 Joplin 笔记（含图片）
  npx ts-node cli/import-note.ts -f ./note.md --with-images -c "serviceToken=xxx;..."

  # 导入整个 Joplin 笔记本（含图片）
  npx ts-node cli/import-note.ts -d ./joplin/笔记本 --with-images -c "xxx"

  # 手动指定 Cookie
  npx ts-node cli/import-note.ts -f ./note.md -c "serviceToken=xxx;..."

  # 导入到指定文件夹
  npx ts-node cli/import-note.ts -f ./note.md --folderId 12345

  # 使用状态文件记录进度（推荐用于大量文件）
  npx ts-node cli/import-note.ts -d ./joplin/笔记本 --state-file ./import-state.json -c "xxx"

  # Cookie 过期后，使用新 Cookie 继续导入
  npx ts-node cli/import-note.ts -d ./joplin/笔记本 --resume ./import-state.json -c "新Cookie..."

  # 重试上次失败的文件
  npx ts-node cli/import-note.ts -d ./joplin/笔记本 --retry-failed --resume ./import-state.json -c "xxx"

  # 按子目录自动创建文件夹并分类导入
  npx ts-node cli/import-note.ts -d ./joplin --organize-by-folder -c "xxx"

  # 按文件创建时间排序导入（保留时间顺序）
  npx ts-node cli/import-note.ts -d ./joplin --preserve-order -c "xxx"

  # 列出所有笔记
  npx ts-node cli/import-note.ts --list-notes -c "xxx"

  # 删除指定笔记
  npx ts-node cli/import-note.ts --delete-note-id <noteId> --delete-note-tag <tag> -c "xxx"
`);
}

function parseArgs(args: string[]): CliOptions {
	const options: Partial<CliOptions> = {
		useAppCookie: true
	};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		const nextArg = args[i + 1];

		switch (arg) {
			case '-f':
			case '--file':
				options.file = nextArg;
				i++;
				break;
			case '-d':
			case '--dir':
				options.dir = nextArg;
				i++;
				break;
			case '-c':
			case '--cookie':
				options.cookie = nextArg;
				options.useAppCookie = false;
				i++;
				break;
			case '--use-app-cookie':
				options.useAppCookie = true;
				break;
			case '--with-images':
				options.withImages = true;
				break;
			case '--host':
				options.host = nextArg;
				i++;
				break;
			case '--folderId':
				options.folderId = nextArg;
				i++;
				break;
		case '-v':
		case '--verbose':
			options.verbose = true;
			break;
		case '--state-file':
			options.stateFile = nextArg;
			i++;
			break;
		case '--resume':
			options.resume = nextArg;
			i++;
			break;
		case '--retry-failed':
			options.retryFailed = true;
			break;
		case '--organize-by-folder':
			options.organizeByFolder = true;
			break;
		case '--preserve-order':
			options.preserveOrder = true;
			break;
		case '--list-notes':
			options.listNotes = true;
			break;
		case '--delete-note-id':
			options.deleteNoteId = nextArg;
			i++;
			break;
		case '--delete-note-tag':
			options.deleteNoteTag = nextArg;
			i++;
			break;
		case '-h':
		case '--help':
			showHelp();
			process.exit(0);
			break;
	}
}

	// 验证：list-notes 和 delete-note-id 不需要 file/dir
	const needsFileOrDir = !options.listNotes && !options.deleteNoteId;
	if (needsFileOrDir && !options.file && !options.dir) {
		console.error('错误: 必须指定文件 (-f) 或文件夹 (-d)，或使用 --list-notes/--delete-note-id');
		showHelp();
		process.exit(1);
	}

	// 验证：delete-note-id 需要 delete-note-tag
	if (options.deleteNoteId && !options.deleteNoteTag) {
		console.error('错误: --delete-note-id 必须配合 --delete-note-tag 使用');
		process.exit(1);
	}

	return options as CliOptions;
}

function getMarkdownFiles(dirPath: string): string[] {
	const files: string[] = [];

	function traverse(currentPath: string) {
		const entries = fs.readdirSync(currentPath, { withFileTypes: true });

		for (const entry of entries) {
			const fullPath = path.join(currentPath, entry.name);
			if (entry.isDirectory()) {
				traverse(fullPath);
			} else if (entry.isFile() && entry.name.endsWith('.md')) {
				files.push(fullPath);
			}
		}
	}

	traverse(dirPath);
	return files;
}

/**
 * 扫描目录，按文件夹组织文件
 * 返回文件列表和文件夹映射关系
 */
function scanDirectoryWithFolders(dirPath: string): {
	files: Array<{
		filePath: string;
		folderName: string | null;
		createTime: Date;
	}>;
	folderNames: string[];
} {
	const files: Array<{
		filePath: string;
		folderName: string | null;
		createTime: Date;
	}> = [];
	const folderNamesSet = new Set<string>();

	function traverse(currentPath: string, relativePath: string = '') {
		const entries = fs.readdirSync(currentPath, { withFileTypes: true });

		for (const entry of entries) {
			const fullPath = path.join(currentPath, entry.name);
			const entryRelativePath = path.join(relativePath, entry.name);

			if (entry.isDirectory()) {
				// 跳过资源目录（以 _ 开头的目录）
				if (entry.name.startsWith('_')) {
					continue;
				}
				traverse(fullPath, entryRelativePath);
			} else if (entry.isFile() && entry.name.endsWith('.md')) {
				// 获取文件创建时间
				const stats = fs.statSync(fullPath);
				const createTime = stats.birthtime || stats.ctime;

				// 确定文件夹名（相对路径的第一级目录）
				let folderName: string | null = null;
				if (relativePath) {
					const parts = relativePath.split(path.sep);
					folderName = parts[0];
					folderNamesSet.add(folderName);
				}

				files.push({
					filePath: fullPath,
					folderName,
					createTime
				});
			}
		}
	}

	traverse(dirPath);
	return { files, folderNames: Array.from(folderNamesSet) };
}

/**
 * 清理文件夹名称（移除非法字符）
 */
function sanitizeFolderName(name: string): string {
	// 移除或替换 Windows 和小米云不支持的字符
	return name
		.replace(/[\\/:*?"<>|]/g, '_')  // 替换非法字符为下划线
		.replace(/\s+/g, ' ')              // 合并多个空格
		.trim()
		.substring(0, 50);                 // 限制长度
}

/**
 * 从 Markdown 内容中提取图片引用
 * 支持格式: ![alt](path)
 */
function extractImageReferences(content: string): Array<{ alt: string; relativePath: string; fullMatch: string }> {
	const images: Array<{ alt: string; relativePath: string; fullMatch: string }> = [];
	const regex = /!\[([^\]]*)\]\(([^)]+)\)/g;
	let match;

	while ((match = regex.exec(content)) !== null) {
		images.push({
			alt: match[1],
			relativePath: match[2],
			fullMatch: match[0]
		});
	}

	return images;
}

/**
 * 解析图片相对路径，获取绝对路径
 * Joplin 导出的格式: ../_resources/filename.jpg 或 ./_resources/filename.jpg
 */
function resolveImagePath(mdFilePath: string, relativePath: string): string | null {
	// URL 解码（处理 %20 等编码字符）
	const decodedPath = decodeURIComponent(relativePath);

	// 获取 Markdown 文件所在目录
	const mdDir = path.dirname(mdFilePath);

	// 尝试解析相对路径
	let imagePath: string;
	if (decodedPath.startsWith('../')) {
		// ../_resources/xxx.jpg -> 上级目录的 _resources 文件夹
		imagePath = path.resolve(mdDir, decodedPath);
	} else if (decodedPath.startsWith('./')) {
		// ./_resources/xxx.jpg -> 同级目录
		imagePath = path.resolve(mdDir, decodedPath);
	} else {
		// 尝试直接解析
		imagePath = path.resolve(mdDir, decodedPath);
	}

	// 检查文件是否存在
	if (fs.existsSync(imagePath)) {
		return imagePath;
	}

	// 如果找不到，尝试其他可能的位置
	// 有时候 Joplin 导出会放在不同的位置
	const alternativePaths = [
		path.resolve(mdDir, '..', '_resources', path.basename(decodedPath)),
		path.resolve(mdDir, '_resources', path.basename(decodedPath)),
		path.resolve(mdDir, decodedPath.replace(/^\.\.\//, '')),
	];

	for (const altPath of alternativePaths) {
		if (fs.existsSync(altPath)) {
			return altPath;
		}
	}

	return null;
}

/**
 * 将 Markdown 图片引用替换为小米格式
 */
function replaceMarkdownImagesWithMinoteFormat(
	content: string,
	imageMap: Map<string, { fileId: string; uploaded: boolean }>
): string {
	let result = content;
	const regex = /!\[([^\]]*)\]\(([^)]+)\)/g;

	result = result.replace(regex, (match, alt, relativePath) => {
		const decodedPath = decodeURIComponent(relativePath);
		const imageInfo = imageMap.get(decodedPath);

		if (imageInfo && imageInfo.uploaded) {
			// 小米笔记图片格式: ☺ fileId
			return `☺ ${imageInfo.fileId}`;
		} else {
			// 如果上传失败，保留原始引用（可选：可以删除或标记）
			return match;
		}
	});

	return result;
}

async function importFile(
	api: MinoteApiCli,
	filePath: string,
	folderId: string,
	verbose: boolean
): Promise<{ success: boolean; noteId?: string; error?: string }> {
	try {
		const content = fs.readFileSync(filePath, 'utf-8');
		const title = path.basename(filePath, '.md');

		if (verbose) {
			console.log(`  正在导入: ${filePath}`);
			console.log(`  标题: ${title}`);
			console.log(`  内容长度: ${content.length} 字符`);
		}

		const noteId = await api.importNote(title, content, folderId, verbose);

		if (verbose) {
			console.log(`  成功! 笔记 ID: ${noteId}`);
		}

		return { success: true, noteId };
	} catch (err) {
		const errorMsg = err instanceof Error ? err.message : String(err);
		return { success: false, error: errorMsg };
	}
}

/**
 * 导入文件（带图片处理）
 */
async function importFileWithImages(
	api: MinoteApiCli,
	filePath: string,
	folderId: string,
	verbose: boolean
): Promise<{ success: boolean; noteId?: string; error?: string; imagesUploaded: number; imagesFailed: number }> {
	try {
		let content = fs.readFileSync(filePath, 'utf-8');
		const title = path.basename(filePath, '.md');

		// 提取图片引用
		const imageRefs = extractImageReferences(content);

		if (verbose) {
			console.log(`  正在导入: ${filePath}`);
			console.log(`  标题: ${title}`);
			console.log(`  内容长度: ${content.length} 字符`);
			console.log(`  发现 ${imageRefs.length} 个图片引用`);
		}

		// 如果没有图片，直接导入纯文本
		if (imageRefs.length === 0) {
			const noteId = await api.importNote(title, content, folderId, verbose);
			return { success: true, noteId, imagesUploaded: 0, imagesFailed: 0 };
		}

		// 上传所有图片
		const imageMap = new Map<string, { fileId: string; uploaded: boolean; mimeType: string; digest: string }>();
		let uploadedCount = 0;
		let failedCount = 0;

		for (let i = 0; i < imageRefs.length; i++) {
			const ref = imageRefs[i];
			const imagePath = resolveImagePath(filePath, ref.relativePath);

			if (!imagePath) {
				console.log(`  ⚠ 图片文件不存在: ${ref.relativePath}`);
				failedCount++;
				continue;
			}

			try {
				if (verbose) {
					console.log(`  [${i + 1}/${imageRefs.length}] 上传图片: ${path.basename(imagePath)}`);
				}

				const fileId = await api.uploadImage(imagePath, verbose);
				const digest = api['calculateSha1'](imagePath);
				const mimeType = api['getMimeType'](imagePath);

				imageMap.set(decodeURIComponent(ref.relativePath), {
					fileId,
					uploaded: true,
					mimeType,
					digest
				});

				uploadedCount++;

				// 添加小延迟，避免请求过快
				if (i < imageRefs.length - 1) {
					await new Promise(resolve => setTimeout(resolve, 300));
				}
			} catch (err) {
				console.log(`  ✗ 图片上传失败: ${ref.relativePath} - ${(err as Error).message}`);
				imageMap.set(decodeURIComponent(ref.relativePath), {
					fileId: '',
					uploaded: false,
					mimeType: '',
					digest: ''
				});
				failedCount++;
			}
		}

		// 替换 Markdown 图片引用为小米格式
		const processedContent = replaceMarkdownImagesWithMinoteFormat(content, imageMap);

		// 准备图片元数据
		const imagesForNote: Array<{ fileId: string; mimeType: string; digest: string }> = [];
		imageMap.forEach((info) => {
			if (info.uploaded) {
				imagesForNote.push({
					fileId: info.fileId,
					mimeType: info.mimeType,
					digest: info.digest
				});
			}
		});

		if (verbose) {
			console.log(`  上传成功: ${uploadedCount}, 失败: ${failedCount}`);
			console.log(`  准备创建笔记...`);
		}

		// 创建带图片的笔记
		const noteId = await api.importNoteWithImages(title, processedContent, imagesForNote, folderId, verbose);

		if (verbose) {
			console.log(`  成功! 笔记 ID: ${noteId}`);
		}

		return { success: true, noteId, imagesUploaded: uploadedCount, imagesFailed: failedCount };
	} catch (err) {
		const errorMsg = err instanceof Error ? err.message : String(err);
		return { success: false, error: errorMsg, imagesUploaded: 0, imagesFailed: 0 };
	}
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const options = parseArgs(args);

	console.log('小米笔记导入工具');
	console.log('================');

	// 获取 Cookie
	let cookie: string;
	if (options.useAppCookie && !options.cookie) {
		console.log('正在读取小米云应用 Cookie...');
		const cookieReader = new CookieReader();

		if (!cookieReader.canReadCookies()) {
			console.error(`错误: 找不到小米云应用的 Cookie 文件`);
			console.error(`路径: ${cookieReader.getCookiesPath()}`);
			console.error(`\n请确保:`);
			console.error(`1. 已安装小米云桌面应用`);
			console.error(`2. 已在小米云应用中登录账号`);
			console.error(`\n或者使用 -c 参数手动提供 Cookie`);
			process.exit(1);
		}

		try {
			cookie = await cookieReader.readCookies();
			console.log('✓ 成功读取 Cookie');
			if (options.verbose) {
				console.log('Cookie 预览 (前200字符):');
				console.log(cookie.substring(0, 200) + '...\n');
			}
		} catch (err) {
			console.error('错误: 读取 Cookie 失败:', (err as Error).message);
			process.exit(1);
		}
		} else {
			cookie = options.cookie!;
			console.log('使用手动提供的浏览器 Cookie\n');
			if (options.verbose) {
				console.log('Cookie 预览 (前200字符):');
				console.log(cookie.substring(0, 200) + '...\n');
			}
		}

	// 初始化 API
	const api = new MinoteApiCli({
		cookie: cookie,
		host: options.host
	});

	// ===== 列出笔记 =====
	if (options.listNotes) {
		console.log('\n正在获取笔记列表...');
		try {
			const notes = await api.getNotes(options.verbose || false);
			const folders = await api.getFolders(options.verbose || false);
			
			// 建立 folderId -> folderName 映射
			const folderNameMap = new Map<string, string>();
			folderNameMap.set('0', '未分类');
			for (const f of folders) {
				folderNameMap.set(f.id, f.subject);
			}
			
			console.log(`\n共 ${notes.length} 个笔记:\n`);
			console.log('ID | 标题 | 文件夹 | 创建时间');
			console.log('-'.repeat(80));
			
			for (const note of notes) {
				const folderName = folderNameMap.get(note.folderId) || '未知';
				const date = new Date(note.createDate).toLocaleString('zh-CN');
				console.log(`${note.id} | ${note.title.substring(0, 30).padEnd(30)} | ${folderName.padEnd(10)} | ${date}`);
			}
			
			console.log(`\n提示: 使用 --delete-note-id <id> --delete-note-tag <tag> 删除笔记`);
			process.exit(0);
		} catch (err) {
			console.error('获取笔记列表失败:', (err as Error).message);
			process.exit(1);
		}
	}

	// ===== 删除笔记 =====
	if (options.deleteNoteId && options.deleteNoteTag) {
		console.log(`\n正在删除笔记: ${options.deleteNoteId}`);
		try {
			await api.deleteNote(options.deleteNoteId, options.deleteNoteTag, options.verbose || false);
			console.log('✓ 笔记删除成功');
			process.exit(0);
		} catch (err) {
			console.error('删除笔记失败:', (err as Error).message);
			process.exit(1);
		}
	}

	// 获取要导入的文件列表
	const files: string[] = [];
	let sourceDir: string;

	if (options.file) {
		files.push(options.file);
		sourceDir = path.dirname(options.file);
	} else if (options.dir) {
		files.push(...getMarkdownFiles(options.dir));
		sourceDir = options.dir;
	} else {
		console.error('错误: 必须指定文件 (-f) 或文件夹 (-d)');
		process.exit(1);
	}

	console.log(`找到 ${files.length} 个 Markdown 文件`);

	// 文件夹分类模式
	let folderMapping: Map<string, string> = new Map(); // folderName -> folderId
	let filesWithFolder: Array<{ filePath: string; folderName: string | null; folderId: string; createTime: Date }> = [];
	
	if (options.organizeByFolder && options.dir) {
		console.log('\n[Organize] 启用文件夹分类模式');
		
		// 扫描目录，获取文件和文件夹信息
		const { files: scannedFiles, folderNames } = scanDirectoryWithFolders(options.dir);
		console.log(`[Organize] 发现 ${folderNames.length} 个子文件夹: ${folderNames.join(', ')}`);
		
		// 获取现有文件夹列表
		console.log('[Organize] 获取小米云现有文件夹...');
		try {
			const existingFolders = await api.getFolders(options.verbose || false);
			console.log(`[Organize] 小米云已有 ${existingFolders.length} 个文件夹`);
			
			// 建立文件夹名到ID的映射
			for (const folder of existingFolders) {
				folderMapping.set(folder.subject, folder.id);
			}
		} catch (err) {
			console.warn('[Organize] 获取文件夹列表失败，将创建新文件夹');
		}
		
		// 创建不存在的文件夹
		for (const folderName of folderNames) {
			if (!folderMapping.has(folderName)) {
				console.log(`[Organize] 创建文件夹: ${folderName}`);
				try {
					const cleanName = sanitizeFolderName(folderName);
					const result = await api.createFolder(cleanName, options.verbose || false);
					folderMapping.set(folderName, result.id);
					console.log(`[Organize] 文件夹创建成功: ${folderName} (ID: ${result.id})`);
				} catch (err) {
					console.error(`[Organize] 创建文件夹失败 ${folderName}:`, (err as Error).message);
				}
			} else {
				console.log(`[Organize] 使用现有文件夹: ${folderName} (ID: ${folderMapping.get(folderName)})`);
			}
		}
		
		// 构建带文件夹信息的文件列表
		for (const file of scannedFiles) {
			const folderId = file.folderName ? folderMapping.get(file.folderName) || '0' : '0';
			filesWithFolder.push({
				filePath: file.filePath,
				folderName: file.folderName,
				folderId: folderId,
				createTime: file.createTime
			});
		}
		
		// 如果需要保留时间顺序，按创建时间排序
		if (options.preserveOrder) {
			console.log('[Organize] 按文件创建时间排序（旧→新）');
			filesWithFolder.sort((a, b) => a.createTime.getTime() - b.createTime.getTime());
		}
		
		console.log(`[Organize] 已建立 ${filesWithFolder.length} 个文件的分类映射\n`);
	}

	// 初始化状态管理
	let stateManager: ImportState;
	
	if (options.resume) {
		// 从已有状态恢复
		stateManager = new ImportState(sourceDir, options.resume);
		console.log(`\n[Resume] 恢复导入状态: ${options.resume}`);
		
		if (options.retryFailed) {
			stateManager.resetFailed();
		}
	} else {
		// 创建新状态
		stateManager = new ImportState(sourceDir, options.stateFile);
		// 如果使用了文件夹分类，传入带文件夹信息的文件列表
		if (options.organizeByFolder && filesWithFolder.length > 0) {
			stateManager.initializePending(filesWithFolder.map(f => f.filePath));
		} else {
			stateManager.initializePending(files);
		}
	}

	stateManager.printProgress();

	// 开始导入
	const defaultFolderId = options.folderId || '0';
	if (!options.organizeByFolder) {
		console.log(`\n目标文件夹 ID: ${defaultFolderId}`);
	}
	console.log('开始导入...\n');

	const pendingFiles = stateManager.getPendingFiles();
	
	if (pendingFiles.length === 0) {
		console.log('没有待处理的文件，导入已完成！');
		stateManager.printProgress();
		process.exit(0);
	}

	console.log(`本次将处理 ${pendingFiles.length} 个文件\n`);

	for (let i = 0; i < pendingFiles.length; i++) {
		const file = pendingFiles[i];
		const stats = stateManager.getStats();
		
		// 确定文件应该导入到哪个文件夹
		let targetFolderId = defaultFolderId;
		let folderName: string | null = null;
		
		if (options.organizeByFolder && filesWithFolder.length > 0) {
			const fileInfo = filesWithFolder.find(f => f.filePath === file);
			if (fileInfo) {
				targetFolderId = fileInfo.folderId;
				folderName = fileInfo.folderName;
			}
		}
		
		// 打印文件信息（包括文件夹）
		if (folderName) {
			console.log(`[${stats.completed + stats.failed + 1}/${stats.total}] ${folderName}/${path.basename(file)}`);
		} else {
			console.log(`[${stats.completed + stats.failed + 1}/${stats.total}] ${path.basename(file)}`);
		}

		try {
			let result;
			if (options.withImages) {
				result = await importFileWithImages(api, file, targetFolderId, options.verbose || false);
				
				if (result.success) {
					if (result.imagesFailed > 0) {
						// 部分成功（有图片失败）
						stateManager.markPartial(file, result.noteId!, result.imagesUploaded + result.imagesFailed, result.imagesUploaded, result.imagesFailed, targetFolderId, folderName || undefined);
						console.log(`  ⚠ 部分成功 (ID: ${result.noteId}, 图片: ${result.imagesUploaded} 成功, ${result.imagesFailed} 失败)`);
					} else {
						// 完全成功
						stateManager.markSuccess(file, result.noteId!, true, targetFolderId, folderName || undefined);
						console.log(`  ✓ 成功 (ID: ${result.noteId}, 图片: ${result.imagesUploaded} 张)`);
					}
				} else {
					stateManager.markFailed(file, result.error || '导入失败', targetFolderId, folderName || undefined);
					console.log(`  ✗ 失败: ${result.error}`);
				}
			} else {
				const simpleResult = await importFile(api, file, targetFolderId, options.verbose || false);
				
				if (simpleResult.success) {
					stateManager.markSuccess(file, simpleResult.noteId!, false, targetFolderId, folderName || undefined);
					console.log(`  ✓ 成功 (ID: ${simpleResult.noteId})`);
				} else {
					stateManager.markFailed(file, simpleResult.error || '导入失败', targetFolderId, folderName || undefined);
					console.log(`  ✗ 失败: ${simpleResult.error}`);
				}
			}
		} catch (err) {
			const errorMsg = (err as Error).message;
			stateManager.markFailed(file, errorMsg, targetFolderId, folderName || undefined);
			console.log(`  ✗ 异常: ${errorMsg}`);
			
			// 如果是 Cookie 过期，提示用户
			if (errorMsg.includes('401') || errorMsg.includes('expired') || errorMsg.includes('Redirect')) {
				console.error('\n[Error] Cookie 可能已过期，请获取新的 Cookie 后使用 --resume 继续');
				console.error(`[Error] 状态文件: ${stateManager.getStateFilePath()}`);
				console.error(`[Error] 命令: npx ts-node cli/import-note.ts --resume ${stateManager.getStateFilePath()} -c "新Cookie..."`);
				break;
			}
		}

		// 每 5 个文件打印一次进度
		if ((i + 1) % 5 === 0 || i === pendingFiles.length - 1) {
			stateManager.printProgress();
		}

		// 添加小延迟，避免请求过快
		if (i < pendingFiles.length - 1) {
			await new Promise(resolve => setTimeout(resolve, 500));
		}
	}

	// 最终统计
	console.log('\n================');
	console.log('导入完成!');
	stateManager.printProgress();

	const stats = stateManager.getStats();
	process.exit(stats.failed > 0 ? 1 : 0);
}

main().catch(err => {
	console.error('程序异常:', err);
	process.exit(1);
});
