const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class MiNoteUploader {
  constructor(cookieString = null) {
    this.browser = null;
    this.context = null;
    this.page = null;
    this.cookieString = cookieString;
    this.fileMapping = {}; // placeholder -> real file path
  }

  /**
   * 计算文件 MD5
   */
  calculateMd5(buffer) {
    return crypto.createHash('md5').update(buffer).digest('hex');
  }

  /**
   * 计算文件 SHA1
   */
  calculateSha1(buffer) {
    return crypto.createHash('sha1').update(buffer).digest('hex');
  }

  /**
   * 解析 Cookie 字符串
   */
  parseCookieString(cookieStr) {
    return cookieStr.split(';').map(pair => {
      const [name, ...valueParts] = pair.trim().split('=');
      return { name, value: valueParts.join('=') };
    }).filter(c => c.name);
  }

  /**
   * 设置文件映射表
   */
  setFileMapping(mapping) {
    this.fileMapping = mapping;
    console.log('[Uploader] File mapping updated:', Object.keys(mapping));
  }

  /**
   * 初始化浏览器
   */
  async init(headless = false) {
    console.log('[Init] Launching browser...');
    
    this.browser = await chromium.launch({
      headless: headless,
      slowMo: 100,
    });

    this.context = await this.browser.newContext({
      viewport: { width: 1280, height: 900 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });

    this.page = await this.context.newPage();

    // 设置请求拦截
    await this.setupRequestInterception();

    console.log('[Init] Browser ready');
  }

  /**
   * 设置请求拦截 - 核心功能：替换 KSS 上传的文件
   */
  async setupRequestInterception() {
    await this.page.route('**/*', async (route, request) => {
      const url = request.url();
      
      // 拦截 KSS 上传请求
      if (url.includes('xmssdn.micloud.mi.com') || url.includes('kssh2.xmssdn.micloud.mi.com')) {
        console.log('[Intercept] KSS upload detected:', url);
        
        // 从 URL 或 headers 获取文件名
        const headers = await request.allHeaders();
        const filename = headers['x-kss-newfilename'] || this.extractFilenameFromUrl(url);
        
        console.log('[Intercept] Original filename:', filename);
        console.log('[Intercept] Available mappings:', Object.keys(this.fileMapping));
        
        // 查找替换文件
        let replacementPath = null;
        for (const [key, value] of Object.entries(this.fileMapping)) {
          if (filename && filename.includes(key)) {
            replacementPath = value;
            break;
          }
        }
        
        if (!replacementPath) {
          console.log('[Intercept] No mapping found for:', filename);
          console.log('[Intercept] Continuing with original request');
          await route.continue();
          return;
        }

        try {
          // 读取替换文件
          const newContent = fs.readFileSync(replacementPath);
          console.log('[Intercept] Replacing with:', replacementPath);
          console.log('[Intercept] New file size:', newContent.length, 'bytes');

          // 计算新的 hash 值
          const newMd5 = this.calculateMd5(newContent);
          const newSha1 = this.calculateSha1(newContent);

          // 修改 headers
          const newHeaders = {
            ...headers,
            'content-length': String(newContent.length),
            'content-md5': newMd5,
            'x-kss-sha1': newSha1,
          };

          console.log('[Intercept] New MD5:', newMd5);
          console.log('[Intercept] New SHA1:', newSha1);

          // 继续请求，使用新内容
          await route.continue({
            headers: newHeaders,
            postData: newContent,
          });

          console.log('[Intercept] Request continued with replacement');
          return;
        } catch (err) {
          console.error('[Intercept] Error replacing file:', err.message);
          await route.continue();
          return;
        }
      }

      // 记录 request_upload_file 响应
      if (url.includes('request_upload_file')) {
        console.log('[Intercept] Upload permission request detected');
        const response = await route.fetch();
        const responseBody = await response.text();
        console.log('[Intercept] Upload permission response:', responseBody.substring(0, 500));
        
        // 完成原始请求
        await route.fulfill({
          response,
          body: responseBody,
        });
        return;
      }

      // 其他请求正常通过
      await route.continue();
    });

    // 监听响应
    this.page.on('response', async response => {
      const url = response.url();
      
      // 记录上传响应
      if (url.includes('xmssdn.micloud.mi.com') || url.includes('kssh2.xmssdn.micloud.mi.com')) {
        const status = response.status();
        console.log('[Response] KSS upload response status:', status);
        
        if (status >= 200 && status < 300) {
          console.log('[Response] Upload successful!');
        } else {
          const body = await response.text().catch(() => '');
          console.log('[Response] Upload failed:', body.substring(0, 500));
        }
      }
    });
  }

  /**
   * 从 URL 提取文件名
   */
  extractFilenameFromUrl(url) {
    try {
      const urlObj = new URL(url);
      const pathParts = urlObj.pathname.split('/');
      return pathParts[pathParts.length - 1] || null;
    } catch {
      return null;
    }
  }

  /**
   * 使用 Cookie 登录
   */
  async loginWithCookies() {
    if (!this.cookieString) {
      throw new Error('No cookie string provided');
    }

    console.log('[Login] Using provided cookies...');
    const cookies = this.parseCookieString(this.cookieString);
    
    // 添加 Cookie 到不同域名
    for (const c of cookies) {
      if (!c.name || !c.value) continue;
      
      const cookieData = {
        name: c.name,
        value: c.value,
        domain: '.mi.com',
        path: '/',
      };
      
      try {
        await this.context.addCookies([cookieData]);
      } catch (err) {
        console.log(`[Login] Warning: Failed to add cookie ${c.name}:`, err.message);
      }
    }

    // 访问小米云笔记验证登录
    // 尝试多个可能的入口 URL
    const possibleUrls = [
      'https://i.mi.com/note',
      'https://i.mi.com/note/h5',
      'https://i.mi.com/',
      'https://i.mi.com/note#/' 
    ];
    
    let loadedUrl = null;
    for (const url of possibleUrls) {
      try {
        console.log(`[Login] Trying: ${url}`);
        await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
        
        // 检查是否 404
        const title = await this.page.title().catch(() => '');
        const content = await this.page.content().catch(() => '');
        
        if (!content.includes('404') && !title.includes('404')) {
          loadedUrl = url;
          console.log(`[Login] Successfully loaded: ${url}`);
          break;
        }
      } catch (err) {
        console.log(`[Login] Failed to load ${url}:`, err.message);
        continue;
      }
    }
    
    if (!loadedUrl) {
      throw new Error('All entry URLs failed');
    }
    
    // 截图用于调试
    await this.page.screenshot({ path: 'login-debug.png' });
    console.log('[Login] Screenshot saved: login-debug.png');
    
    // 检查当前 URL
    const url = this.page.url();
    console.log('[Login] Current URL:', url);
    
    // 检查是否是登录页面
    if (url.includes('account.xiaomi.com') || url.includes('passport')) {
      console.log('[Login] Cookie expired or invalid, redirected to login page');
      return false;
    }
    
    // 等待笔记列表或登录框
    try {
      // 尝试多种可能的选择器
      const selectors = [
        '.note-list',
        '[data-testid="note-list"]',
        '.note-container',
        '.main-content',
        '.note-app',
        '.app-container',
        '[class*="note"]',
      ];
      
      for (const selector of selectors) {
        try {
          const element = this.page.locator(selector).first();
          if (await element.isVisible({ timeout: 3000 }).catch(() => false)) {
            console.log(`[Login] Success - found element: ${selector}`);
            return true;
          }
        } catch (err) {
          continue;
        }
      }
      
      console.log('[Login] No standard selectors found, but not on login page');
      console.log('[Login] Assuming logged in, waiting for page to settle...');
      await this.page.waitForTimeout(3000);
      return true;
      
    } catch (err) {
      console.error('[Login] Error waiting for selectors:', err.message);
      return false;
    }
  }

  /**
   * 手动登录（交互式）
   */
  async loginInteractive() {
    console.log('[Login] Opening login page...');
    await this.page.goto('https://i.mi.com/note');
    
    console.log('[Login] Please login manually in the browser window');
    console.log('[Login] Waiting for note list to appear...');
    
    // 等待登录成功
    await this.page.waitForSelector('.note-list, [data-testid="note-list"], .note-container', { 
      timeout: 120000 
    });
    
    console.log('[Login] Login successful');
    
    // 保存登录状态
    await this.context.storageState({ path: 'auth.json' });
    console.log('[Login] Session saved to auth.json');
  }

  /**
   * 创建新笔记
   */
  async createNote(title, content) {
    console.log('[Note] Creating new note:', title);
    
    // 等待页面加载
    await this.page.waitForLoadState('networkidle');
    
    // 查找并点击新建笔记按钮
    const newNoteSelectors = [
      '.new-note-btn',
      '[data-testid="new-note"]',
      'button:has-text("新建")',
      'button:has-text("新建笔记")',
      '.nav-new-note button',
      '.add-note-btn',
    ];
    
    let clicked = false;
    for (const selector of newNoteSelectors) {
      try {
        const btn = this.page.locator(selector).first();
        if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
          await btn.click();
          clicked = true;
          console.log('[Note] Clicked new note button:', selector);
          break;
        }
      } catch (err) {
        continue;
      }
    }
    
    if (!clicked) {
      console.log('[Note] No new note button found, trying keyboard shortcut');
      await this.page.keyboard.press('Control+n');
    }
    
    // 等待编辑器加载
    await this.page.waitForTimeout(2000);
    
    // 设置标题
    const titleSelectors = [
      '.note-title input',
      '[data-testid="note-title"]',
      'input[placeholder*="标题"]',
      '.editor-title',
    ];
    
    for (const selector of titleSelectors) {
      try {
        const titleInput = this.page.locator(selector).first();
        if (await titleInput.isVisible({ timeout: 2000 }).catch(() => false)) {
          await titleInput.fill(title);
          console.log('[Note] Title set:', title);
          break;
        }
      } catch (err) {
        continue;
      }
    }
    
    // 设置内容
    const contentSelectors = [
      '.note-content-editor',
      '[data-testid="note-content"]',
      '[contenteditable="true"]',
      '.editor-content',
    ];
    
    for (const selector of contentSelectors) {
      try {
        const contentEditor = this.page.locator(selector).first();
        if (await contentEditor.isVisible({ timeout: 2000 }).catch(() => false)) {
          await contentEditor.fill(content);
          console.log('[Note] Content set');
          break;
        }
      } catch (err) {
        continue;
      }
    }
    
    // 等待自动保存
    await this.page.waitForTimeout(2000);
    
    // 获取笔记 ID
    const url = this.page.url();
    const match = url.match(/\/note\/(\d+)/);
    const noteId = match ? match[1] : null;
    
    console.log('[Note] Note created, ID:', noteId);
    return noteId;
  }

  /**
   * 在笔记中上传图片
   */
  async uploadImageToNote(placeholderImagePath) {
    console.log('[Image] Initiating upload for:', placeholderImagePath);
    
    // 查找上传按钮
    const uploadSelectors = [
      '.upload-image-btn',
      '[data-testid="upload-image"]',
      'button:has-text("图片")',
      '.toolbar-image-btn',
      '.insert-image',
    ];
    
    let uploadBtn = null;
    for (const selector of uploadSelectors) {
      try {
        const btn = this.page.locator(selector).first();
        if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
          uploadBtn = btn;
          break;
        }
      } catch (err) {
        continue;
      }
    }
    
    if (!uploadBtn) {
      console.log('[Image] No upload button found, trying toolbar menu');
      // 尝试点击更多菜单
      const moreBtn = this.page.locator('.more-btn, .toolbar-more, [data-testid="more"]').first();
      if (await moreBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await moreBtn.click();
        await this.page.waitForTimeout(500);
        
        // 再次查找上传按钮
        for (const selector of uploadSelectors) {
          try {
            const btn = this.page.locator(selector).first();
            if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
              uploadBtn = btn;
              break;
            }
          } catch (err) {
            continue;
          }
        }
      }
    }
    
    if (!uploadBtn) {
      throw new Error('Upload image button not found');
    }
    
    // 等待文件选择对话框
    const [fileChooser] = await Promise.all([
      this.page.waitForEvent('filechooser', { timeout: 10000 }),
      uploadBtn.click(),
    ]);
    
    console.log('[Image] File chooser opened');
    
    // 选择占位图片
    await fileChooser.setFiles(placeholderImagePath);
    console.log('[Image] Placeholder file selected:', placeholderImagePath);
    
    // 等待上传完成（通过监听响应或 UI 变化）
    console.log('[Image] Waiting for upload to complete...');
    
    try {
      // 等待图片出现在编辑器中
      await this.page.waitForSelector('.note-image, .uploaded-image, img[data-fileid]', { 
        timeout: 30000 
      });
      console.log('[Image] Upload completed successfully');
    } catch (err) {
      console.log('[Image] Waiting for UI indicator timeout, checking alternative...');
      await this.page.waitForTimeout(5000);
    }
    
    return true;
  }

  /**
   * 关闭浏览器
   */
  async close() {
    if (this.browser) {
      await this.browser.close();
      console.log('[Close] Browser closed');
    }
  }
}

module.exports = { MiNoteUploader };
