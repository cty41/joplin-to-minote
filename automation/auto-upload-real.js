#!/usr/bin/env node
/**
 * 自动上传真实图片到小米云笔记
 * 
 * 改进点：直接选择真实文件，不玩占位图替换
 * 
 * 使用方法:
 *   node auto-upload-real.js -c "serviceToken=xxx;..." -n "NOTE_ID" -i "path/to/image.jpg"
 * 
 * 示例:
 *   node auto-upload-real.js -c "serviceToken=xxx;userId=123" -n "49591787560911712" -i "../_resources/0523_1.jpg"
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

class RealImageUploader {
  constructor(cookieString) {
    this.cookieString = cookieString;
    this.browser = null;
    this.context = null;
    this.page = null;
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
   * 初始化浏览器
   */
  async init(headless = false) {
    console.log('[Init] Launching browser...');
    
    this.browser = await chromium.launch({
      headless: headless,
      slowMo: 100, // 慢一点便于观察
    });

    this.context = await this.browser.newContext({
      viewport: { width: 1280, height: 900 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    });

    this.page = await this.context.newPage();
    
    console.log('[Init] Browser ready');
  }

  /**
   * 登录小米云
   */
  async login() {
    console.log('[Login] Adding cookies...');
    const cookies = this.parseCookieString(this.cookieString);
    
    for (const c of cookies) {
      if (!c.name || !c.value) continue;
      try {
        await this.context.addCookies([{
          name: c.name,
          value: c.value,
          domain: '.mi.com',
          path: '/',
        }]);
      } catch (err) {
        // ignore
      }
    }

    console.log('[Login] Navigating to i.mi.com...');
    await this.page.goto('https://i.mi.com/', { waitUntil: 'domcontentloaded' });
    await this.page.waitForTimeout(3000);
    
    const url = this.page.url();
    console.log('[Login] Current URL:', url);
    
    if (url.includes('account') || url.includes('passport')) {
      throw new Error('Cookie expired, please get a new one');
    }
    
    console.log('[Login] Success');
  }

  /**
   * 查找图片上传按钮
   */
  async findUploadButton() {
    console.log('[Find] Looking for upload button...');
    
    // 获取所有按钮，找到工具栏区域的按钮
    const allButtons = await this.page.locator('button').all();
    let toolbarButtons = [];
    
    for (const btn of allButtons) {
      try {
        const visible = await btn.isVisible().catch(() => false);
        if (!visible) continue;
        
        const box = await btn.boundingBox().catch(() => null);
        // 工具栏按钮在页面顶部右侧 (x > 500, y 在 80-120 之间)
        if (box && box.y >= 80 && box.y <= 120 && box.x >= 500) {
          toolbarButtons.push({ btn, box });
        }
      } catch (err) {
        continue;
      }
    }
    
    console.log(`[Find] Found ${toolbarButtons.length} toolbar buttons`);
    
    // 按 x 坐标排序，取第一个（最左边的工具栏按钮应该是图片上传）
    toolbarButtons.sort((a, b) => a.box.x - b.box.x);
    
    if (toolbarButtons.length === 0) {
      throw new Error('No toolbar buttons found');
    }
    
    return toolbarButtons[0].btn;
  }

  /**
   * 上传图片到指定笔记
   */
  async uploadToNote(noteId, imagePath) {
    console.log(`\n========================================`);
    console.log(`[Upload] Note ID: ${noteId}`);
    console.log(`[Upload] Image: ${imagePath}`);
    console.log(`========================================\n`);
    
    // 验证文件存在
    if (!fs.existsSync(imagePath)) {
      throw new Error(`Image file not found: ${imagePath}`);
    }
    
    const stats = fs.statSync(imagePath);
    console.log(`[Upload] File size: ${stats.size} bytes`);

    // 导航到笔记
    const noteUrl = `https://i.mi.com/note/h5#/note/${noteId}`;
    console.log(`[Upload] Opening: ${noteUrl}`);
    
    await this.page.goto(noteUrl, { waitUntil: 'domcontentloaded' });
    await this.page.waitForTimeout(3000);
    
    // 截图看当前状态
    await this.page.screenshot({ path: `before-${noteId}.png` });
    console.log(`[Upload] Screenshot saved: before-${noteId}.png`);

    // 查找上传按钮
    const uploadBtn = await this.findUploadButton();
    console.log(`[Upload] Found upload button`);

    // 点击上传按钮并等待文件选择对话框
    console.log(`[Upload] Clicking upload button...`);
    const [fileChooser] = await Promise.all([
      this.page.waitForEvent('filechooser', { timeout: 10000 }),
      uploadBtn.click(),
    ]);
    
    console.log(`[Upload] File chooser opened`);

    // 关键改进：直接选择真实文件！
    console.log(`[Upload] Selecting REAL image file...`);
    await fileChooser.setFiles(imagePath);
    console.log(`[Upload] Selected: ${path.basename(imagePath)}`);

    // 等待上传完成（观察网络活动）
    console.log(`[Upload] Waiting for upload to complete (15s)...`);
    await this.page.waitForTimeout(15000);

    // 最终截图
    await this.page.screenshot({ path: `after-${noteId}.png` });
    console.log(`[Upload] Screenshot saved: after-${noteId}.png`);
    
    console.log(`\n✅ Upload attempt completed!`);
    console.log(`Please check after-${noteId}.png to verify`);
  }

  /**
   * 批量上传
   */
  async batchUpload(mapping) {
    // mapping: { noteId: imagePath, ... }
    
    for (const [noteId, imagePath] of Object.entries(mapping)) {
      try {
        await this.uploadToNote(noteId, imagePath);
      } catch (err) {
        console.error(`\n❌ Failed to upload to ${noteId}:`, err.message);
      }
      
      // 每个笔记之间间隔 3 秒
      console.log('\n[Batch] Waiting 3s before next note...');
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      console.log('\n[Close] Browser closed');
    }
  }
}

