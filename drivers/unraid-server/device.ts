'use strict';

import Homey from 'homey';
import {
  executeQuery,
  startContainer,
  stopContainer,
  restartContainer,
  startVM,
  stopVM,
  startArray,
  stopArray,
  startParityCheck,
  pauseParityCheck,
  resumeParityCheck,
  cancelParityCheck,
  spinUpDisk,
  spinDownDisk,
  type UnraidClientConfig,
} from '../../lib/api/client';
import { PollManager, POLL_INTERVALS, type HomeyTimers } from '../../lib/utils/poll-manager';
import { z } from 'zod';

/**
 * Device settings stored in Homey
 */
interface DeviceSettings {
  host: string;
  port: number;
  useHttps: boolean;
  systemPollInterval?: number;
  storagePollInterval?: number;
  upsVaRating?: number;
}

/**
 * Container info from API
 */
interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  running: boolean;
  status: string;
  webUiUrl?: string;
}

/**
 * VM info from API
 * Note: Unraid GraphQL API only provides id, name, and state for VMs
 */
interface VMInfo {
  id: string;
  name: string;
  powerState: string;
}

/**
 * Disk info from API
 */
interface DiskInfo {
  id: string;
  name: string;
  status: string;
  temp: number | null;
  spinning: boolean;
  fsSize: number | null;
  fsFree: number | null;
  fsUsed: number | null;
  usagePercent: number | null;
}

/**
 * UPS info from API
 */
interface UPSInfo {
  id: string;
  name: string;
  status: string | null;
  batteryLevel: number | null;
  runtime: number | null;
  load: number | null;
  power: number | null;
}

/**
 * Share info from API
 */
interface ShareInfo {
  id: string;
  name: string;
  used: number | null;
  free: number | null;
  usagePercent: number | null;
}

/**
 * UnraidServerDevice represents a connected Unraid server
 */
class UnraidServerDevice extends Homey.Device {
  private pollManager: PollManager | null = null;
  private apiConfig: UnraidClientConfig | null = null;
  private lastParityStatus: string | null = null;
  private lastParityProgress: number | null = null;
  private lastArrayState: string | null = null;
  private lastUnhealthyDisks: Set<string> = new Set();
  private knownContainers: Map<string, ContainerInfo> = new Map();
  private knownVMs: Map<string, VMInfo> = new Map();
  private knownDisks: Map<string, DiskInfo> = new Map();
  private knownUPS: UPSInfo | null = null;
  private lastUPSOnBattery: boolean = false;
  private lastLowBatteryAlerted: boolean = false;
  private knownShares: Map<string, ShareInfo> = new Map();
  private highTempDisks: Set<string> = new Set();
  private highUsageDisks: Set<string> = new Set();
  private highUsageShares: Set<string> = new Set();
  private readonly DISK_TEMP_WARNING = 50; // °C
  private readonly DISK_USAGE_WARNING = 90; // %
  private readonly SHARE_USAGE_WARNING = 90; // %
  private readonly UPS_LOW_BATTERY = 20; // %

  /**
 * Called when the device is initialized
 */
async onInit(): Promise<void> {
  this.log('UnraidServerDevice has been initialized');

  try {
    await this.ensureCapabilities();
    await this.initializeApiClient();
    await this.initializePolling();
    await this.registerFlowCards();
    await this.setAvailable();
  } catch (err) {
    this.error('Failed to initialize device:', err);
    await this.setUnavailable(this.homey.__('device.errors.init_failed'));
  }
}

  /**
   * Ensure all required capabilities are registered on the device
   * This handles upgrades when new capabilities are added
   * Note: Disk usage capabilities (disk1_usage - disk30_usage) are added dynamically
   * based on actual disks present in the array
   */
  private async ensureCapabilities(): Promise<void> {
    const requiredCapabilities = [
      'cpu_usage',
      'cpu_temperature',
      'cpu_power',
      'memory_usage',
      'uptime',
      'notifications_count',
      'array_status',
      'array_usage',
      'storage_used',
      'storage_free',
      'parity_status',
      'disk_health',
      'disk_temperature',
      'containers_running',
      'containers_total',
      'vms_running',
      'vms_total',
      'ups_connected',
      'ups_status',
      'ups_battery',
      'ups_load',
      'ups_power',
      'ups_runtime',
    ];

    // Remove old disk_usage_summary capability if present
    if (this.hasCapability('disk_usage_summary')) {
      this.log('Removing deprecated capability: disk_usage_summary');
      await this.removeCapability('disk_usage_summary');
    }

    for (const capability of requiredCapabilities) {
      if (!this.hasCapability(capability)) {
        this.log(`Adding missing capability: ${capability}`);
        await this.addCapability(capability);
      }
    }
  }

  /**
   * Dynamically manage disk usage capabilities based on actual disks
   * Adds capabilities for disks that exist, removes ones that don't
   */
  private async updateDiskCapabilities(diskCount: number): Promise<void> {
    const MAX_DISKS = 30;

    // Add capabilities for disks that exist
    for (let i = 1; i <= diskCount && i <= MAX_DISKS; i++) {
      const capName = `disk${i}_usage`;
      if (!this.hasCapability(capName)) {
        this.log(`Adding disk capability: ${capName}`);
        await this.addCapability(capName);
      }
    }

    // Remove capabilities for disks that don't exist
    for (let i = diskCount + 1; i <= MAX_DISKS; i++) {
      const capName = `disk${i}_usage`;
      if (this.hasCapability(capName)) {
        this.log(`Removing disk capability: ${capName}`);
        await this.removeCapability(capName);
      }
    }
  }

  /**
   * Initialize the API client configuration
   */
  private async initializeApiClient(): Promise<void> {
    const settings = this.getSettings() as DeviceSettings;
    const apiKey = this.getStoreValue('apiKey') as string;

    if (!settings.host || !apiKey) {
      throw new Error('Missing host or API key');
    }

    this.apiConfig = {
      host: settings.host,
      apiKey,
      port: settings.port || 443,
      useHttps: settings.useHttps !== false,
      timeout: 10000,
    };

    this.log('API client configured for', settings.host);
  }

