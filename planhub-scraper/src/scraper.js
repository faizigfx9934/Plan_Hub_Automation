// PlanHub Scraper - Stable Fleet Version
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import 'dotenv/config';
import { SEL } from './selectors.js';
import { logger } from './logger.js';
import * as telemetry from './telemetry.js';
import { ensureVpn } from './vpn.js';

// Configuration
const RUN_FOREVER = process.env.RUN_FOREVER === 'true';
const MAX_RUNTIME_MS = 8.5 * 60 * 60 * 1000;
const START_TIME = Date.now();
const PROGRESS_FILE = 'data/progress.json';
const DEDUP_FILE = 'data/dedup.json';

const OUTPUT_DIR = `runs/${new Date().toISOString().split('T')[0]}`;
fs.mkdirSync(`${OUTPUT_DIR}`, { recursive: true });
fs.mkdirSync('data', { recursive: true });

const SCREENSHOTS_DIR = 'screenshots';
fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

let COMPANY_ZIP_CODE = process.env.PLANHUB_ZIP || null; // Can be pre-seeded by setup script
const OCR_DONE_DIR = path.join(process.cwd(), '..', 'ocr-pipeline', 'done');

// State Persistence
function loadProgress() {
  if (fs.existsSync(PROGRESS_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
      if (data.dayOffset !== undefined) {
        const savedDate = new Date(data.timestamp);
        const today = new Date();
        const diffDays = Math.floor((today - savedDate) / (1000 * 60 * 60 * 24));
        const resumeOffset = data.dayOffset - diffDays;
        
        // Safety Cap: If offset is suspicious (> 60 days) or negative, reset to default
        if (resumeOffset > 60 || resumeOffset < 0) {
          logger.warning(`📈 Offset ${resumeOffset} is outside safe range (0-60). Resetting to default.`);
          return null;
        }

        logger.info(`📈 Resuming from progress.json (Saved Offset: ${data.dayOffset}, Adjusted: ${resumeOffset})`);
        return resumeOffset;
      }
    } catch (err) {
      logger.fail('Failed to parse progress.json, starting fresh');
    }
  }
  return null;
}

function saveProgress(offset) {
  try {
    const data = {
      dayOffset: offset,
      timestamp: new Date().toISOString()
    };
    const dir = path.dirname(PROGRESS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify(data, null, 2));
    logger.ok(`💾 Progress saved: dayOffset ${offset}`);
  } catch (err) {
    logger.fail(`Failed to save progress: ${err.message}`);
  }
}