/**
 * 解析命令行参数
 */
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    headless: false, // 默认显示浏览器
  };
  
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--cookie':
      case '-c':
        options.cookie = args[++i];
        break;
      case '--note':
      case '-n':
        options.noteId = args[++i];
        break;
      case '--image':
      case '-i':
        options.imagePath = args[++i];
        break;
      case '--headless':
        options.headless = true;
        break;
      case '--help':
      case '-h':
        showHelp();
        process.exit(0);
        break;
    }
  }
  
  return options;
}

function showHelp() {
  console.log(`
Auto Upload Real Images to Xiaomi Cloud
=======================================

Usage:
  node auto-upload-real.js -c "COOKIE" -n "NOTE_ID" -i "IMAGE_PATH"

Options:
  -c, --cookie <cookie>    Cookie string with serviceToken and userId
  -n, --note <id>        Note ID to upload image to
  -i, --image <path>      Real image file path
  --headless              Run in headless mode (no browser window)
  -h, --help              Show this help

Examples:
  # Single note upload
  node auto-upload-real.js -c "serviceToken=xxx;userId=123" -n "49591787560911712" -i "../_resources/0523_1.jpg"

  # Headless mode (faster, but can't see what's happening)
  node auto-upload-real.js --headless -c "..." -n "..." -i "..."

How it works:
  1. Opens browser and navigates to the note
  2. Finds the image upload button in toolbar
  3. Clicks upload and selects the REAL image file directly
  4. Waits for upload to complete
  5. Takes screenshot for verification

Notes:
  - This script selects the REAL image directly, no placeholder tricks
  - Browser window is shown by default so you can see what's happening
  - Screenshots (before-{noteId}.png, after-{noteId}.png) are saved for verification
`);
}

/**
 * 主函数
 */
async function main() {
  const options = parseArgs();
  
  if (!options.cookie || !options.noteId || !options.imagePath) {
    console.error('Error: Missing required arguments');
    console.error('Usage: node auto-upload-real.js -c "COOKIE" -n "NOTE_ID" -i "IMAGE_PATH"');
    console.error('Use -h for help');
    process.exit(1);
  }
  
  // 转换相对路径为绝对路径
  const imagePath = path.resolve(options.imagePath);
  
  if (!fs.existsSync(imagePath)) {
    console.error(`Error: Image file not found: ${imagePath}`);
    process.exit(1);
  }
  
  const uploader = new RealImageUploader(options.cookie);
  
  try {
    await uploader.init(options.headless);
    await uploader.login();
    await uploader.uploadToNote(options.noteId, imagePath);
    console.log('\n🎉 All done!');
  } catch (err) {
    console.error('\n❌ Error:', err.message);
    process.exit(1);
  } finally {
    await uploader.close();
  }
}

// 运行
if (require.main === module) {
  main();
}

module.exports = { RealImageUploader };