  /**
   * Initialize polling for server metrics
   */
  private async initializePolling(): Promise<void> {
    const settings = this.getSettings() as DeviceSettings;

    // Create Homey-compatible timer interface
    const homeyTimers: HomeyTimers = {
      setInterval: (callback: () => void, ms: number) => this.homey.setInterval(callback, ms),
      clearInterval: (id: ReturnType<typeof setInterval>) => this.homey.clearInterval(id),
      log: (...args: unknown[]) => this.log('[PollManager]', ...args),
    };

    this.pollManager = new PollManager(homeyTimers, (msg, ...args) => this.log(msg, ...args));

    // Register system metrics poll (CPU, memory, temperature)
    const systemInterval = (settings.systemPollInterval ?? 30) * 1000;
    this.pollManager.register(
      'system',
      () => this.pollSystemMetrics(),
      {
        baseInterval: systemInterval,
        minInterval: POLL_INTERVALS.SYSTEM_METRICS,
        maxInterval: 30000,
        maxRetries: 5,
      },
    );

    // Register storage poll (array status, capacity)
    const storageInterval = (settings.storagePollInterval ?? 300) * 1000;
    this.pollManager.register(
      'storage',
      () => this.pollStorageMetrics(),
      {
        baseInterval: storageInterval,
        minInterval: POLL_INTERVALS.STORAGE,
        maxInterval: 600000, // 10 minutes max
        maxRetries: 3,
      },
    );

    // Register Docker containers poll
    this.pollManager.register(
      'docker',
      () => this.pollDockerContainers(),
      {
        baseInterval: POLL_INTERVALS.DOCKER,
        minInterval: POLL_INTERVALS.DOCKER,
        maxInterval: 120000, // 2 minutes max
        maxRetries: 3,
      },
    );

    // Register Virtual Machines poll
    this.pollManager.register(
      'vms',
      () => this.pollVirtualMachines(),
      {
        baseInterval: POLL_INTERVALS.VMS,
        minInterval: POLL_INTERVALS.VMS,
        maxInterval: 120000, // 2 minutes max
        maxRetries: 3,
      },
    );

    // Register UPS poll
    this.pollManager.register(
      'ups',
      () => this.pollUPS(),
      {
        baseInterval: POLL_INTERVALS.SYSTEM_METRICS, // 30 seconds
        minInterval: POLL_INTERVALS.SYSTEM_METRICS,
        maxInterval: 60000, // 1 minute max
        maxRetries: 3,
      },
    );

    // Start polling
    this.pollManager.start('system');
    this.pollManager.start('storage');
    this.pollManager.start('docker');
    this.pollManager.start('vms');
    this.pollManager.start('ups');

    this.log('Polling initialized');
  }

  /**
   * Poll system metrics (CPU, memory, temperature, uptime, power, notifications) from the API
   */
  private async pollSystemMetrics(): Promise<void> {
    if (!this.apiConfig) {
      throw new Error('API client not initialized');
    }

    // Response schema matching the actual Unraid API structure
    // CPU temperature and power is in info.cpu.packages
    // Uptime is in info.os.uptime as ISO datetime
    const responseSchema = z.object({
      metrics: z.object({
        cpu: z.object({
          percentTotal: z.number(),
        }),
        memory: z.object({
          total: z.union([z.number(), z.string()]).transform(v => Number(v)),
          used: z.union([z.number(), z.string()]).transform(v => Number(v)),
          free: z.union([z.number(), z.string()]).transform(v => Number(v)),
          percentTotal: z.number(),
        }),
      }),
      info: z.object({
        cpu: z.object({
          packages: z.object({
            temp: z.array(z.number()),
            totalPower: z.number().nullable().optional(),
          }),
        }),
        os: z.object({
          uptime: z.string().nullable().optional(),
        }).optional(),
      }),
      notifications: z.object({
        overview: z.object({
          unread: z.object({
            total: z.number().optional(),
          }).optional(),
        }).optional(),
      }).optional(),
    });

    type SystemResponse = z.infer<typeof responseSchema>;

    const query = `
      query {
        metrics {
          cpu {
            percentTotal
          }
          memory {
            total
            used
            free
            percentTotal
          }
        }
        info {
          cpu {
            packages {
              temp
              totalPower
            }
          }
          os {
            uptime
          }
        }
        notifications {
          overview {
            unread {
              total
            }
          }
        }
      }
    `;

    const result = await executeQuery<SystemResponse>(
      this.apiConfig,
      query,
      {},
      responseSchema,
    );

    // Update capabilities
    await this.setCapabilityValue('cpu_usage', result.metrics.cpu.percentTotal);

    // CPU temperature from packages - take max if multiple packages
    const cpuTemps = result.info.cpu.packages.temp;
    if (cpuTemps.length > 0) {
      const maxTemp = Math.max(...cpuTemps);
      await this.setCapabilityValue('cpu_temperature', maxTemp);
    }

    // CPU power consumption (requires API v4.26+)
    const cpuPower = result.info.cpu.packages.totalPower;
    if (cpuPower !== null && cpuPower !== undefined) {
      await this.setCapabilityValue('cpu_power', cpuPower);
    }

    // Uptime
    const uptimeStr = result.info.os?.uptime;
    if (uptimeStr) {
      const uptime = this.formatUptime(uptimeStr);
      await this.setCapabilityValue('uptime', uptime);
    }

    // Notifications count (unread.total from API)
    const unreadNotifications = result.notifications?.overview?.unread?.total ?? 0;
    await this.setCapabilityValue('notifications_count', unreadNotifications);

    await this.setCapabilityValue('memory_usage', result.metrics.memory.percentTotal);

    // Mark device as available on successful poll
    if (!this.getAvailable()) {
      await this.setAvailable();
      this.log('Device is now available');
    }
  }

