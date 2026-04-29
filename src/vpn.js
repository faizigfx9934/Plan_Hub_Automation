import { execSync } from 'child_process';
import { logger } from './logger.js';

export function checkVpn() {
  try {
    // Check if piactl is available and the status is 'Connected'
    const status = execSync('piactl get connectionstate', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    
    if (status === 'Connected') {
      logger.ok('VPN Status: Connected (PIA)');
      return true;
    } else {
      logger.fail(`VPN Status: ${status || 'Disconnected'}`);
      return false;
    }
  } catch (e) {
    // If piactl is not found or fails, we fallback to checking if a VPN interface exists
    try {
      const interfaces = execSync('powershell -Command "Get-NetAdapter | Where-Object { $_.Status -eq \'Up\' -and ($_.InterfaceDescription -like \'*Private Internet Access*\' -or $_.InterfaceDescription -like \'*WireGuard*\') }"').toString();
      if (interfaces.trim()) {
        logger.ok('VPN Status: Connected (Detected via Network Adapter)');
        return true;
      }
    } catch (err) {
      // Final fallback - check public IP? No, let's stick to local checks for speed.
    }
    
    logger.fail('VPN Status: DISCONNECTED');
    return false;
  }
}

export function ensureVpn() {
  if (!checkVpn()) {
    logger.step('Attempting to connect VPN via piactl...');
    try {
      execSync('piactl connect');
      // Wait for connection
      for (let i = 0; i < 10; i++) {
        if (checkVpn()) return true;
        execSync('powershell -Command "Start-Sleep -Seconds 2"');
      }
    } catch (e) {
      logger.fail('Failed to trigger VPN connection.');
    }
    return false;
  }
  return true;
}
