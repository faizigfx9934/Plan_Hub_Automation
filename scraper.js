// PlanHub Scraper - Production Ready
// Based on recorded flow from codegen
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import 'dotenv/config';
import { SEL } from './selectors.js';
import { logger } from './logger.js';
import * as telemetry from './telemetry.js';

// Runtime limit: 8.5 hours (in milliseconds)
const MAX_RUNTIME_MS = 8.5 * 60 * 60 * 1000;
const START_TIME = Date.now();

const OUTPUT_DIR = `runs/${new Date().toISOString().split('T')[0]}`;
fs.mkdirSync(`${OUTPUT_DIR}`, { recursive: true });

// Master screenshots folder - all screenshots go here regardless of date
const SCREENSHOTS_DIR = 'screenshots';
fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

// Load all previously scraped companies for deduplication
function loadPreviousData() {
  const previousData = new Set();
  const runsDir = 'runs';
  
  if (!fs.existsSync(runsDir)) return previousData;
  
  const runFolders = fs.readdirSync(runsDir);
  for (const folder of runFolders) {
    const jsonPath = `${runsDir}/${folder}/data.json`;
    if (fs.existsSync(jsonPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        data.forEach(entry => {
          // Create unique key: project + company name
          const key = `${entry.project}|||${entry.company}`;
          previousData.add(key);
        });
      } catch (err) {
        // Skip malformed JSON files
      }
    }
  }
  
  logger.info(`Loaded ${previousData.size} previously scraped companies for dedup`);
  return previousData;
}

const PREVIOUS_SCRAPES = loadPreviousData();

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