  /**
   * Poll storage metrics (array status, capacity, parity)
   * 
   * DISK STANDBY SAFETY:
   * This query is specifically designed to NOT wake sleeping disks and NOT
   * prevent disks from entering standby mode (same approach as Home Assistant
   * Unraid integration).
   * 
   * Safe queries (we use these):
   * - array.disks: Returns disk state from Unraid's memory cache
   * - fsSize/fsFree/fsUsed: Filesystem stats cached in memory
   * - isSpinning: Reports spin state without disk access
   * - temp: Returns null for standby disks, only shows temp for spinning disks
   * 
   * Unsafe queries (we avoid these):
   * - Root 'disks' query: Accesses physical disk SMART data, wakes disks
   * - Any SMART attribute queries: Requires disk to spin up
   * 
   * The filesystem usage stats are maintained by Unraid in memory from the
   * last time the disk was mounted/accessed. Querying them does NOT require
   * reading from the physical disk.
   */
  private async pollStorageMetrics(): Promise<void> {
    if (!this.apiConfig) {
      throw new Error('API client not initialized');
    }

    // Response schema matching the actual Unraid API structure
    // Note: isSpinning is included to track disk standby state
    // This field is returned by the API without waking the disk
    // fsSize, fsFree, fsUsed provide individual disk usage data
    // boot = flash USB boot device, caches = cache pool (NVMe/SSD)
    const responseSchema = z.object({
      array: z.object({
        state: z.string(),
        capacity: z.object({
          kilobytes: z.object({
            free: z.string().transform(v => Number(v)),
            used: z.string().transform(v => Number(v)),
            total: z.string().transform(v => Number(v)),
          }),
        }),
        parityCheckStatus: z.object({
          status: z.string(),
          progress: z.number().nullable(),
          running: z.boolean().nullable(),
          errors: z.number().nullable().optional(),
        }),
        boot: z.object({
          name: z.string(),
          fsSize: z.number().nullable(),
          fsFree: z.number().nullable(),
          fsUsed: z.number().nullable(),
        }).nullable().optional(),
        caches: z.array(z.object({
          name: z.string(),
          fsSize: z.number().nullable(),
          fsFree: z.number().nullable(),
          fsUsed: z.number().nullable(),
        })).optional(),
        disks: z.array(z.object({
          id: z.string(),
          name: z.string(),
          status: z.string(),
          temp: z.number().nullable(),
          isSpinning: z.boolean().nullable().optional(),
          fsSize: z.number().nullable().optional(),
          fsFree: z.number().nullable().optional(),
          fsUsed: z.number().nullable().optional(),
          type: z.string().optional(),
        })),
      }),
    });

    type StorageResponse = z.infer<typeof responseSchema>;

    // DISK STANDBY SAFE: Using array.disks (memory-cached) NOT root disks query
    // - fsSize/fsFree/fsUsed: Cached stats, no disk access required
    // - isSpinning: Reports state without waking disk
    // - temp: null for standby disks, only populated when already spinning
    // - boot: Flash USB (always on, no standby)
    // - caches: NVMe/SSD cache pool (no standby typically)
    const query = `
      query {
        array {
          state
          capacity {
            kilobytes {
              free
              used
              total
            }
          }
          parityCheckStatus {
            status
            progress
            running
            errors
          }
          boot {
            name
            fsSize
            fsFree
            fsUsed
          }
          caches {
            name
            fsSize
            fsFree
            fsUsed
          }
          disks {
            id
            name
            status
            temp
            isSpinning
            fsSize
            fsFree
            fsUsed
            type
          }
        }
      }
    `;

    try {
      const result = await executeQuery<StorageResponse>(
        this.apiConfig,
        query,
        {},
        responseSchema,
      );

      // Map API array state to Homey enum values
      // API returns: STARTED, STOPPED, STARTING, etc.
      // Homey expects: started, stopped, starting, stopping, error
      const arrayStateMap: Record<string, string> = {
        'STARTED': 'started',
        'STOPPED': 'stopped',
        'STARTING': 'starting',
        'STOPPING': 'stopping',
        'NEW_ARRAY': 'stopped',
        'INVALID': 'error',
      };
      const arrayStatus = arrayStateMap[result.array.state] || 'error';
      await this.setCapabilityValue('array_status', arrayStatus);

      // Track array state changes for triggers
      if (this.lastArrayState !== null && this.lastArrayState !== result.array.state) {
        // Array started
        if (result.array.state === 'STARTED' && this.lastArrayState !== 'STARTED') {
          await this.triggerArrayStarted();
        }
        // Array stopped
        if (result.array.state === 'STOPPED' && this.lastArrayState !== 'STOPPED') {
          await this.triggerArrayStopped();
        }
      }
      this.lastArrayState = result.array.state;

      // Capacity is in kilobytes, convert to bytes then calculate percentage
      const totalBytes = result.array.capacity.kilobytes.total * 1024;
      const usedBytes = result.array.capacity.kilobytes.used * 1024;
      const freeBytes = result.array.capacity.kilobytes.free * 1024;

      const usagePercent = totalBytes > 0
        ? (usedBytes / totalBytes) * 100
        : 0;
      await this.setCapabilityValue('array_usage', usagePercent);

      // Convert to TB for storage values (1 decimal place)
      const usedTB = Math.round((usedBytes / (1024 ** 4)) * 10) / 10;
      const freeTB = Math.round((freeBytes / (1024 ** 4)) * 10) / 10;
      await this.setCapabilityValue('storage_used', usedTB);
      await this.setCapabilityValue('storage_free', freeTB);

      // Map parity status to Homey enum values
      // API returns: COMPLETED, RUNNING, PAUSED, CANCELLED, etc.
      // Homey expects: valid, checking, invalid, disabled
      const parityStatus = result.array.parityCheckStatus;
      const parityStatusMap: Record<string, string> = {
        'COMPLETED': 'valid',
        'VALID': 'valid',
        'RUNNING': 'checking',
        'PAUSED': 'checking',
        'CANCELLED': 'valid',
        'INVALID': 'invalid',
        'DISABLED': 'disabled',
        'NONE': 'disabled',
      };
      const mappedParityStatus = parityStatusMap[parityStatus.status] || 'valid';
      await this.setCapabilityValue('parity_status', mappedParityStatus);

      // Store original status for flow trigger
      const currentParityStatus = parityStatus.status;

      // Trigger parity started flow if status changed to running
      if (this.lastParityStatus !== null &&
          this.lastParityStatus !== currentParityStatus &&
          parityStatus.running === true) {
        await this.triggerParityStarted(parityStatus.progress ?? 0);
      }

      // Trigger parity completed flow if status changed to completed
      if (this.lastParityStatus !== null &&
          this.lastParityStatus !== currentParityStatus &&
          currentParityStatus === 'COMPLETED') {
        await this.triggerParityCompleted(parityStatus.errors ?? 0);
      }

      this.lastParityStatus = currentParityStatus;
      this.lastParityProgress = parityStatus.progress;

      // Update known disks for autocomplete (with usage data)
      // Note: isSpinning comes from array.disks which doesn't wake sleeping disks
      // Parity disks (type=PARITY) don't have filesystem usage, only data disks do
      result.array.disks.forEach((disk) => {
        const fsSize = disk.fsSize ?? null;
        const fsFree = disk.fsFree ?? null;
        const fsUsed = disk.fsUsed ?? null;
        const usagePercent = fsSize && fsSize > 0 && fsUsed !== null
          ? (fsUsed / fsSize) * 100
          : null;

        this.knownDisks.set(disk.id, {
          id: disk.id,
          name: disk.name,
          status: disk.status,
          temp: disk.temp,
          spinning: disk.isSpinning ?? true,
          fsSize,
          fsFree,
          fsUsed,
          usagePercent,
        });

        // Check disk usage high (only for data disks with filesystem)
        if (usagePercent !== null && usagePercent >= this.DISK_USAGE_WARNING) {
          if (!this.highUsageDisks.has(disk.name)) {
            // eslint-disable-next-line @typescript-eslint/no-floating-promises
            this.triggerDiskUsageHigh(disk.name, usagePercent);
            this.highUsageDisks.add(disk.name);
          }
        } else {
          // Remove from high usage set when usage goes below threshold
          this.highUsageDisks.delete(disk.name);
        }
      });

      // Count data disks (disks with filesystem usage)
      const dataDisks = result.array.disks.filter(
        disk => disk.fsSize && disk.fsSize > 0 && disk.fsUsed !== null,
      );

      // Dynamically add/remove disk capabilities based on actual disk count
      await this.updateDiskCapabilities(dataDisks.length);

      // Update individual disk usage capabilities
      let diskIndex = 1;
      for (const disk of dataDisks) {
        const usagePercent = Math.round((disk.fsUsed! / disk.fsSize!) * 100);
        const capabilityName = `disk${diskIndex}_usage`;
        if (this.hasCapability(capabilityName)) {
          await this.setCapabilityValue(capabilityName, usagePercent);
        }
        diskIndex++;
      }

      // Update cache pool usage (NVMe/SSD cache)
      // Dynamically add/remove cache_usage capability based on presence
      if (result.array.caches && result.array.caches.length > 0) {
        const cache = result.array.caches[0]; // Primary cache pool
        if (cache.fsSize && cache.fsSize > 0 && cache.fsUsed !== null) {
          // Ensure capability exists
          if (!this.hasCapability('cache_usage')) {
            await this.addCapability('cache_usage');
            this.log('Added cache_usage capability');
          }
          const cacheUsagePercent = Math.round((cache.fsUsed / cache.fsSize) * 100);
          await this.setCapabilityValue('cache_usage', cacheUsagePercent);
        }
      } else if (this.hasCapability('cache_usage')) {
        // Remove cache capability if no cache pool
        await this.removeCapability('cache_usage');
        this.log('Removed cache_usage capability (no cache pool)');
      }

      // Update flash (USB boot device) usage
      // Dynamically add/remove flash_usage capability based on presence
      if (result.array.boot && result.array.boot.fsSize && result.array.boot.fsSize > 0) {
        if (!this.hasCapability('flash_usage')) {
          await this.addCapability('flash_usage');
          this.log('Added flash_usage capability');
        }
        const flashUsagePercent = Math.round(
          ((result.array.boot.fsUsed ?? 0) / result.array.boot.fsSize) * 100,
        );
        await this.setCapabilityValue('flash_usage', flashUsagePercent);
      } else if (this.hasCapability('flash_usage')) {
        // Remove flash capability if boot info unavailable
        await this.removeCapability('flash_usage');
        this.log('Removed flash_usage capability');
      }

      // Check disk health - DISK_OK is healthy status
      const unhealthyDisks = result.array.disks.filter(
        disk => disk.status !== 'DISK_OK',
      );

      // Trigger disk warning for newly unhealthy disks
      for (const disk of unhealthyDisks) {
        if (!this.lastUnhealthyDisks.has(disk.name)) {
          await this.triggerDiskWarning(disk.name, disk.status);
        }
      }

      // Update the set of unhealthy disks
      this.lastUnhealthyDisks = new Set(unhealthyDisks.map(d => d.name));

      // Use enum values for disk_health: healthy, warning, critical, unknown
      // Check for critical statuses (DISK_INVALID, DISK_WRONG, DISK_DSBL)
      const criticalDisks = unhealthyDisks.filter(
        d => ['DISK_INVALID', 'DISK_WRONG', 'DISK_DSBL', 'DISK_DSBL_NEW'].includes(d.status),
      );

      let diskHealthValue: string;
      if (criticalDisks.length > 0) {
        diskHealthValue = 'critical';
      } else if (unhealthyDisks.length > 0) {
        diskHealthValue = 'warning';
      } else if (result.array.disks.length === 0) {
        diskHealthValue = 'unknown';
      } else {
        diskHealthValue = 'healthy';
      }
      await this.setCapabilityValue('disk_health', diskHealthValue);

      // Update max disk temperature capability
      // Only consider spinning disks (temp is null for standby disks)
      const spinningDisksWithTemp = result.array.disks.filter(
        d => d.temp !== null && d.temp > 0,
      );
      if (spinningDisksWithTemp.length > 0) {
        const maxDiskTemp = Math.max(...spinningDisksWithTemp.map(d => d.temp!));
        await this.setCapabilityValue('disk_temperature', maxDiskTemp);

        // Check for high temperature disks and trigger warnings
        for (const disk of spinningDisksWithTemp) {
          const diskTemp = disk.temp!;
          if (diskTemp >= this.DISK_TEMP_WARNING) {
            if (!this.highTempDisks.has(disk.name)) {
              await this.triggerDiskTempHigh(disk.name, diskTemp);
              this.highTempDisks.add(disk.name);
            }
          } else {
            // Remove from high temp set when temp goes below threshold
            this.highTempDisks.delete(disk.name);
          }
        }
      }
    } catch (err) {
      this.error('Storage poll failed:', err instanceof Error ? err.message : err);
      throw err;
    }

    // Poll shares separately (won't wake disks)
    await this.pollShares();
  }

