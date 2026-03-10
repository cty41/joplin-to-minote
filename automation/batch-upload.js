#!/usr/bin/env node
/**
 * @file 批量图片上传脚本
 * @description 基于状态文件，批量上传笔记中的图片
 * @usage
 *   node batch-upload.js -s ../cli/import-state-xxx.json -c "cookie"
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

class BatchImageUploader {
  constructor(cookieString, stateFilePath) {
    this.cookieString = cookieString;
    this.stateFilePath = stateFilePath;
    this.state = JSON.parse(fs.readFileSync(stateFilePath, 'utf-8'));
    this.browser = null;
    this.context = null;
    this.page = null;
  }

  parseCookieString(cookieStr) {
    return cookieStr.split(';').map(pair => {
      const [name, ...valueParts] = pair.trim().split('=');
      return { name, value: valueParts.join('=') };
    }).filter(c => c.name);
  }

  async init(headless = false) {
    console.log('[Init] Launching browser...');
    
    this.browser = await chromium.launch({ headless, slowMo: 100 });
    this.context = await this.browser.newContext({
      viewport: { width: 1280, height: 900 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    });
    this.page = await this.context.newPage();
    
    console.log('[Init] Browser ready');
  }

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
      } catch (err) {}
    }

    console.log('[Login] Navigating to i.mi.com...');
    await this.page.goto('https://i.mi.com/', { waitUntil: 'domcontentloaded' });
    await this.page.waitForTimeout(3000);
    
    const url = this.page.url();
    if (url.includes('account') || url.includes('passport')) {
      throw new Error('Cookie expired, please get a new one');
    }
    
    console.log('[Login] Success');
  }

  async findUploadButton() {
    const allButtons = await this.page.locator('button').all();
    let toolbarButtons = [];
    
    for (const btn of allButtons) {
      try {
        const visible = await btn.isVisible().catch(() => false);
        if (!visible) continue;
        
        const box = await btn.boundingBox().catch(() => null);
        if (box && box.y >= 80 && box.y <= 120 && box.x >= 500) {
          toolbarButtons.push({ btn, box });
        }
      } catch (err) {
        continue;
      }
    }
    
    if (toolbarButtons.length === 0) {
      throw new Error('No toolbar buttons found');
    }
    
    toolbarButtons.sort((a, b) => a.box.x - b.box.x);
    return toolbarButtons[0].btn;
  }

  async uploadImageToNote(noteId, imagePath, noteTitle = '') {
    console.log(`\n[Upload] ${noteTitle || noteId}`);
    console.log(`[Upload] Image: ${path.basename(imagePath)}`);
    
    if (!fs.existsSync(imagePath)) {
      console.log(`  ⚠ Image not found: ${imagePath}`);
      return false;
    }

    try {
      const url = `https://i.mi.com/note/h5#/note/${noteId}`;
      await this.page.goto(url, { waitUntil: 'domcontentloaded' });
      await this.page.waitForTimeout(3000);

      const uploadBtn = await this.findUploadButton();
      
      const [fileChooser] = await Promise.all([
        this.page.waitForEvent('filechooser', { timeout: 10000 }),
        uploadBtn.click(),
      ]);

      await fileChooser.setFiles(imagePath);
      console.log(`  ⏳ Uploading...`);
      
      await this.page.waitForTimeout(15000);
      console.log(`  ✓ Done`);
      
      return true;
    } catch (err) {
      console.log(`  ✗ Failed: ${err.message}`);
      return false;
    }
  }

  async processBatch() {
    console.log('\n========================================');
    console.log('Batch Image Upload');
    console.log('========================================\n');
    
    // 找出需要上传图片的笔记
    const notesNeedingUpload = [];
    
    for (const completed of this.state.completed) {
      if (completed.hasImages && completed.status !== 'success') {
        // 查找对应的图片文件
        const mdFilePath = completed.filePath;
        const mdDir = path.dirname(mdFilePath);
        const mdContent = fs.readFileSync(mdFilePath, 'utf-8');
        
        // 提取第一个图片引用
        const match = mdContent.match(/!\[([^\]]*)\]\(([^)]+)\)/);
        if (match) {
          const relativePath = match[2];
          let imagePath = path.resolve(mdDir, decodeURIComponent(relativePath));
          
          // 如果找不到，尝试其他路径
          if (!fs.existsSync(imagePath)) {
            const altPaths = [
              path.resolve(mdDir, '..', '_resources', path.basename(relativePath)),
              path.resolve(mdDir, '_resources', path.basename(relativePath)),
            ];
            for (const alt of altPaths) {
              if (fs.existsSync(alt)) {
                imagePath = alt;
                break;
              }
            }
          }
          
          if (fs.existsSync(imagePath)) {
            notesNeedingUpload.push({
              noteId: completed.noteId,
              filePath: completed.filePath,
              imagePath: imagePath,
              title: path.basename(completed.filePath, '.md'),
              imagesTotal: completed.imagesTotal || 1,
              imagesUploaded: completed.imagesUploaded || 0,
              imagesFailed: completed.imagesFailed || 0
            });
          }
        }
      }
    }
    
    console.log(`Found ${notesNeedingUpload.length} notes needing image upload\n`);
    
    if (notesNeedingUpload.length === 0) {
      console.log('All images already uploaded!');
      return;
    }
    
    // 逐个上传
    for (let i = 0; i < notesNeedingUpload.length; i++) {
      const note = notesNeedingUpload[i];
      console.log(`[${i + 1}/${notesNeedingUpload.length}] Processing...`);
      
      const success = await this.uploadImageToNote(note.noteId, note.imagePath, note.title);
      
      if (success) {
        // 更新状态
        const completedNote = this.state.completed.find(c => c.noteId === note.noteId);
        if (completedNote) {
          completedNote.status = 'success';
          completedNote.imagesUploaded = completedNote.imagesTotal;
          completedNote.imagesFailed = 0;
        }
      }
      
      // 保存状态
      fs.writeFileSync(this.stateFilePath, JSON.stringify(this.state, null, 2));
      
      // 间隔 3 秒
      if (i < notesNeedingUpload.length - 1) {
        await new Promise(r => setTimeout(r, 3000));
      }
    }
    
    console.log('\n========================================');
    console.log('Batch upload complete!');
    console.log('========================================');
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      console.log('[Close] Browser closed');
    }
  }
}

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {};
  
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--cookie' || args[i] === '-c') {
      options.cookie = args[++i];
    } else if (args[i] === '--state' || args[i] === '-s') {
      options.state = args[++i];
    } else if (args[i] === '--headless') {
      options.headless = true;
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`
Batch Image Upload to Xiaomi Cloud

Usage:
  node batch-upload.js -s <state-file> -c <cookie>

Options:
  -s, --state <path>    Path to import-state.json file
  -c, --cookie <str>    Cookie string with serviceToken
  --headless            Run in headless mode
  -h, --help            Show help

Example:
  node batch-upload.js -s ../joplin/.import-state-xxx.json -c "serviceToken=xxx;userId=123"
`);
      process.exit(0);
    }
  }
  
  return options;
}

async function main() {
  const options = parseArgs();
  
  if (!options.cookie || !options.state) {
    console.error('Error: Missing required arguments');
    console.error('Usage: node batch-upload.js -s <state-file> -c <cookie>');
    process.exit(1);
  }
  
  if (!fs.existsSync(options.state)) {
    console.error(`State file not found: ${options.state}`);
    process.exit(1);
  }
  
  const uploader = new BatchImageUploader(options.cookie, options.state);
  
  try {
    await uploader.init(options.headless || false);
    await uploader.login();
    await uploader.processBatch();
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  } finally {
    await uploader.close();
  }
}

if (require.main === module) {
  main();
}

module.exports = { BatchImageUploader };
