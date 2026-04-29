import { execSync } from 'child_process';
import { logger } from './logger.js';
import fs from 'fs';

const PIACTL_PATH = '"C:\\Program Files\\Private Internet Access\\piactl.exe"';

export function checkVpn() {
  try {
    // Try absolute path first, then fallback to just 'piactl'
    const cmd = fs.existsSync('C:\\Program Files\\Private Internet Access\\piactl.exe') ? PIACTL_PATH : 'piactl';
    const status = execSync(`${cmd} get connectionstate`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    
    if (status === 'Connected') {
      logger.ok('VPN Status: Connected (PIA)');
      return true;
    } else {
      logger.fail(`VPN Status: ${status || 'Disconnected'}`);
      return false;
    }
  } catch (e) {
    // Fallback: check if a VPN network interface is UP
    try {
      const interfaces = execSync('powershell -NoProfile -Command "Get-NetAdapter | Where-Object { $_.Status -eq \'Up\' -and ($_.InterfaceDescription -like \'*Private Internet Access*\' -or $_.InterfaceDescription -like \'*WireGuard*\') }"').toString();
      if (interfaces.trim()) {
        logger.ok('VPN Status: Connected (Detected via Network Adapter)');
        return true;
      }
    } catch (err) { }
    
    logger.fail('VPN Status: DISCONNECTED');
    return false;
  }
}

export function ensureVpn() {
  if (!checkVpn()) {
    logger.step('Attempting to connect VPN...');
    try {
      const cmd = fs.existsSync('C:\\Program Files\\Private Internet Access\\piactl.exe') ? PIACTL_PATH : 'piactl';
      execSync(`${cmd} connect`);
      // Wait for connection
      for (let i = 0; i < 15; i++) {
        if (checkVpn()) return true;
        execSync('powershell -NoProfile -Command "Start-Sleep -Seconds 2"');
      }
    } catch (e) {
      logger.fail('Failed to trigger VPN connection.');
    }
    return false;
  }
  return true;
}