  /**
   * Poll shares usage (user shares)
   */
  private async pollShares(): Promise<void> {
    if (!this.apiConfig) {
      throw new Error('API client not initialized');
    }

    // Shares API returns: name, comment, free, size, used (all numbers in KB)
    // Note: 'size' is often 0 from API, so we calculate total from used+free
    const responseSchema = z.object({
      shares: z.array(z.object({
        name: z.string(),
        comment: z.string().optional(),
        used: z.number(),
        free: z.number(),
        size: z.number(),
      })),
    });

    type SharesResponse = z.infer<typeof responseSchema>;

    const query = `
      query {
        shares {
          name
          comment
          used
          free
          size
        }
      }
    `;

    try {
      const result = await executeQuery<SharesResponse>(
        this.apiConfig,
        query,
        {},
        responseSchema,
      );

      // Update known shares
      for (const share of result.shares) {
        const usedKB = share.used;
        const freeKB = share.free;
        const totalKB = usedKB + freeKB;
        const usagePercent = totalKB > 0 ? (usedKB / totalKB) * 100 : 0;

        this.knownShares.set(share.name, {
          id: share.name,
          name: share.name,
          used: usedKB,
          free: freeKB,
          usagePercent,
        });

        // Check for high usage and trigger warnings
        if (usagePercent >= this.SHARE_USAGE_WARNING) {
          if (!this.highUsageShares.has(share.name)) {
            await this.triggerShareUsageHigh(share.name, usagePercent);
            this.highUsageShares.add(share.name);
          }
        } else {
          // Remove from high usage set when usage goes below threshold
          this.highUsageShares.delete(share.name);
        }
      }
    } catch (err) {
      this.error('Shares poll failed:', err instanceof Error ? err.message : err);
      // Don't throw - shares are optional
    }
  }