function findProjectFolder(projectName) {
  const safeProjectName = projectName.replace(/[<>:"/\\|?*\x00-\x1F]/g, '').trim().slice(0, 100);
  
  // 1. Search in main screenshots dir
  if (fs.existsSync(SCREENSHOTS_DIR)) {
    const folders = fs.readdirSync(SCREENSHOTS_DIR);
    const match = folders.find(f => f === safeProjectName || f.startsWith(`${safeProjectName} (`));
    if (match) return path.join(SCREENSHOTS_DIR, match);
  }

  // 2. Search in OCR done dir
  if (fs.existsSync(OCR_DONE_DIR)) {
    const folders = fs.readdirSync(OCR_DONE_DIR);
    const match = folders.find(f => f === safeProjectName || f.startsWith(`${safeProjectName} (`));
    if (match) return path.join(OCR_DONE_DIR, match);
  }

  return null;
}

function isCompanyInOcrDone(projectName, companyName) {
  const projectFolderInOcr = findProjectFolder(projectName);
  if (!projectFolderInOcr) return false;

  const safeCompanyName = companyName.replace(/[^a-z0-9]/gi, '_').toLowerCase().slice(0, 30);
  if (fs.existsSync(projectFolderInOcr)) {
    const files = fs.readdirSync(projectFolderInOcr);
    // OCR files usually have names like: company_location_date.png
    return files.some(f => f.toLowerCase().startsWith(safeCompanyName));
  }
  return false;
}

function countScreenshots(folderPath) {
  if (!folderPath || !fs.existsSync(folderPath)) return 0;
  return fs.readdirSync(folderPath).filter(f => f.endsWith('.png')).length;
}

function loadPreviousData() {
  const previousData = new Set();
  
  // 1. Load from master dedup file
  if (fs.existsSync(DEDUP_FILE)) {
    try {
      const lines = fs.readFileSync(DEDUP_FILE, 'utf8').split('\n').filter(Boolean);
      lines.forEach(line => previousData.add(line.trim()));
      logger.info(`Loaded ${previousData.size} from ${DEDUP_FILE}`);
    } catch (err) {}
  }

  // 2. Load from any existing runs (backwards compatibility/sync)
  const runsDir = 'runs';
  if (fs.existsSync(runsDir)) {
    const runFolders = fs.readdirSync(runsDir);
    for (const folder of runFolders) {
      const jsonPath = `${runsDir}/${folder}/data.json`;
      if (fs.existsSync(jsonPath)) {
        try {
          const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
          data.forEach(entry => {
            const key = `${entry.project}|||${entry.company}`;
            if (!previousData.has(key)) {
              previousData.add(key);
              // Append to dedup if missing
              fs.appendFileSync(DEDUP_FILE, key + '\n');
            }
          });
        } catch (err) {}
      }
    }
  }
  
  logger.info(`Final dedup set size: ${previousData.size}`);
  return previousData;
}

function saveToDedup(projectName, companyName) {
  try {
    const key = `${projectName}|||${companyName}`;
    if (!PREVIOUS_SCRAPES.has(key)) {
      PREVIOUS_SCRAPES.add(key);
      const dir = path.dirname(DEDUP_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(DEDUP_FILE, key + '\n');
    }
  } catch (err) {
    logger.fail(`Failed to save dedup: ${err.message}`);
  }
}

let PREVIOUS_SCRAPES = loadPreviousData();

async function login(page) {
  logger.step('Login');
  await page.goto('https://access.planhub.com/signin');
  await page.getByRole('textbox', { name: 'Email' }).fill(process.env.PLANHUB_EMAIL);
  await page.getByRole('textbox', { name: 'Password' }).fill(process.env.PLANHUB_PASSWORD);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await page.waitForURL(/supplier\.planhub\.com/, { timeout: 60000 });
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(2000);
  logger.ok('Logged in');
}

async function ensureLoggedIn(page, returnUrl = 'https://supplier.planhub.com/project/list') {
  const url = page.url();
  if (!/signin|login|access\.planhub\.com/i.test(url)) return false;
  logger.fail('⚠️ Session expired mid-run — re-authenticating');
  await login(page);
  await page.context().storageState({ path: 'session.json' });
  if (returnUrl) {
    await page.goto(returnUrl, { timeout: 60000, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
  }
  return true;
}

async function getCompanyZipCode(page) {
  if (COMPANY_ZIP_CODE) return COMPANY_ZIP_CODE;
  
  logger.step('Fetching company ZIP code from account settings');
  await page.goto('https://supplier.planhub.com/project/list', { waitUntil: 'domcontentloaded' });
  await ensureLoggedIn(page);

  await page.getByRole(SEL.account.profileImage.role, { name: SEL.account.profileImage.name }).click();
  await page.waitForTimeout(800);
  await page.getByRole(SEL.account.myAccount.role, { name: SEL.account.myAccount.name }).click();
  await page.waitForTimeout(1500);
  await page.getByRole(SEL.account.companySettingsButton.role, { name: SEL.account.companySettingsButton.name }).click();
  await page.waitForTimeout(1000);
  await page.getByRole(SEL.account.viewCompanySettingsLink.role, { name: SEL.account.viewCompanySettingsLink.name }).click();
  await page.waitForTimeout(2500);

  const zipInput = page.getByRole(SEL.account.zipCodeInput.role, { name: SEL.account.zipCodeInput.name }).first();
  await zipInput.waitFor({ state: 'visible', timeout: 15000 });
  const zipCode = (await zipInput.inputValue().catch(() => '')).trim();
  if (!zipCode) {
    throw new Error('Could not read company ZIP code from Company Settings');
  }

  COMPANY_ZIP_CODE = zipCode;
  logger.ok(`Company ZIP detected: ${COMPANY_ZIP_CODE}`);
  return COMPANY_ZIP_CODE;
}

async function setDateFilter(page, dayOffset = 0) {
  logger.step(`Setting date and ZIP filters: today+${dayOffset}`);
  
  // 1. Fetch ZIP from settings
  const zipCode = await getCompanyZipCode(page);
  
  // 2. Return to project list
  await page.goto('https://supplier.planhub.com/project/list', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  await ensureLoggedIn(page);

  // 3. Open Search Filters
  await page.waitForSelector('text=/search/i', { timeout: 30000 });
  await page.getByLabel('Search (2)').getByRole('button').filter({ hasText: /^$/ }).click();
  await page.waitForTimeout(1000);

  // 4. Navigate to "Custom" tab in date carousel
  for (let i = 0; i < 8; i++) {
    const customTab = page.getByText('Custom', { exact: true });
    if (await customTab.isVisible().catch(() => false)) break;
    await page.locator(SEL.dateFilter.paginateArrow).click().catch(() => {});
    await page.waitForTimeout(300);
  }
  await page.getByText('Custom').click();
  await page.waitForTimeout(1500);

  // 5. Set Date (today + dayOffset)
  const today = new Date();
  const targetDate = new Date(today);
  targetDate.setDate(today.getDate() + dayOffset);
  
  const clickCalendarDay = async (d) => {
    const targetMonth = d.toLocaleString('en-US', { month: 'long' });
    const targetYear = d.getFullYear().toString();
    const ariaLabel = d.toLocaleString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

    // Navigate to correct month/year
    for (let i = 0; i < 12; i++) {
      const period = await page.locator('button.mat-calendar-period-button').innerText().catch(() => '');
      if (period.toUpperCase().includes(targetMonth.toUpperCase()) && period.includes(targetYear)) break;
      
      const nextBtn = page.locator('button.mat-calendar-next-button');
      if (await nextBtn.isVisible()) {
        await nextBtn.click();
        await page.waitForTimeout(600);
      } else {
        break;
      }
    }

    const btn = page.locator(`button[aria-label="${ariaLabel}"]`).first();
    await btn.waitFor({ state: 'attached', timeout: 10000 });
    await btn.evaluate(el => {
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.click();
    });
  };
  
  await clickCalendarDay(targetDate);
  await page.waitForTimeout(800);
  await clickCalendarDay(targetDate); // Start and End are same
  await page.waitForTimeout(1000);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(2000);

  // 6. Paste ZIP Code from account settings
  const zipFilter = page.getByRole(SEL.account.zipCodeInput.role, { name: SEL.account.zipCodeInput.name }).first();
  await zipFilter.click();
  await zipFilter.fill(zipCode);
  await zipFilter.press('Tab');
  await page.waitForTimeout(800);

  // 7. Set Distance (200 miles)
  const distanceField = page.locator(SEL.dateFilter.distanceField).filter({
    has: page.locator('mat-label').filter({ hasText: /^Distance$/ }),
  }).first();
  await distanceField.locator(SEL.dateFilter.distanceTrigger).click();
  await page.locator(SEL.dateFilter.distanceOption).filter({ hasText: /^\s*200(\s*miles)?\s*$/i }).first().click();
  
  logger.ok(`Filter set: ${targetDate.toLocaleDateString()} | ZIP ${zipCode} | 200 miles`);
}

async function getProjectsOnCurrentPage(page) {
  logger.info('⏳ Waiting for project list to stabilize...');
  await page.waitForSelector('table tbody tr', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(5000); 
  
  let rows = await page.locator('table tbody tr').all();
  
  if (rows.length === 0) {
    logger.info('   Empty list detected. Giving PlanHub 5 more seconds...');
    await page.waitForTimeout(5000);
    rows = await page.locator('table tbody tr').all();
  }

  const projects = [];
  for (const row of rows) {
    try {
      // Ensure row is visible and has data
      if (!(await row.isVisible())) continue;
      
      const cells = await row.locator('td').all();
      if (cells.length < 2) continue;

      const firstCellText = (await cells[0].innerText().catch(() => '')).trim();
      
      // Usually the project name is in the second or third cell
      let name = '';
      for (let i = 1; i < Math.min(cells.length, 4); i++) {
          const text = (await cells[i].innerText().catch(() => '')).trim();
          if (text && !/^lock$/i.test(text) && text.length > 3) {
              name = text.split('\n')[0].trim();
              break;
          }
      }
      
      if (!name) continue;

      const locked = /^lock$/i.test(firstCellText) || /unlock/i.test(firstCellText) || (await row.innerText()).includes('lock');
      projects.push({ name, locked });
    } catch (err) {
      // Skip problematic rows
    }
  }
  
  if (projects.length > 0) {
    logger.info(`📋 Projects on this page: ${projects.map((p, i) => `[${i+1}] ${p.name}`).join(', ')}`);
  }
  
  return projects;
}

function isLockedProjectText(text = '') {
  return /\blocked\b/i.test(text)
    || /unlock this project/i.test(text)
    || /upgrade to unlock/i.test(text)
    || /purchase .*unlock/i.test(text)
    || /to unlock/i.test(text);
}

async function waitWhileFleetPaused(page) {
  while (telemetry.isPaused()) {
    telemetry.setStatus('paused');
    logger.info('Fleet pause is enabled from the panel. Waiting before continuing...');
    await page.waitForTimeout(5000);
  }
}

async function collectCompanyEntries(projectPage) {
  const companyElements = await projectPage.locator(SEL.company.row).all();
  const companyNames = [];
  for (const companyElement of companyElements) {
    const name = await companyElement.innerText().catch(() => '');
    if (!name.trim()) continue;
    companyNames.push(name.trim());
  }
  return companyNames;
}

async function scrapeProject(page, projectInfo) {
  const projectName = typeof projectInfo === 'string' ? projectInfo : projectInfo.name;
  const knownLocked = typeof projectInfo === 'object' && Boolean(projectInfo.locked);

  if (knownLocked) {
    logger.info(`Skipping locked project: ${projectName}`);
    return [];
  }

  logger.step(`Analyzing project: ${projectName}`);
  logger.setContext(projectName);

  const [projectPage] = await Promise.all([
    page.context().waitForEvent('page'),
    page.getByRole('table').getByText(projectName).first().click().then(async () => {
      await page.waitForTimeout(1000);
      await page.getByRole('button', { name: /View Project Details/i }).click({ timeout: 15000 });
    }),
  ]);

  await projectPage.waitForLoadState('domcontentloaded');
  await projectPage.waitForTimeout(3000);

  if (/signin|login|access\.planhub\.com/i.test(projectPage.url())) {
    logger.fail('⚠️  Project tab hit signin — re-authenticating, skipping this project');
    await projectPage.close().catch(() => {});
    await ensureLoggedIn(page);
    return [];
  }

  let fullProjectName = projectName;
  let bidDueDate = '';
  try {
    const headerText = await projectPage.locator('body').innerText();
    if (isLockedProjectText(headerText)) {
      logger.info(`Skipping locked project after opening: ${projectName}`);
      await projectPage.close().catch(() => {});
      return [];
    }
    const nameMatch = headerText.match(/Project Name:\s*([^\n]+)/i);
    if (nameMatch) fullProjectName = nameMatch[1].trim();
    const dateMatch = headerText.match(/Bid Due Date\s*([0-9]{1,2}[\/\-][0-9]{1,2}[\/\-][0-9]{2,4})/i);
    if (dateMatch) bidDueDate = dateMatch[1].replace(/\//g, '-');
  } catch (err) {}

  const safeProjectName = fullProjectName.replace(/[<>:"/\\|?*\x00-\x1F]/g, '').trim().slice(0, 100);
  const projectFolderName = bidDueDate ? `${safeProjectName} (${bidDueDate})` : safeProjectName;
  const projectScreenshotsDir = path.join(SCREENSHOTS_DIR, projectFolderName);
  
  // Create folder if not exists
  if (!fs.existsSync(projectScreenshotsDir)) {
    fs.mkdirSync(projectScreenshotsDir, { recursive: true });
  }

  await projectPage.getByRole('button', { name: 'Subcontractors' }).click();
  await projectPage.waitForTimeout(2500);

  // 2. Detailed Analysis: Compare PlanHub count vs local count
  let totalPages = 1;
  let totalCompaniesHint = 0;
  const paginationText = await projectPage.locator('text=/Page \\d+ of \\d+/').first().innerText().catch(() => '');
  const pageMatch = paginationText.match(/Page \d+ of (\d+)/);
  if (pageMatch) totalPages = parseInt(pageMatch[1]);

  // Try to find total results count (e.g. "1-20 of 154")
  const resultsText = await projectPage.locator('text=/\\d+-\\d+ of \\d+/').first().innerText().catch(() => '');
  const resultsMatch = resultsText.match(/of (\d+)/);
  if (resultsMatch) {
    totalCompaniesHint = parseInt(resultsMatch[1]);
    logger.info(`📊 Project Stats: ${totalCompaniesHint} total companies on PlanHub.`);
  } else {
    logger.info(`📊 Project Stats: ${totalPages} pages of companies.`);
  }

  const currentLocalCount = countScreenshots(projectScreenshotsDir);
  if (totalCompaniesHint > 0 && currentLocalCount >= totalCompaniesHint) {
    logger.ok(`✅ Project "${projectName}" already fully scraped (${currentLocalCount}/${totalCompaniesHint}). Skipping.`);
    await projectPage.close();
    return [];
  }

  const companyData = [];
  for (let subPage = 1; subPage <= totalPages; subPage++) {
    await waitWhileFleetPaused(projectPage);
    logger.step(`📄 Subcontractors page ${subPage}/${totalPages}`);
    
    await projectPage.evaluate(() => {
      const scrollables = document.querySelectorAll('[class*="scroll"], [class*="list"], mat-dialog-content');
      scrollables.forEach(el => { el.scrollTop = el.scrollHeight; });
    });
    await projectPage.waitForTimeout(1500);
    
    const companiesOnThisPage = await collectCompanyEntries(projectPage);
    
    for (const companyName of companiesOnThisPage) {
      const dedupKeyShort = `${projectName}|||${companyName}`;
      const dedupKeyFull = `${fullProjectName}|||${companyName}`;
      
      const alreadyScraped = PREVIOUS_SCRAPES.has(dedupKeyShort) || PREVIOUS_SCRAPES.has(dedupKeyFull);
      
      // Double check if screenshot exists in current run folder
      const safeFileName = companyName.replace(/[^a-z0-9]/gi, '_').toLowerCase().slice(0, 50);
      const localScreenshotExists = fs.existsSync(`${projectScreenshotsDir}/${safeFileName}.png`);
      
      // Triple check: OCR Pipeline 'done' folder
      const ocrDone = isCompanyInOcrDone(projectName, companyName) || isCompanyInOcrDone(fullProjectName, companyName);

      if (alreadyScraped || localScreenshotExists || ocrDone) {
          if (localScreenshotExists || ocrDone) {
              // Ensure it's in dedup for next time
              saveToDedup(projectName, companyName);
              saveToDedup(fullProjectName, companyName);
          }
          logger.ok(`✓ ${companyName} (Already done)`);
          continue;
      }

      try {
        const [companyPage] = await Promise.all([
          page.context().waitForEvent('page', { timeout: 15000 }),
          projectPage.getByText(companyName).first().click({ modifiers: ['ControlOrMeta'] }),
        ]);

        await companyPage.waitForLoadState('domcontentloaded');
        await companyPage.waitForTimeout(7000);

        const safeFileName = companyName.replace(/[^a-z0-9]/gi, '_').toLowerCase().slice(0, 50);
        const screenshotPath = `${projectScreenshotsDir}/${safeFileName}.png`;
        
        await companyPage.screenshot({ path: screenshotPath, fullPage: true });
        
        logger.setContext(`🏢 Scraping: ${companyName}`);
        
        const bodyText = await companyPage.locator('body').innerText().catch(() => '');
        const record = {
          projectFolder: projectScreenshotsDir,
          project: fullProjectName,
          bidDate: bidDueDate,
          company: companyName,
          email: bodyText.match(/[\w.+-]+@[\w-]+\.[\w.-]+/)?.[0] || null,
          phone: bodyText.match(/(\+?\d[\d\s().-]{9,})/)?.[0] || null,
          website: null,
          screenshot: screenshotPath,
          sourceFile: 'scraper.js',
          scraped_at: Date.now(),
          isNew: true,
        };
        companyData.push(record);
        saveToDedup(projectName, companyName); // Real-time save
        
        const currentTotal = (global.scrapedTodayCount || 0) + 1;
        global.scrapedTodayCount = currentTotal;
        telemetry.setCompaniesToday(currentTotal);
        
        await companyPage.close();
        logger.ok(`✓ ${companyName}`);
        telemetry.reportCompanies([record]);
      } catch (err) {
        logger.fail(`Failed ${companyName}: ${err.message}`);
      }
    }
    
    if (subPage < totalPages) {
      const goToPageInput = projectPage.locator('input[type="number"]').first();
      await goToPageInput.fill(String(subPage + 1));
      await goToPageInput.press('Enter');
      await projectPage.waitForTimeout(3000);
    }
  }

  await projectPage.close();
  logger.setContext('Idle');
  return companyData;
}

async function paginate(page, nextPageNumber) {
  let success = false;

  const pageLabel = await page.locator('text=/Page \\d+ of \\d+/').first().innerText().catch(() => '');
  const pageMatch = pageLabel.match(/Page\s+(\d+)\s+of\s+(\d+)/i);
  if (pageMatch) {
    const totalPages = parseInt(pageMatch[2], 10);
    if (nextPageNumber > totalPages) {
      logger.info(`Project list has only ${totalPages} page(s); stopping pagination`);
      return false;
    }
  }

  // Try numeric page input
  try {
    const goToPageInput = page.locator('input[type="number"]').first();
    if (await goToPageInput.isVisible().catch(() => false)) {
      await goToPageInput.click();
      await goToPageInput.fill(String(nextPageNumber));
      await goToPageInput.press('Enter');
      await page.waitForTimeout(2500);
      success = true;
      logger.info(`Moving to project list page ${nextPageNumber}`);
    }
  } catch (err) {}

  if (!success) {
    try {
      const nextBtn = page.getByRole('button', { name: /next/i });
      if (await nextBtn.isVisible().catch(() => false) && await nextBtn.isEnabled()) {
        await nextBtn.click();
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(2000);
        success = true;
      }
    } catch (err) {}
  }

  if (!success) {
    try {
      const clicked = await page.evaluate(() => {
        const buttons = [...document.querySelectorAll('button')];
        const nextBtn = buttons.find(b =>
          !b.disabled && (
            /next/i.test((b.getAttribute('aria-label') || '')) ||
            /next/i.test((b.textContent || '')) ||
            (b.textContent || '').includes('arrow_forward_ios')
          )
        );
        if (!nextBtn) return false;
        nextBtn.scrollIntoView({ block: 'center', inline: 'center' });
        nextBtn.click();
        return true;
      });
      if (clicked) {
        await page.waitForTimeout(2500);
        success = true;
      }
    } catch (err) {}
  }

  return success;
}

async function main() {
  try {
    logger.step('PlanHub Scraper Pro');
    
    // 1. Verify VPN Connectivity
    logger.info('Checking VPN Status...');
    if (!ensureVpn()) {
      logger.fail('FATAL: VPN is required but disconnected. Aborting run.');
      if (telemetry.isEnabled()) {
         await telemetry.reportError('VPN Disconnected');
      }
      return;
    }

    logger.info('Launching Browser...');
    const browser = await chromium.launch({ headless: false, slowMo: 50 });
    const sessionPath = 'session.json';
    const contextOpts = { viewport: null }; // Remove fixed viewport for smaller screens
    if (fs.existsSync(sessionPath)) contextOpts.storageState = sessionPath;

    const context = await browser.newContext(contextOpts);
    const page = await context.newPage();
    let stopHeartbeat = () => {};

    try {
      logger.info('Checking Session...');
      if (!fs.existsSync(sessionPath)) {
        await login(page);
        await context.storageState({ path: sessionPath });
      } else {
        await page.goto('https://supplier.planhub.com/project/list');
        await ensureLoggedIn(page);
      }

    // Initialize Telemetry
    stopHeartbeat = telemetry.startHeartbeat();
    telemetry.setStatus('running');

    // Load Resume Progress or Start Offset
    const resumeOffset = loadProgress();
    const configOffset = parseInt(process.env.START_DATE_OFFSET || '4', 10);
    let dayOffset = resumeOffset !== null ? resumeOffset : configOffset;

    const allData = [];
    const quarantine = [];
    global.scrapedTodayCount = 0; // Initialize global counter

    // Main Work Loop
    while (RUN_FOREVER || (Date.now() - START_TIME < MAX_RUNTIME_MS)) {
      try {
        let dayHasErrors = false;
        
        // 1. Select the Date Filter (now includes ZIP fetching and pasting)
        logger.step(`📅 Date Target: today+${dayOffset}`);
        try {
          await setDateFilter(page, dayOffset);
        } catch (err) {
          logger.fail(`❌ Filter set failed: ${err.message}`);
          dayHasErrors = true;
        }
        
        if (!dayHasErrors) {
          // 2. Analyze date range totals
          logger.info('⏳ Analyzing date roadmap...');
          await page.waitForTimeout(3000); // Give PlanHub a moment to update results
          
          let totalPages = 1;
          let totalProjects = 'unknown';
          
          const paginationText = await page.locator('text=/Page \\d+ of \\d+/').first().innerText().catch(() => '');
          const totalPagesMatch = paginationText.match(/Page \d+ of (\d+)/);
          if (totalPagesMatch) totalPages = parseInt(totalPagesMatch[1]);

          const resultsText = await page.locator('text=/\\d+-\\d+ of \\d+/').first().innerText().catch(() => '');
          const resultsMatch = resultsText.match(/of (\d+)/);
          if (resultsMatch) totalProjects = resultsMatch[1];

          logger.info(`📊 ROADMAP for today+${dayOffset}: Found ${totalProjects} projects across ${totalPages} page(s).`);

          if (totalProjects === '0' || totalProjects === 0) {
            logger.ok(`📅 Date today+${dayOffset} is empty. Skipping to next date...`);
            saveProgress(dayOffset);
            dayOffset++;
            continue; // Jump to next date immediately
          }

          // 3. Scrape Projects
          let pageNum = 1;
          let dayActuallyEmpty = false;
          do {
            logger.step(`📄 Project List Page ${pageNum}`);
            const projects = await getProjectsOnCurrentPage(page);
            
            if (projects.length === 0) {
              logger.info(`ℹ️  No projects found on page ${pageNum}.`);
              if (pageNum === 1) {
                dayActuallyEmpty = true;
                break;
              }
            }

            for (const projectInfo of projects) {
              const projectName = typeof projectInfo === 'string' ? projectInfo : projectInfo.name;
              const isLocked = typeof projectInfo === 'object' && !!projectInfo.locked;

              if (isLocked) {
                logger.info(`Skipping locked project: ${projectName}`);
                continue;
              }

              // Check if project is already fully done (Early skip)
              const existingFolder = findProjectFolder(projectName);
              const localCount = countScreenshots(existingFolder);
              
              if (localCount >= 1) {
                  logger.ok(`⏭️  Skipping project (Already scraped): ${projectName} (${localCount} screenshots)`);
                  continue; // Move to next project immediately
              }

              try {
                const data = await scrapeProject(page, projectName);
                allData.push(...data);
                fs.writeFileSync(`${OUTPUT_DIR}/data.json`, JSON.stringify(allData, null, 2));
              } catch (err) {
                logger.fail(`❌ Failed: ${projectName} - ${err.message}`);
                dayHasErrors = true; 
                quarantine.push({ project: projectName, error: err.message, dateRange: `today+${dayOffset}` });
                fs.writeFileSync(`${OUTPUT_DIR}/quarantine.json`, JSON.stringify(quarantine, null, 2));
              }
            }
            pageNum++;
          } while (await paginate(page, pageNum) && !dayActuallyEmpty);

          if (dayActuallyEmpty) {
            logger.ok(`📅 Date today+${dayOffset} had no projects. Skipping...`);
            saveProgress(dayOffset);
            dayOffset++;
            continue;
          }
        }

        // ONLY save progress if the ENTIRE day was processed without critical failures
        if (!dayHasErrors) {
          saveProgress(dayOffset);
          dayOffset++;
          logger.info('🔄 Day complete. Advancing...');
        } else {
          logger.fail(`⚠️ Skipping progress save for day +${dayOffset} due to errors. It will be retried next run.`);
          await page.waitForTimeout(10000);
        }
      } catch (loopErr) {
        logger.fail(`⚠️ Unexpected Loop Error on day +${dayOffset}: ${loopErr.message}`);
        await page.waitForTimeout(10000);
      }
    }

    logger.ok('🏁 Run complete.');
    await telemetry.reportRunComplete({ companiesScraped: allData.length, quarantined: quarantine.length });

    } finally {
      if (telemetry.isEnabled()) {
        await telemetry.reportStopping();
      }
      stopHeartbeat();
      await browser.close().catch(() => {});
    }
  } catch (globalErr) {
    logger.fail(`CRITICAL STARTUP ERROR: ${globalErr.message}`);
    console.error(globalErr);
  }
}

process.on('SIGINT', async () => {
  logger.info('\n🛑 Stopping... notifying dashboard');
  await telemetry.reportStopping().catch(() => {});
  process.exit(0);
});

main();