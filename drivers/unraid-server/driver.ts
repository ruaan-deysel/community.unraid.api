'use strict';

import Homey from 'homey';
import { executeQuery, type UnraidClientConfig } from '../../lib/api/client';
import { z } from 'zod';

/**
 * Data stored during pairing process
 */
interface PairingData {
  host: string;
  apiKey: string;
  serverInfo?: {
    hostname: string;
    version: string;
    uptime: number;
  };
}

/**
 * Device data stored with the device
 */
interface DeviceData {
  host: string;
}

/**
 * Store data for the device
 */
interface StoreData {
  apiKey: string;
}

/**
 * UnraidServerDriver handles pairing and device management for Unraid servers
 */
class UnraidServerDriver extends Homey.Driver {
  /**
   * Called when the driver is initialized
   */
  async onInit(): Promise<void> {
    this.log('UnraidServerDriver has been initialized');
  }

  /**
   * Called when a pairing session starts
   */
  async onPair(session: Homey.Driver.PairSession): Promise<void> {
    this.log('Starting pairing session');

    // Store pairing data across views
    const pairingData: PairingData = {
      host: '',
      apiKey: '',
    };

    // Handle login from the single login view
    session.setHandler('login', async (data: { host: string; apiKey: string }) => {
      this.log('Login attempt for:', data.host);
      pairingData.host = data.host;
      pairingData.apiKey = data.apiKey;

      // Validate connection immediately
      const config: UnraidClientConfig = {
        host: pairingData.host,
        apiKey: pairingData.apiKey,
        timeout: 15000,
        allowSelfSigned: true,
      };

      try {
        this.log('Testing connection...');
        const serverInfo = await this.fetchServerInfo(config);
        pairingData.serverInfo = serverInfo;
        this.log('Connection successful:', serverInfo.hostname);
        return true;
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Unknown error';
        this.error('Connection failed:', errorMsg);
        throw new Error(`Could not connect: ${errorMsg}`);
      }
    });

    // Handle list_devices view - create the device
    session.setHandler('list_devices', async () => {
      this.log('Creating device for', pairingData.host);

      const hostname = pairingData.serverInfo?.hostname || pairingData.host;

      const device = {
        name: `Unraid: ${hostname}`,
        data: {
          id: `unraid-${pairingData.host.replace(/\./g, '-')}`,
        } as { id: string },
        store: {
          apiKey: pairingData.apiKey,
        } as StoreData,
        settings: {
          host: pairingData.host,
        } as DeviceData,
      };

      this.log('Device created:', device.name);
      return [device];
    });
  }

  /**
   * Fetch server info for display during pairing
   */
  private async fetchServerInfo(config: UnraidClientConfig): Promise<{
    hostname: string;
    version: string;
    uptime: number;
  }> {
    // Schema for the pairing info query response
    // Note: uptime is returned as ISO date string, versions are under core
    const pairingInfoSchema = z.object({
      info: z.object({
        os: z.object({
          hostname: z.string(),
          uptime: z.string(), // ISO date string
        }),
        versions: z.object({
          core: z.object({
            unraid: z.string().optional(),
          }).optional(),
        }).optional(),
      }),
    });

    type PairingInfoResponse = z.infer<typeof pairingInfoSchema>;

    const query = `
      query {
        info {
          os {
            hostname
            uptime
          }
          versions {
            core {
              unraid
            }
          }
        }
      }
    `;

    const result = await executeQuery<PairingInfoResponse>(
      config,
      query,
      {},
      pairingInfoSchema,
    );

    // Calculate uptime in seconds from ISO date
    let uptimeSeconds = 0;
    try {
      const bootTime = new Date(result.info.os.uptime);
      uptimeSeconds = Math.floor((Date.now() - bootTime.getTime()) / 1000);
    } catch {
      uptimeSeconds = 0;
    }

    return {
      hostname: result.info.os.hostname,
      version: result.info.versions?.core?.unraid ?? 'Unknown',
      uptime: uptimeSeconds,
    };
  }

  /**
   * Called when the driver is being unloaded
   */
  async onUninit(): Promise<void> {
    this.log('UnraidServerDriver has been uninitialized');
  }
}

module.exports = UnraidServerDriver;