  /**
   * Poll UPS status
   */
  private async pollUPS(): Promise<void> {
    if (!this.apiConfig) {
      throw new Error('API client not initialized');
    }

    // UPS API uses 'upsDevices' at root level (not 'ups.devices')
    const responseSchema = z.object({
      upsDevices: z.array(z.object({
        id: z.string(),
        name: z.string(),
        model: z.string().optional(),
        status: z.string().nullable().optional(),
        battery: z.object({
          chargeLevel: z.number().nullable().optional(),
          estimatedRuntime: z.number().nullable().optional(),
          health: z.string().nullable().optional(),
        }).optional(),
        power: z.object({
          inputVoltage: z.number().nullable().optional(),
          outputVoltage: z.number().nullable().optional(),
          loadPercentage: z.number().nullable().optional(),
        }).optional(),
      })).nullable().optional(),
    });

    type UPSResponse = z.infer<typeof responseSchema>;

    const query = `
      query {
        upsDevices {
          id
          name
          model
          status
          battery {
            chargeLevel
            estimatedRuntime
            health
          }
          power {
            inputVoltage
            outputVoltage
            loadPercentage
          }
        }
      }
    `;

    try {
      const result = await executeQuery<UPSResponse>(
        this.apiConfig,
        query,
        {},
        responseSchema,
      );

      const devices = result.upsDevices ?? [];

      if (devices.length === 0) {
        // No UPS configured
        await this.setCapabilityValue('ups_connected', false);
        await this.setCapabilityValue('ups_status', 'Not Connected');
        this.knownUPS = null;
        return;
      }

      // Use the first UPS device
      const ups = devices[0];
      const status = ups.status ?? 'Unknown';
      const batteryLevel = ups.battery?.chargeLevel ?? null;
      const runtime = ups.battery?.estimatedRuntime ?? null;
      const load = ups.power?.loadPercentage ?? null;

      // Calculate power if we have load and UPS VA capacity from settings
      // Power (W) = VA Rating * Load Percentage / 100 * Power Factor (typically ~0.6 for UPS)
      const settings = this.getSettings() as DeviceSettings;
      const upsVaRating = settings.upsVaRating ?? 0;
      let power: number | null = null;
      if (load !== null && upsVaRating > 0) {
        // Use power factor of 0.6 (typical for computer loads)
        power = Math.round((upsVaRating * load / 100) * 0.6);
      }

      this.knownUPS = {
        id: ups.id,
        name: ups.name,
        status,
        batteryLevel,
        runtime,
        load,
        power,
      };

      // Determine if UPS is on battery
      // API returns "ONLINE" when on mains, various other statuses when on battery
      const isOnBattery = status === 'On Battery' || status === 'OB' ||
                          status === 'OB CHRG' || status === 'LB' || status === 'ONBATT';

      await this.setCapabilityValue('ups_connected', true);
      await this.setCapabilityValue('ups_status', status);

      if (batteryLevel !== null) {
        await this.setCapabilityValue('ups_battery', batteryLevel);
      }
      if (runtime !== null) {
        // Runtime is in seconds, convert to minutes
        await this.setCapabilityValue('ups_runtime', Math.floor(runtime / 60));
      }
      if (load !== null) {
        await this.setCapabilityValue('ups_load', load);
      }
      if (power !== null) {
        await this.setCapabilityValue('ups_power', power);
      }

      // UPS state change detection
      if (isOnBattery && !this.lastUPSOnBattery) {
        // Just switched to battery
        await this.triggerUPSOnBattery(batteryLevel ?? 100, runtime ? Math.floor(runtime / 60) : 0);
      } else if (!isOnBattery && this.lastUPSOnBattery) {
        // Back on mains power
        await this.triggerUPSBackOnline(batteryLevel ?? 100);
        this.lastLowBatteryAlerted = false; // Reset low battery alert
      }

      // Check for low battery (only when on battery)
      if (isOnBattery && batteryLevel !== null && batteryLevel <= this.UPS_LOW_BATTERY) {
        if (!this.lastLowBatteryAlerted) {
          await this.triggerUPSLowBattery(batteryLevel, runtime ? Math.floor(runtime / 60) : 0);
          this.lastLowBatteryAlerted = true;
        }
      }

      this.lastUPSOnBattery = isOnBattery;
    } catch (err) {
      // UPS might not be available, that's OK
      this.log('UPS poll failed (may not be configured):', err instanceof Error ? err.message : err);
      await this.setCapabilityValue('ups_connected', false);
    }
  }

  /**
   * Trigger array started flow
   */
  private async triggerArrayStarted(): Promise<void> {
    const trigger = this.homey.flow.getDeviceTriggerCard('array-started');
    await trigger.trigger(this);
    this.log('Array started flow triggered');
  }

  /**
   * Trigger array stopped flow
   */
  private async triggerArrayStopped(): Promise<void> {
    const trigger = this.homey.flow.getDeviceTriggerCard('array-stopped');
    await trigger.trigger(this);
    this.log('Array stopped flow triggered');
  }

  /**
   * Trigger parity completed flow
   */
  private async triggerParityCompleted(errors: number): Promise<void> {
    const trigger = this.homey.flow.getDeviceTriggerCard('parity-completed');
    await trigger.trigger(this, { errors });
    this.log(`Parity completed flow triggered with ${errors} errors`);
  }

  /**
   * Trigger disk temperature high flow
   */
  private async triggerDiskTempHigh(diskName: string, temperature: number): Promise<void> {
    const trigger = this.homey.flow.getDeviceTriggerCard('disk-temp-high');
    await trigger.trigger(this, { disk_name: diskName, temperature });
    this.log(`Disk temp high flow triggered for ${diskName}: ${temperature}°C`);
  }

  /**
   * Trigger disk usage high flow
   */
  private async triggerDiskUsageHigh(diskName: string, usagePercent: number): Promise<void> {
    const trigger = this.homey.flow.getDeviceTriggerCard('disk-usage-high');
    await trigger.trigger(this, { disk_name: diskName, usage_percent: Math.round(usagePercent) });
    this.log(`Disk usage high flow triggered for ${diskName}: ${Math.round(usagePercent)}%`);
  }

  /**
   * Trigger share usage high flow
   */
  private async triggerShareUsageHigh(shareName: string, usagePercent: number): Promise<void> {
    const trigger = this.homey.flow.getDeviceTriggerCard('share-usage-high');
    await trigger.trigger(this, { share_name: shareName, usage_percent: Math.round(usagePercent) });
    this.log(`Share usage high flow triggered for ${shareName}: ${Math.round(usagePercent)}%`);
  }

  /**
   * Trigger UPS on battery flow
   */
  private async triggerUPSOnBattery(batteryLevel: number, runtime: number): Promise<void> {
    const trigger = this.homey.flow.getDeviceTriggerCard('ups-on-battery');
    await trigger.trigger(this, { battery_level: batteryLevel, runtime });
    this.log(`UPS on battery flow triggered: ${batteryLevel}%, ${runtime} min remaining`);
  }

  /**
   * Trigger UPS low battery flow
   */
  private async triggerUPSLowBattery(batteryLevel: number, runtime: number): Promise<void> {
    const trigger = this.homey.flow.getDeviceTriggerCard('ups-low-battery');
    await trigger.trigger(this, { battery_level: batteryLevel, runtime });
    this.log(`UPS low battery flow triggered: ${batteryLevel}%, ${runtime} min remaining`);
  }

  /**
   * Trigger UPS back online flow
   */
  private async triggerUPSBackOnline(batteryLevel: number): Promise<void> {
    const trigger = this.homey.flow.getDeviceTriggerCard('ups-back-online');
    await trigger.trigger(this, { battery_level: batteryLevel });
    this.log(`UPS back online flow triggered: ${batteryLevel}%`);
  }

  /**
   * Format uptime from ISO datetime to human-readable string
   */
  private formatUptime(uptimeISO: string): string {
    try {
      const bootTime = new Date(uptimeISO);
      const now = new Date();
      const diffMs = now.getTime() - bootTime.getTime();

      if (diffMs < 0) return '0 seconds';

      const seconds = Math.floor(diffMs / 1000);
      const minutes = Math.floor(seconds / 60);
      const hours = Math.floor(minutes / 60);
      const days = Math.floor(hours / 24);

      const parts: string[] = [];
      if (days > 0) parts.push(`${days}d`);
      if (hours % 24 > 0) parts.push(`${hours % 24}h`);
      if (minutes % 60 > 0) parts.push(`${minutes % 60}m`);
      if (parts.length === 0) parts.push(`${seconds % 60}s`);

      return parts.join(' ');
    } catch {
      return 'Unknown';
    }
  }

