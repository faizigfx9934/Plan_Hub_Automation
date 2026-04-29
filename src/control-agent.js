import { spawn } from 'child_process';
import 'dotenv/config';
import path from 'path';
import fs from 'fs';

const API_BASE = 'https://planhub-telemetry.itscyper987.workers.dev';
const LAPTOP_ID = process.env.LAPTOP_ID || 'Unknown';
const TOKEN = process.env.INGEST_TOKEN;

let currentProcess = null;
let lastCommandId = 0;

async function fetchWithAuth(url, options = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000); // 60s timeout
  try {
    return await fetch(url, {
      ...options,
      signal: ctrl.signal,
      headers: {
        ...options.headers,
        'Authorization': `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      }
    });
  } finally {
    clearTimeout(timer);
  }
}

async function checkCommands() {
  try {
    const url = `${API_BASE}/api/laptop/${LAPTOP_ID}/command`;
    const res = await fetchWithAuth(url);
    if (!res.ok) {
      console.log(`[AGENT] Poll failed: ${res.status} ${res.statusText}`);
      return;
    }
    
    const data = await res.json();
    const cmd = data.command;
    
    if (cmd && cmd.id > lastCommandId) {
      console.log(`[AGENT] New command found: ${cmd.command} (ID: ${cmd.id})`);
      await executeCommand(cmd);
      lastCommandId = cmd.id;
    }
  } catch (e) {
    if (e.name === 'AbortError') {
       console.error('[AGENT] Polling timed out (Network lag).');
    } else {
       console.error('[AGENT] Polling error:', e.message);
    }
  }
}

async function executeCommand(cmd) {
  const type = cmd.command.toUpperCase();
  console.log(`[AGENT] Executing ${type}...`);
  
  if (type === 'STOP' || type === 'RESTART') {
    console.log('[AGENT] Executing Force Stop (Scraper Only)...');
    
    try {
      const { execSync } = await import('child_process');
      // Only kill node processes that have 'scraper.js' in their command line
      const cmdKill = `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name = 'node.exe'\\" | Where-Object { $_.CommandLine -like '*scraper.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"`;
      execSync(cmdKill);
      console.log('[AGENT] Scraper processes terminated.');
    } catch (e) {
      console.log('[AGENT] No active scraper processes found to stop.');
    }
    
    currentProcess = null;
  }
  
  if (type === 'START' || type === 'RESTART') {
    if (!(await isScraperRunning())) {
      console.log('[AGENT] Triggering run-scraper.bat in NEW WINDOW...');
      // Use 'start' to launch in a separate terminal window
      currentProcess = spawn('cmd.exe', ['/c', 'start', '"PlanHub Scraper"', 'run-scraper.bat'], {
        shell: true,
        env: { ...process.env, AGENT_MODE: 'true' }
      });
      
      currentProcess.on('exit', (code) => {
        console.log(`[AGENT] Scraper launcher (start command) completed.`);
        currentProcess = null;
      });
    } else {
      console.log('[AGENT] Scraper is already running.');
    }
  }
  
  console.log('[AGENT] Acknowledging command completion to cloud...');
  await fetchWithAuth(`${API_BASE}/api/laptop/${LAPTOP_ID}/command/ack`, {
    method: 'POST',
    body: JSON.stringify({ id: cmd.id })
  });
}

async function isScraperRunning() {
  if (currentProcess) return true;
  try {
    const { execSync } = await import('child_process');
    // Using CimInstance for modern Windows compatibility
    const output = execSync('powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name = \'node.exe\'\\" | Select-Object -ExpandProperty CommandLine"').toString();
    return output.includes('scraper.js');
  } catch (e) {
    return false;
  }
}

async function sendHeartbeat() {
  const running = await isScraperRunning();
  if (running) {
    // If scraper is running, let IT handle the heartbeats and project status.
    // This prevents the "Idle" glitch on the dashboard.
    return;
  }
  
  try {
    await fetchWithAuth(`${API_BASE}/api/heartbeat`, {
      method: 'POST',
      body: JSON.stringify({
        laptop_id: LAPTOP_ID,
        status: 'idle',
        state: process.env.STATE || 'Unknown',
        current_project: 'Idle / Ready'
      })
    });
  } catch (e) {
    if (e.name !== 'AbortError') {
      console.error('[AGENT] Heartbeat error:', e.message);
    }
  }
}

console.log('========================================');
console.log(`[AGENT] PlanHub Control Agent Started`);
console.log(`[AGENT] Laptop ID: ${LAPTOP_ID}`);
console.log(`[AGENT] State: ${process.env.STATE || 'CA'}`);
console.log(`[AGENT] Token: ${TOKEN ? 'LOADED' : 'MISSING!'}`);
console.log('========================================');

sendHeartbeat();
checkCommands();

setInterval(sendHeartbeat, 5000); // 5s heartbeat
setInterval(checkCommands, 3000); // 3s command poll

process.on('SIGINT', () => {
  if (currentProcess) currentProcess.kill();
  process.exit();
});