// Checks if the page got redirected to signin (session died mid-run).
// If so, re-logs in, re-saves the session, and navigates back to where we were.
// Returns true if a re-login happened, false if session was still valid.
async function ensureLoggedIn(page, returnUrl = 'https://supplier.planhub.com/project/list') {
  const url = page.url();
  const needsLogin = /signin|login|access\.planhub\.com/i.test(url);
  if (!needsLogin) return false;

  logger.fail('⚠️  Session expired mid-run — re-authenticating');
  await login(page);
  await page.context().storageState({ path: 'session.json' });
  logger.ok('Session refreshed and saved');

  if (returnUrl) {
    await page.goto(returnUrl, { timeout: 60000, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
  }
  return true;
}

async function setDateFilter(page, dayOffset = 0) {
  logger.step(`Setting date filter (today+${dayOffset} → today+${dayOffset + 7})`);
  await page.goto('https://supplier.planhub.com/project/list', { timeout: 60000, waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  // If session died, re-login and come back to project/list before continuing
  await ensureLoggedIn(page);

  await page.waitForSelector('text=/search/i', { timeout: 30000 });
  await page.waitForTimeout(2000);

  await page.getByLabel('Search (2)').getByRole('button').filter({ hasText: /^$/ }).click();
  await page.waitForTimeout(1000);

  for (let i = 0; i < 8; i++) {
    const customTab = page.getByText('Custom', { exact: true });
    if (await customTab.isVisible().catch(() => false)) break;
    await page.locator(SEL.dateFilter.paginateArrow).click().catch(() => {});
    await page.waitForTimeout(300);
  }

  await page.getByText('Custom').click();
  await page.waitForTimeout(1500);

  const today = new Date();
  const startDate = new Date(today);
  startDate.setDate(today.getDate() + dayOffset);

  const endDate = new Date(today);
  endDate.setDate(today.getDate() + dayOffset + 7);

  const formatMonthDay = (d) =>
    d.toLocaleString('en-US', { month: 'long', day: 'numeric' });

  // Click calendar day by aria-label. Use native DOM scroll + force click because
  // Material's cdk-overlay calendar reports elements as "outside viewport" even
  // when visible, making normal Playwright clicks time out.
  const clickCalendarDay = async (d) => {
    const ariaLabel = d.toLocaleString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    const btn = page.locator(`button[aria-label="${ariaLabel}"]`).first();
    await btn.waitFor({ state: 'attached', timeout: 10000 });
    // Dispatch click via DOM — bypasses Playwright's viewport/actionability checks
    // which fail on Material cdk-overlay calendars.
    await btn.evaluate(el => {
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.click();
    });
  };

  await clickCalendarDay(startDate);
  await page.waitForTimeout(500);
  await clickCalendarDay(endDate);
  await page.waitForTimeout(500);

  await page.keyboard.press('Escape');
  await page.waitForTimeout(2000);

  logger.ok(`Filter set: ${formatMonthDay(startDate)} → ${formatMonthDay(endDate)}`);
}

async function getProjectsOnCurrentPage(page) {
  await page.waitForSelector('table tr', { timeout: 10000 });
  const rows = await page.locator('table tbody tr').all();
  const projects = [];
  for (const row of rows) {
    const name = await row.innerText().catch(() => '');
    if (name.trim()) projects.push(name.trim().split('\n')[0]);
  }
  return projects;
}

async function scrapeProject(page, projectName) {
  logger.step(`Scraping project: ${projectName}`);
  telemetry.setCurrentProject(projectName);

  const [projectPage] = await Promise.all([
    page.context().waitForEvent('page'),
    page.getByRole('table').getByText(projectName).first().click().then(async () => {
      await page.getByRole('button', { name: 'View Project Details' }).click();
    }),
  ]);

  await projectPage.waitForLoadState('domcontentloaded');
  await projectPage.waitForTimeout(3000);

  // If the project tab got kicked to signin, recover on main page and skip this project.
  // Next iteration of the outer loop will proceed with the refreshed session.
  if (/signin|login|access\.planhub\.com/i.test(projectPage.url())) {
    logger.fail('⚠️  Project tab hit signin — re-authenticating, skipping this project');
    await projectPage.close().catch(() => {});
    await ensureLoggedIn(page);
    return [];
  }

  // Extract full project name and bid due date from the project page
  let fullProjectName = projectName;
  let bidDueDate = '';
  try {
    const headerText = await projectPage.locator('body').innerText();
    const nameMatch = headerText.match(/Project Name:\s*([^\n]+)/i);
    if (nameMatch) fullProjectName = nameMatch[1].trim();
    const dateMatch = headerText.match(/Bid Due Date\s*([0-9]{1,2}[\/\-][0-9]{1,2}[\/\-][0-9]{2,4})/i);
    if (dateMatch) bidDueDate = dateMatch[1].replace(/\//g, '-');
  } catch (err) {
    logger.fail(`Could not extract project header: ${err.message}`);
  }

  // Clean folder name: strip only Windows-illegal chars, collapse whitespace
  const safeProjectName = fullProjectName
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  const projectFolderName = bidDueDate ? `${safeProjectName} (${bidDueDate})` : safeProjectName;
  const projectScreenshotsDir = `${SCREENSHOTS_DIR}/${projectFolderName}`;
  fs.mkdirSync(projectScreenshotsDir, { recursive: true });
  logger.info(`📁 Project folder: ${projectScreenshotsDir}`);

  await projectPage.getByRole('button', { name: 'Subcontractors' }).click();
  await projectPage.waitForTimeout(2500);

  // Find total pages from "Page X of Y" text
  let totalPages = 1;
  const pageText = await projectPage.locator('text=/Page \\d+ of \\d+/').first().innerText().catch(() => '');
  const pageMatch = pageText.match(/Page \d+ of (\d+)/);
  if (pageMatch) {
    totalPages = parseInt(pageMatch[1]);
    logger.info(`Found ${totalPages} subcontractor pages`);
  } else {
    logger.info(`Single subcontractor page detected`);
  }

  const companyData = [];
  let newCount = 0;
  let skippedCount = 0;
  let totalCompaniesFound = 0;
  
  // Process each page COMPLETELY before moving to next page
  for (let subPage = 1; subPage <= totalPages; subPage++) {
    logger.step(`📄 Processing subcontractor page ${subPage}/${totalPages}`);
    
    // Scroll internal containers to load company list
    await projectPage.evaluate(() => {
      const scrollables = document.querySelectorAll('[class*="scroll"], [class*="list"], .mat-dialog-content, mat-dialog-content, [class*="container"]');
      scrollables.forEach(el => {
        if (el.scrollHeight > el.clientHeight) {
          el.scrollTop = el.scrollHeight;
        }
      });
    });
    await projectPage.waitForTimeout(1500);
    
    // Collect companies on THIS page only
    const companiesOnThisPage = [];
    const companyElements = await projectPage.locator('[class*="company"], [class*="subcontractor"] a').all();
    for (const el of companyElements) {
      const name = await el.innerText().catch(() => '');
      if (!name.trim()) continue;
      companiesOnThisPage.push(name.trim());
    }
    
    logger.info(`Found ${companiesOnThisPage.length} companies on page ${subPage}`);
    totalCompaniesFound += companiesOnThisPage.length;
    
    // Open each company on this page, screenshot, close, move to next company
    for (const companyName of companiesOnThisPage) {
      try {
        // Check if already scraped
        const dedupKey = `${projectName}|||${companyName}`;
        if (PREVIOUS_SCRAPES.has(dedupKey)) {
          logger.info(`⏭️  Skipping ${companyName} (already scraped)`);
          skippedCount++;
          continue;
        }

        logger.info(`Opening ${companyName}...`);

        const [companyPage] = await Promise.all([
          page.context().waitForEvent('page', { timeout: 15000 }),
          projectPage.getByText(companyName).first().click({ modifiers: ['ControlOrMeta'] }),
        ]);

        // Wait for page to load
        await companyPage.waitForLoadState('domcontentloaded');
        await companyPage.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
        await companyPage.waitForTimeout(1500);

        // ═══════════════════════════════════════════════════════════════
        // HIGH-QUALITY SCREENSHOT FOR OCR
        // ═══════════════════════════════════════════════════════════════
        const safeFileName = companyName.replace(/[^a-z0-9]/gi, '_').toLowerCase();
        const timestamp = new Date().toISOString().split('T')[0];
        const screenshotPath = `${projectScreenshotsDir}/${safeFileName}_${timestamp}.png`;
        
        await companyPage.screenshot({ 
          path: screenshotPath, 
          fullPage: true,
          type: 'png',              // Force PNG (lossless compression)
          scale: 'device',          // Use device pixel ratio (2x on retina = 2x sharper text)
          animations: 'disabled',   // Disable animations for cleaner capture
        });
        
        logger.info(`📸 Screenshot saved (high-quality PNG for OCR)`);

        // Extract contact info
        const bodyText = await companyPage.locator('body').innerText().catch(() => '');
        const email = bodyText.match(/[\w.+-]+@[\w-]+\.[\w.-]+/)?.[0] || null;
        const phone = bodyText.match(/(\+?\d[\d\s().-]{9,})/)?.[0] || null;
        const website = bodyText.match(/https?:\/\/[^\s]+/)?.[0] || null;

        companyData.push({
          project: projectName,
          company: companyName,
          email,
          phone,
          website,
          screenshot: screenshotPath,
          scrapedAt: new Date().toISOString(),
          isNew: true,
        });
        
        newCount++;
        telemetry.incCompanies(1);
        await companyPage.close();
        logger.ok(`✓ ${companyName} - done`);

      } catch (err) {
        logger.fail(`Failed ${companyName}: ${err.message}`);
      }
    }
    
    logger.ok(`✅ Page ${subPage}/${totalPages} complete`);
    
    // If this was the last page, we're done
    if (subPage >= totalPages) {
      logger.info(`All ${totalPages} pages processed`);
      break;
    }
    
    // Navigate to next page using "Go to page" input
    let success = false;
    try {
      const goToPageInput = projectPage.locator('input[type="number"]').first();
      if (await goToPageInput.isVisible().catch(() => false)) {
        await goToPageInput.click();
        await goToPageInput.fill(String(subPage + 1));
        await goToPageInput.press('Enter');
        await projectPage.waitForTimeout(2500);
        success = true;
        logger.info(`➡️ Moving to page ${subPage + 1}`);
      }
    } catch (err) {
      logger.fail(`Go to page input failed: ${err.message}`);
    }
    
    // Fallback: JS click on arrow
    if (!success) {
      try {
        const clicked = await projectPage.evaluate(() => {
          const buttons = [...document.querySelectorAll('button')];
          const nextBtn = buttons.find(b => 
            b.textContent.includes('arrow_forward_ios') && !b.disabled
          );
          if (nextBtn) {
            nextBtn.scrollIntoView();
            nextBtn.click();
            return true;
          }
          return false;
        });
        if (clicked) {
          await projectPage.waitForTimeout(2500);
          success = true;
          logger.info(`➡️ Clicked next via JS fallback`);
        }
      } catch (err) {
        logger.fail(`JS click failed: ${err.message}`);
      }
    }
    
    if (!success) {
      logger.fail(`Could not navigate to page ${subPage + 1}, stopping`);
      break;
    }
  }

  logger.info(`📊 Total: ${totalCompaniesFound} companies across ${totalPages} pages`);

  await projectPage.close();
  
  logger.info(`📊 ${projectName} summary: ${newCount} new, ${skippedCount} skipped`);
  return companyData;
}

async function paginate(page) {
  const nextBtn = page.getByRole('button', { name: /next/i });
  if (await nextBtn.isVisible().catch(() => false) && await nextBtn.isEnabled()) {
    await nextBtn.click();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);
    return true;
  }
  return false;
}

async function main() {
  // Dropped slowMo from 500 → 50. slowMo adds that delay to EVERY playwright action
  // (clicks, fills, waits) which was the main reason company iteration felt slow.
  const browser = await chromium.launch({ headless: false, slowMo: 50 });

  const sessionPath = 'session.json';
  const contextOpts = { viewport: { width: 1920, height: 1080 } };
  if (fs.existsSync(sessionPath)) {
    contextOpts.storageState = sessionPath;
    logger.info('Reusing saved session');
  }

  const context = await browser.newContext(contextOpts);
  const page = await context.newPage();

  // Declared outside try so finally can always clean it up
  let stopHeartbeat = () => {};

  try {
    if (!fs.existsSync(sessionPath)) {
      await login(page);
      await context.storageState({ path: sessionPath });
    } else {
      await page.goto('https://supplier.planhub.com/project/list');
      if (page.url().includes('signin')) {
        logger.info('Session expired, re-logging in');
        await login(page);
        await context.storageState({ path: sessionPath });
      }
    }

    await setDateFilter(page, 0); // Start with today → today+7

    const allData = [];
    const quarantine = [];
    let pageNum = 1;
    let dayOffset = 0; // Tracks how many days forward we've shifted
    let totalRanges = 0;

    // Start telemetry heartbeat loop (no-op if TELEMETRY_URL / INGEST_TOKEN missing)
    stopHeartbeat = telemetry.startHeartbeat();

    // Continuous loop: keep shifting date window forward until time limit
    while (Date.now() - START_TIME < MAX_RUNTIME_MS) {
      totalRanges++;
      const elapsed = ((Date.now() - START_TIME) / 1000 / 60).toFixed(1);
      logger.step(`📅 Date range #${totalRanges} (${elapsed} min elapsed)`);
      
      // Reset page counter for this date range
      pageNum = 1;

      do {
        // Check time before processing each page
        if (Date.now() - START_TIME >= MAX_RUNTIME_MS) {
          logger.info('⏰ Time limit reached, stopping gracefully...');
          break;
        }

        logger.step(`Processing page ${pageNum}`);
        const projects = await getProjectsOnCurrentPage(page);
        logger.info(`${projects.length} projects on page ${pageNum}`);

        for (const projectName of projects) {
          // Check time before each project
          if (Date.now() - START_TIME >= MAX_RUNTIME_MS) {
            logger.info('⏰ Time limit reached, stopping gracefully...');
            break;
          }

          try {
            const data = await scrapeProject(page, projectName);
            allData.push(...data);
            fs.writeFileSync(`${OUTPUT_DIR}/data.json`, JSON.stringify(allData, null, 2));
            // Upload this project's companies to telemetry backend (best-effort)
            telemetry.reportCompanies(data);
          } catch (err) {
            // One bad project must never kill an 8.5hr run.
            // Quarantine it, take a diagnostic screenshot, move on.
            logger.fail(`❌ Project failed: ${projectName} — ${err.message}`);
            const entry = {
              project: projectName,
              error: err.message,
              stack: err.stack,
              failedAt: new Date().toISOString(),
              dateRange: `today+${dayOffset} → today+${dayOffset + 7}`,
            };
            quarantine.push(entry);
            fs.writeFileSync(`${OUTPUT_DIR}/quarantine.json`, JSON.stringify(quarantine, null, 2));
            telemetry.reportQuarantine(entry);
            // Diagnostic screenshot of whatever state the main page is in
            await page.screenshot({
              path: `${OUTPUT_DIR}/quarantine-${Date.now()}.png`,
              fullPage: true,
            }).catch(() => {});
            // Make sure we're back on project/list with a valid session before next iteration
            await page.goto('https://supplier.planhub.com/project/list', {
              timeout: 60000,
              waitUntil: 'domcontentloaded',
            }).catch(() => {});
            await ensureLoggedIn(page);
            await page.waitForTimeout(2000);
          }
        }

        pageNum++;
      } while (await paginate(page) && Date.now() - START_TIME < MAX_RUNTIME_MS);

      // After completing this date range, shift forward by 1 day
      dayOffset++;
      logger.info(`🔄 Shifting date window forward to day +${dayOffset}...`);

      // Setting the date filter can fail (PlanHub DOM quirks). Don't let that kill the run —
      // retry once, and if it still fails, skip this day and try the next.
      try {
        await setDateFilter(page, dayOffset);
      } catch (err) {
        logger.fail(`⚠️  setDateFilter failed for day +${dayOffset}: ${err.message} — retrying once`);
        await page.waitForTimeout(3000);
        try {
          await setDateFilter(page, dayOffset);
        } catch (err2) {
          logger.fail(`❌ setDateFilter failed twice for day +${dayOffset}, skipping this day`);
          quarantine.push({
            project: '(date-filter)',
            error: err2.message,
            failedAt: new Date().toISOString(),
            dateRange: `today+${dayOffset} → today+${dayOffset + 7}`,
          });
          fs.writeFileSync(`${OUTPUT_DIR}/quarantine.json`, JSON.stringify(quarantine, null, 2));
          continue;
        }
      }

      // Small pause between date ranges
      await page.waitForTimeout(3000);
    }

    const csv = [
      'project,company,email,phone,website,screenshot',
      ...allData.map(d =>
        [d.project, d.company, d.email, d.phone, d.website, d.screenshot]
          .map(v => `"${(v || '').replace(/"/g, '""')}"`)
          .join(',')
      ),
    ].join('\n');
    fs.writeFileSync(`${OUTPUT_DIR}/data.csv`, csv);
    
    // Write new-companies-only CSV (filtered)
    const newCompanies = allData.filter(d => d.isNew);
    if (newCompanies.length > 0) {
      const newCsv = [
        'project,company,email,phone,website,screenshot',
        ...newCompanies.map(d =>
          [d.project, d.company, d.email, d.phone, d.website, d.screenshot]
            .map(v => `"${(v || '').replace(/"/g, '""')}"`)
            .join(',')
        ),
      ].join('\n');
      fs.writeFileSync(`${OUTPUT_DIR}/new-companies.csv`, newCsv);
    }

    logger.ok(`DONE — Processed ${totalRanges} date ranges in ${((Date.now() - START_TIME) / 1000 / 60 / 60).toFixed(2)} hours`);
    logger.ok(`Total: ${allData.length} companies (${newCompanies.length} new)`);
    if (quarantine.length > 0) {
      logger.fail(`⚠️  ${quarantine.length} project(s) quarantined — see ${OUTPUT_DIR}/quarantine.json`);
    } else {
      logger.ok(`✓ Zero failed projects`);
    }
    logger.info(`Output: ${OUTPUT_DIR}/`);
    logger.info(`📄 data.csv = all companies | new-companies.csv = only new ones`);

    // Final run summary to telemetry backend
    await telemetry.reportRunComplete({
      companiesScraped: allData.length,
      newCompanies: newCompanies.length,
      dateRanges: totalRanges,
      quarantined: quarantine.length,
    });
  } catch (err) {
    logger.fail(`Fatal error: ${err.message}`);
    await page.screenshot({ path: `${OUTPUT_DIR}/fatal-error.png`, fullPage: true });
    telemetry.setStatus('error');
  } finally {
    stopHeartbeat();
    await browser.close();
  }
}

main();