  /**
   * Poll Docker containers
   */
  private async pollDockerContainers(): Promise<void> {
    if (!this.apiConfig) {
      throw new Error('API client not initialized');
    }

    // Response schema matching the actual Unraid API structure
    // Note: 'names' is an array (not 'name'), and no webUiUrl field available
    const responseSchema = z.object({
      docker: z.object({
        containers: z.array(z.object({
          id: z.string(),
          names: z.array(z.string()),
          image: z.string(),
          state: z.string(),
          status: z.string(),
          autoStart: z.boolean(),
        })),
      }),
    });

    type DockerResponse = z.infer<typeof responseSchema>;

    const query = `
      query {
        docker {
          containers {
            id
            names
            image
            state
            status
            autoStart
          }
        }
      }
    `;

    const result = await executeQuery<DockerResponse>(
      this.apiConfig,
      query,
      {},
      responseSchema,
    );

    const currentContainerIds = new Set<string>();

    // Update container devices
    for (const container of result.docker.containers) {
      currentContainerIds.add(container.id);

      // Get the first name and strip leading slash
      const containerName = container.names[0]?.replace(/^\//, '') ?? container.id;
      const isRunning = container.state === 'RUNNING';

      // Check if state changed for triggers
      const previousContainer = this.knownContainers.get(container.id);
      if (previousContainer) {
        // Container started
        if (!previousContainer.running && isRunning) {
          await this.triggerContainerStarted(containerName, container.id);
        }
        // Container stopped
        if (previousContainer.running && !isRunning) {
          await this.triggerContainerStopped(containerName, container.id);
        }
      }

      const containerInfo: ContainerInfo = {
        id: container.id,
        name: containerName,
        image: container.image,
        running: isRunning,
        status: container.status,
      };

      this.knownContainers.set(container.id, containerInfo);
    }

    // Remove containers that no longer exist
    for (const [containerId] of this.knownContainers) {
      if (!currentContainerIds.has(containerId)) {
        this.knownContainers.delete(containerId);
      }
    }

    // Update container count capabilities
    const containersTotal = this.knownContainers.size;
    const containersRunning = Array.from(this.knownContainers.values()).filter(c => c.running).length;
    await this.setCapabilityValue('containers_total', containersTotal);
    await this.setCapabilityValue('containers_running', containersRunning);
  }

  /**
   * Trigger container started flow
   */
  private async triggerContainerStarted(containerName: string, containerId: string): Promise<void> {
    const trigger = this.homey.flow.getDeviceTriggerCard('container-started');
    await trigger.trigger(this, { container_name: containerName, container_id: containerId });
    this.log(`Container started flow triggered for ${containerName}`);
  }

  /**
   * Trigger container stopped flow
   */
  private async triggerContainerStopped(containerName: string, containerId: string): Promise<void> {
    const trigger = this.homey.flow.getDeviceTriggerCard('container-stopped');
    await trigger.trigger(this, { container_name: containerName, container_id: containerId });
    this.log(`Container stopped flow triggered for ${containerName}`);
  }

  /**
   * Get containers for flow card autocomplete
   */
  getContainers(): ContainerInfo[] {
    return Array.from(this.knownContainers.values());
  }

  /**
   * Poll Virtual Machines
   */
  private async pollVirtualMachines(): Promise<void> {
    if (!this.apiConfig) {
      throw new Error('API client not initialized');
    }

    // Response schema matching the actual Unraid API structure
    // VMs API uses 'uuid' not 'id', and 'vms.domain[]' for the array
    const responseSchema = z.object({
      vms: z.object({
        domain: z.array(z.object({
          uuid: z.string(),
          name: z.string().nullable(),
          state: z.string(),
        })),
      }),
    });

    type VMsResponse = z.infer<typeof responseSchema>;

    const query = `
      query {
        vms {
          domain {
            uuid
            name
            state
          }
        }
      }
    `;

    const result = await executeQuery<VMsResponse>(
      this.apiConfig,
      query,
      {},
      responseSchema,
    );

    const currentVMIds = new Set<string>();
    const runningStates = ['RUNNING', 'IDLE', 'PAUSED', 'PMSUSPENDED'];

    // Update VM devices
    for (const vm of result.vms.domain) {
      currentVMIds.add(vm.uuid);

      const vmName = vm.name ?? vm.uuid;
      const isRunning = runningStates.includes(vm.state);

      // Check if state changed for triggers
      const previousVM = this.knownVMs.get(vm.uuid);
      if (previousVM) {
        const wasRunning = runningStates.includes(previousVM.powerState);
        // VM started
        if (!wasRunning && isRunning) {
          await this.triggerVMStarted(vmName, vm.uuid);
        }
        // VM stopped
        if (wasRunning && !isRunning) {
          await this.triggerVMStopped(vmName, vm.uuid);
        }
      }

      const vmInfo: VMInfo = {
        id: vm.uuid,
        name: vmName,
        powerState: vm.state,
      };

      this.knownVMs.set(vm.uuid, vmInfo);
    }

    // Remove VMs that no longer exist
    for (const [vmId] of this.knownVMs) {
      if (!currentVMIds.has(vmId)) {
        this.knownVMs.delete(vmId);
      }
    }

    // Update VM count capabilities
    const vmsTotal = this.knownVMs.size;
    const runningStatesForCount = ['RUNNING', 'IDLE', 'PAUSED', 'PMSUSPENDED'];
    const vmsRunning = Array.from(this.knownVMs.values()).filter(vmItem => runningStatesForCount.includes(vmItem.powerState)).length;
    await this.setCapabilityValue('vms_total', vmsTotal);
    await this.setCapabilityValue('vms_running', vmsRunning);
  }

  /**
   * Trigger VM started flow
   */
  private async triggerVMStarted(vmName: string, vmId: string): Promise<void> {
    const trigger = this.homey.flow.getDeviceTriggerCard('vm-started');
    await trigger.trigger(this, { vm_name: vmName, vm_id: vmId });
    this.log(`VM started flow triggered for ${vmName}`);
  }

  /**
   * Trigger VM stopped flow
   */
  private async triggerVMStopped(vmName: string, vmId: string): Promise<void> {
    const trigger = this.homey.flow.getDeviceTriggerCard('vm-stopped');
    await trigger.trigger(this, { vm_name: vmName, vm_id: vmId });
    this.log(`VM stopped flow triggered for ${vmName}`);
  }

  /**
   * Get VMs for flow card autocomplete
   */
  getVMs(): VMInfo[] {
    return Array.from(this.knownVMs.values());
  }

  /**
   * Register flow card handlers for conditions and triggers
   */
  private async registerFlowCards(): Promise<void> {
    // ========================================================================
    // Condition Cards
    // ========================================================================

    // CPU usage condition card
    this.homey.flow.getConditionCard('cpu-above')
      .registerRunListener(async (args: { threshold: number }) => {
        const cpuUsage = this.getCapabilityValue('cpu_usage') as number | null;
        if (cpuUsage === null) {
          return false;
        }
        return cpuUsage > args.threshold;
      });

    // Memory usage condition card
    this.homey.flow.getConditionCard('memory-above')
      .registerRunListener(async (args: { threshold: number }) => {
        const memoryUsage = this.getCapabilityValue('memory_usage') as number | null;
        if (memoryUsage === null) {
          return false;
        }
        return memoryUsage > args.threshold;
      });

    // Temperature condition card
    this.homey.flow.getConditionCard('temp-above')
      .registerRunListener(async (args: { threshold: number }) => {
        const temperature = this.getCapabilityValue('cpu_temperature') as number | null;
        if (temperature === null) {
          return false;
        }
        return temperature > args.threshold;
      });

    // Array state condition card
    this.homey.flow.getConditionCard('array-state')
      .registerRunListener(async (args: { state: string }) => {
        const arrayStatus = this.getCapabilityValue('array_status') as string | null;
        if (arrayStatus === null) {
          return false;
        }
        return arrayStatus.toLowerCase() === args.state.toLowerCase();
      });

    // Container running condition card
    // Note: Homey uses snake_case for flow card args, so we alias them
    this.homey.flow.getConditionCard('container-running')
      .registerRunListener(async (args: Record<string, { id: string; name: string }>) => {
        const containerArg = args['container_name'];
        const container = this.knownContainers.get(containerArg.id);
        return container?.running === true;
      })
      .registerArgumentAutocompleteListener(
        'container_name',
        async () => this.getContainerAutocomplete(),
      );

    // VM running condition card
    this.homey.flow.getConditionCard('vm-running')
      .registerRunListener(async (args: Record<string, { id: string; name: string }>) => {
        const vmArg = args['vm_name'];
        const vm = this.knownVMs.get(vmArg.id);
        const runningStates = ['RUNNING', 'IDLE', 'PAUSED', 'PMSUSPENDED'];
        return vm !== undefined && runningStates.includes(vm.powerState);
      })
      .registerArgumentAutocompleteListener(
        'vm_name',
        async () => this.getVMAutocomplete(),
      );

    // Parity check running condition card
    this.homey.flow.getConditionCard('parity-check-running')
      .registerRunListener(async () => {
        const parityStatus = this.getCapabilityValue('parity_status') as string | null;
        return parityStatus === 'checking';
      });

    // UPS connected condition card
    this.homey.flow.getConditionCard('ups-connected')
      .registerRunListener(async () => {
        const upsConnected = this.getCapabilityValue('ups_connected') as boolean | null;
        return upsConnected === true;
      });

    // UPS on battery condition card
    this.homey.flow.getConditionCard('ups-on-battery')
      .registerRunListener(async () => {
        const upsStatus = this.getCapabilityValue('ups_status') as string | null;
        if (!upsStatus) return false;
        const onBatteryStatuses = ['On Battery', 'OB', 'OB CHRG', 'LB'];
        return onBatteryStatuses.includes(upsStatus);
      });

    // UPS battery above threshold condition card
    this.homey.flow.getConditionCard('ups-battery-above')
      .registerRunListener(async (args: { threshold: number }) => {
        const upsBattery = this.getCapabilityValue('ups_battery') as number | null;
        if (upsBattery === null) return false;
        return upsBattery > args.threshold;
      });

    // Disk temperature above threshold condition card
    this.homey.flow.getConditionCard('disk-temp-above')
      .registerRunListener(async (args: Record<string, { id: string; name: string } | number>) => {
        const diskArg = args['disk_name'] as { id: string; name: string };
        const threshold = args['threshold'] as number;
        const disk = this.knownDisks.get(diskArg.id);
        if (!disk || disk.temp === null) return false;
        return disk.temp > threshold;
      })
      .registerArgumentAutocompleteListener(
        'disk_name',
        async () => this.getDiskAutocomplete(),
      );

    // Disk usage above threshold condition card
    this.homey.flow.getConditionCard('disk-usage-above')
      .registerRunListener(async (args: Record<string, { id: string; name: string } | number>) => {
        const diskArg = args['disk_name'] as { id: string; name: string };
        const threshold = args['threshold'] as number;
        const disk = this.knownDisks.get(diskArg.id);
        if (!disk || disk.usagePercent === null) return false;
        return disk.usagePercent > threshold;
      })
      .registerArgumentAutocompleteListener(
        'disk_name',
        async () => this.getDataDiskAutocomplete(),
      );

    // ========================================================================
    // Action Cards
    // ========================================================================

    // Start container action
    this.homey.flow.getActionCard('start-container')
      .registerRunListener(async (args: Record<string, { id: string; name: string }>) => {
        if (!this.apiConfig) {
          throw new Error('API client not initialized');
        }
        const containerArg = args['container_name'];
        await startContainer(this.apiConfig, containerArg.id);
        this.log(`Started container: ${containerArg.name}`);
      })
      .registerArgumentAutocompleteListener(
        'container_name',
        async () => this.getContainerAutocomplete(),
      );

    // Stop container action
    this.homey.flow.getActionCard('stop-container')
      .registerRunListener(async (args: Record<string, { id: string; name: string }>) => {
        if (!this.apiConfig) {
          throw new Error('API client not initialized');
        }
        const containerArg = args['container_name'];
        await stopContainer(this.apiConfig, containerArg.id);
        this.log(`Stopped container: ${containerArg.name}`);
      })
      .registerArgumentAutocompleteListener(
        'container_name',
        async () => this.getContainerAutocomplete(),
      );

    // Restart container action
    this.homey.flow.getActionCard('restart-container')
      .registerRunListener(async (args: Record<string, { id: string; name: string }>) => {
        if (!this.apiConfig) {
          throw new Error('API client not initialized');
        }
        const containerArg = args['container_name'];
        await restartContainer(this.apiConfig, containerArg.id);
        this.log(`Restarted container: ${containerArg.name}`);
      })
      .registerArgumentAutocompleteListener(
        'container_name',
        async () => this.getContainerAutocomplete(),
      );

    // Start VM action
    this.homey.flow.getActionCard('start-vm')
      .registerRunListener(async (args: Record<string, { id: string; name: string }>) => {
        if (!this.apiConfig) {
          throw new Error('API client not initialized');
        }
        const vmArg = args['vm_name'];
        await startVM(this.apiConfig, vmArg.id);
        this.log(`Started VM: ${vmArg.name}`);
      })
      .registerArgumentAutocompleteListener(
        'vm_name',
        async () => this.getVMAutocomplete(),
      );

    // Stop VM action
    this.homey.flow.getActionCard('stop-vm')
      .registerRunListener(async (args: Record<string, { id: string; name: string }>) => {
        if (!this.apiConfig) {
          throw new Error('API client not initialized');
        }
        const vmArg = args['vm_name'];
        await stopVM(this.apiConfig, vmArg.id);
        this.log(`Stopped VM: ${vmArg.name}`);
      })
      .registerArgumentAutocompleteListener(
        'vm_name',
        async () => this.getVMAutocomplete(),
      );

    // Start array action
    this.homey.flow.getActionCard('start-array')
      .registerRunListener(async () => {
        if (!this.apiConfig) {
          throw new Error('API client not initialized');
        }
        await startArray(this.apiConfig);
        this.log('Started array');
      });

    // Stop array action
    this.homey.flow.getActionCard('stop-array')
      .registerRunListener(async () => {
        if (!this.apiConfig) {
          throw new Error('API client not initialized');
        }
        await stopArray(this.apiConfig);
        this.log('Stopped array');
      });

    // Start parity check action
    this.homey.flow.getActionCard('start-parity-check')
      .registerRunListener(async () => {
        if (!this.apiConfig) {
          throw new Error('API client not initialized');
        }
        await startParityCheck(this.apiConfig, false);
        this.log('Started parity check (read-only)');
      });

    // Start parity check with corrections action
    this.homey.flow.getActionCard('start-parity-check-correct')
      .registerRunListener(async () => {
        if (!this.apiConfig) {
          throw new Error('API client not initialized');
        }
        await startParityCheck(this.apiConfig, true);
        this.log('Started parity check (with corrections)');
      });

    // Pause parity check action
    this.homey.flow.getActionCard('pause-parity-check')
      .registerRunListener(async () => {
        if (!this.apiConfig) {
          throw new Error('API client not initialized');
        }
        await pauseParityCheck(this.apiConfig);
        this.log('Paused parity check');
      });

    // Resume parity check action
    this.homey.flow.getActionCard('resume-parity-check')
      .registerRunListener(async () => {
        if (!this.apiConfig) {
          throw new Error('API client not initialized');
        }
        await resumeParityCheck(this.apiConfig);
        this.log('Resumed parity check');
      });

    // Stop parity check action
    this.homey.flow.getActionCard('stop-parity-check')
      .registerRunListener(async () => {
        if (!this.apiConfig) {
          throw new Error('API client not initialized');
        }
        await cancelParityCheck(this.apiConfig);
        this.log('Stopped parity check');
      });

    // Spin up disk action
    this.homey.flow.getActionCard('spin-up-disk')
      .registerRunListener(async (args: Record<string, { id: string; name: string }>) => {
        if (!this.apiConfig) {
          throw new Error('API client not initialized');
        }
        const diskArg = args['disk_name'];
        await spinUpDisk(this.apiConfig, diskArg.id);
        this.log(`Spun up disk: ${diskArg.name}`);
      })
      .registerArgumentAutocompleteListener(
        'disk_name',
        async () => this.getDiskAutocomplete(),
      );

    // Spin down disk action
    this.homey.flow.getActionCard('spin-down-disk')
      .registerRunListener(async (args: Record<string, { id: string; name: string }>) => {
        if (!this.apiConfig) {
          throw new Error('API client not initialized');
        }
        const diskArg = args['disk_name'];
        await spinDownDisk(this.apiConfig, diskArg.id);
        this.log(`Spun down disk: ${diskArg.name}`);
      })
      .registerArgumentAutocompleteListener(
        'disk_name',
        async () => this.getDiskAutocomplete(),
      );

    this.log('Flow cards registered');
  }

  /**
   * Get autocomplete options for containers
   */
  private getContainerAutocomplete(): Array<{ id: string; name: string }> {
    const containers: Array<{ id: string; name: string }> = [];
    this.knownContainers.forEach((container) => {
      containers.push({
        id: container.id,
        name: container.name,
      });
    });
    return containers.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Get autocomplete options for VMs
   */
  private getVMAutocomplete(): Array<{ id: string; name: string }> {
    const vms: Array<{ id: string; name: string }> = [];
    this.knownVMs.forEach((vm) => {
      vms.push({
        id: vm.id,
        name: vm.name,
      });
    });
    return vms.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Get autocomplete options for disks
   */
  private getDiskAutocomplete(): Array<{ id: string; name: string }> {
    const disks: Array<{ id: string; name: string }> = [];
    this.knownDisks.forEach((disk) => {
      disks.push({
        id: disk.id,
        name: disk.name,
      });
    });
    return disks.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Get autocomplete options for data disks only (disks with filesystem usage)
   * Excludes parity disks which don't have filesystem usage data
   */
  private getDataDiskAutocomplete(): Array<{ id: string; name: string; description: string }> {
    const disks: Array<{ id: string; name: string; description: string }> = [];
    this.knownDisks.forEach((disk) => {
      // Only include disks that have filesystem usage data
      if (disk.usagePercent !== null) {
        const usedTB = disk.fsUsed ? Math.round((disk.fsUsed / (1024 ** 4)) * 10) / 10 : 0;
        const sizeTB = disk.fsSize ? Math.round((disk.fsSize / (1024 ** 4)) * 10) / 10 : 0;
        disks.push({
          id: disk.id,
          name: disk.name,
          description: `${Math.round(disk.usagePercent)}% used (${usedTB}/${sizeTB} TB)`,
        });
      }
    });
    return disks.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Trigger parity started flow
   */
  private async triggerParityStarted(progress: number): Promise<void> {
    const parityStartedTrigger = this.homey.flow.getDeviceTriggerCard('parity-started');
    await parityStartedTrigger.trigger(this, { progress });
    this.log('Parity check started flow triggered');
  }

  /**
   * Trigger disk warning flow
   */
  private async triggerDiskWarning(diskName: string, status: string): Promise<void> {
    const diskWarningTrigger = this.homey.flow.getDeviceTriggerCard('disk-warning');
    await diskWarningTrigger.trigger(this, { disk_name: diskName, status });
    this.log(`Disk warning flow triggered for ${diskName}: ${status}`);
  }

  /**
   * Called when device settings are changed
   */
  async onSettings(event: {
    oldSettings: { [key: string]: string | number | boolean | null | undefined };
    newSettings: { [key: string]: string | number | boolean | null | undefined };
    changedKeys: string[];
  }): Promise<string | void> {
    const { newSettings, changedKeys } = event;
    this.log('Settings changed:', changedKeys);

    // If connection settings changed, reinitialize
    if (changedKeys.includes('host') || changedKeys.includes('port') || changedKeys.includes('useHttps')) {
      this.log('Connection settings changed, reinitializing...');
      await this.initializeApiClient();
    }

    // If poll intervals changed, update the poll manager
    if (changedKeys.includes('systemPollInterval') && this.pollManager) {
      const interval = newSettings.systemPollInterval;
      const newInterval = (typeof interval === 'number' ? interval : 30) * 1000;
      // Stop and restart with new interval
      this.pollManager.stop('system');
      this.pollManager.register(
        'system',
        () => this.pollSystemMetrics(),
        {
          baseInterval: newInterval,
          minInterval: POLL_INTERVALS.SYSTEM_METRICS,
          maxInterval: 30000,
          maxRetries: 5,
        },
      );
      this.pollManager.start('system');
    }

    if (changedKeys.includes('storagePollInterval') && this.pollManager) {
      const interval = newSettings.storagePollInterval;
      const newInterval = (typeof interval === 'number' ? interval : 300) * 1000;
      this.pollManager.stop('storage');
      this.pollManager.register(
        'storage',
        () => this.pollStorageMetrics(),
        {
          baseInterval: newInterval,
          minInterval: POLL_INTERVALS.STORAGE,
          maxInterval: 600000,
          maxRetries: 3,
        },
      );
      this.pollManager.start('storage');
    }
  }

  /**
   * Called when the device is deleted
   */
  async onDeleted(): Promise<void> {
    this.log('UnraidServerDevice has been deleted');

    // Stop all polling
    if (this.pollManager) {
      this.pollManager.stopAll();
      this.pollManager = null;
    }

    this.apiConfig = null;
  }

  /**
   * Called when the device is being unloaded
   */
  async onUninit(): Promise<void> {
    this.log('UnraidServerDevice is being uninitialized');

    // Stop all polling
    if (this.pollManager) {
      this.pollManager.stopAll();
      this.pollManager = null;
    }
  }
}

module.exports = UnraidServerDevice;
