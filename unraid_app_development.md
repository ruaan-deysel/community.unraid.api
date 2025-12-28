# Unraid Homey App Development Guide

A comprehensive guide for developers building a Homey app that mirrors the Home Assistant Unraid integration architecture using TypeScript and Zod validation.

## Table of Contents

1. [Overview](#overview)
2. [Architecture Comparison](#architecture-comparison)
3. [Zod Fundamentals](#zod-fundamentals)
4. [Data Models](#data-models)
5. [API Client Implementation](#api-client-implementation)
6. [Device & Capability Mapping](#device--capability-mapping)
7. [Error Handling](#error-handling)
8. [Testing Strategy](#testing-strategy)
9. [Development Workflow](#development-workflow)
10. [Common Pitfalls](#common-pitfalls)

---

## Overview

The Unraid Homey App bridges Homey (home automation platform) with Unraid servers via GraphQL API, similar to the Home Assistant integration but built with TypeScript and Zod for runtime validation.

### Key Differences from Home Assistant Integration

| Aspect | Home Assistant | Homey App |
|--------|---|---|
| **Language** | Python 3.13 | TypeScript 4.5+ |
| **Validation** | Pydantic v2 | Zod |
| **Package Manager** | pip/uv | npm/yarn/pnpm |
| **Config Storage** | Encrypted entry storage | Homey Settings API |
| **Device Class** | Pre-defined HA classes | Custom device types |
| **Polling** | DataUpdateCoordinator | Node.js timers + queue |

### Similarities to Leverage

- ✅ **Same GraphQL API** - Unraid queries remain identical
- ✅ **Same Data Models** - Structure can be mirrored with Zod
- ✅ **Same Validation Philosophy** - Strict schema validation + forward compatibility
- ✅ **Same Error Handling** - Connection errors, auth failures, timeouts
- ✅ **Same Architecture Pattern** - Coordinator-like polling with separate intervals

---

## Architecture Comparison

### Home Assistant: Pydantic Model → Runtime Validation

```python
class UnraidBaseModel(BaseModel):
    """Base model that ignores unknown fields for forward compatibility."""
    model_config = ConfigDict(extra="ignore", populate_by_name=True)

class SystemInfo(UnraidBaseModel):
    time: datetime | None = None
    system: InfoSystem = InfoSystem()
    cpu: InfoCpu = InfoCpu()
    # ... nested models
```

**Benefits in Python:**
- Type hints at definition
- Runtime validation on instantiation
- Forward compatibility (ignores unknown fields)
- Automatic JSON serialization

### Homey App: Zod Schema → Runtime Validation

```typescript
// Homey equivalent
const UnraidBaseSchema = z.object({}).passthrough(); // Ignores unknown fields

const SystemInfoSchema = z.object({
  time: z.coerce.date().nullable().optional(),
  system: InfoSystemSchema,
  cpu: InfoCpuSchema,
  // ... nested schemas
});

type SystemInfo = z.infer<typeof SystemInfoSchema>;
```

**Benefits in TypeScript:**
- Schema separate from type definition
- `z.infer<T>` extracts TypeScript type
- `.passthrough()` provides forward compatibility
- Explicit parsing required for validation

---

## Zod Fundamentals

### Why Zod for Homey?

1. **Runtime Validation** - Validates actual GraphQL responses at runtime
2. **Type Safety** - TypeScript types inferred from schemas
3. **Forward Compatibility** - Can ignore unknown fields (like Pydantic's `extra="ignore"`)
4. **Composability** - Schemas can extend/compose like Python inheritance
5. **Error Details** - Detailed validation error information for debugging
6. **No Decorators** - More pragmatic than class-based approaches

### Basic Zod Patterns

```typescript
import { z } from 'zod';

// Simple schema
const StringSchema = z.string();
const NumberSchema = z.number();
const DateSchema = z.coerce.date(); // Converts string to Date

// Optional values (like `int | None` in Python)
const OptionalSchema = z.string().optional(); // undefined allowed
const NullableSchema = z.string().nullable();  // null allowed
const NullableOptionalSchema = z.string().nullable().optional(); // both

// Enums (like Python Enum)
const ArrayStateEnum = z.enum(['STARTED', 'STOPPED']);

// Objects (like Python dataclass/BaseModel)
const PersonSchema = z.object({
  name: z.string(),
  age: z.number().int().positive(),
});

// Arrays
const PeopleSchema = z.array(PersonSchema);

// Type extraction
type Person = z.infer<typeof PersonSchema>;
```

### Forward Compatibility with Passthrough

```typescript
// Pydantic equivalent: ConfigDict(extra="ignore")
const BaseSchema = z.object({
  required_field: z.string(),
}).passthrough(); // ✅ Ignores unknown fields like Pydantic

const data = {
  required_field: 'value',
  future_field: 'ignored'
};
const parsed = BaseSchema.parse(data); // ✅ Parses successfully
```

---

## Data Models

### Project Structure

```
src/
├── schemas/
│   ├── base.ts              # Base schema (passthrough)
│   ├── system.ts            # SystemInfo, InfoCpu, InfoOs, etc.
│   ├── metrics.ts           # Metrics, CpuUtilization, MemoryUtilization
│   ├── array.ts             # Array, ArrayDisk, ParityCheck
│   ├── docker.ts            # DockerContainer, ContainerPort
│   ├── vm.ts                # VmDomain
│   ├── ups.ts               # UPSDevice, UPSBattery, UPSPower
│   └── share.ts             # Share
├── types.ts                 # Extracted types from schemas
├── api/
│   ├── client.ts            # UnraidAPIClient
│   └── queries.ts           # GraphQL query strings
└── devices/
    ├── system.ts            # System device + capabilities
    ├── docker.ts            # Docker container devices
    ├── vm.ts                # VM devices
    └── ups.ts               # UPS devices
```

### Base Schema (Forward Compatibility)

**File: `src/schemas/base.ts`**

```typescript
import { z } from 'zod';

/**
 * Base schema with passthrough to ignore unknown fields.
 * Mirrors Pydantic's ConfigDict(extra="ignore").
 *
 * This ensures the app doesn't break when Unraid API adds new fields.
 */
export const UnraidBaseSchema = z.object({}).passthrough();

/**
 * Helper for extending base schema while maintaining passthrough.
 *
 * Usage:
 *   const MySchema = extendBaseSchema(z.object({
 *     field: z.string(),
 *   }));
 */
export function extendBaseSchema<T extends z.ZodTypeAny>(schema: T): T {
  // Note: Zod's passthrough should be applied to the final object
  // This is a convenience helper
  return schema as T;
}
```

### System Models

**File: `src/schemas/system.ts`**

```typescript
import { z } from 'zod';
import { UnraidBaseSchema } from './base';

// DateTime parsing helper (mirrors Python's _parse_datetime)
const DateTimeSchema = z.union([
  z.date(),
  z.string().transform((val) => {
    const normalized = val.endsWith('Z')
      ? val.replace('Z', '+00:00')
      : val;
    return new Date(normalized);
  }),
]).nullable().optional();

// InfoSystem: manufacturer, model, version, serial, UUID
export const InfoSystemSchema = UnraidBaseSchema.merge(z.object({
  uuid: z.string().nullable().optional(),
  manufacturer: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  version: z.string().nullable().optional(),
  serial: z.string().nullable().optional(),
}));
export type InfoSystem = z.infer<typeof InfoSystemSchema>;

// CPU information
export const CpuPackagesSchema = UnraidBaseSchema.merge(z.object({
  temp: z.array(z.number()).default([]),
  totalPower: z.number().nullable().optional(),
}));
export type CpuPackages = z.infer<typeof CpuPackagesSchema>;

export const InfoCpuSchema = UnraidBaseSchema.merge(z.object({
  brand: z.string().nullable().optional(),
  threads: z.number().int().nullable().optional(),
  cores: z.number().int().nullable().optional(),
  packages: CpuPackagesSchema.default({}),
}));
export type InfoCpu = z.infer<typeof InfoCpuSchema>;

// OS information
const UptimeSchema = z.union([
  z.date(),
  z.string().transform((val) => {
    const normalized = val.endsWith('Z')
      ? val.replace('Z', '+00:00')
      : val;
    return new Date(normalized);
  }),
]).nullable().optional();

export const InfoOsSchema = UnraidBaseSchema.merge(z.object({
  hostname: z.string().nullable().optional(),
  uptime: UptimeSchema,
  kernel: z.string().nullable().optional(),
}));
export type InfoOs = z.infer<typeof InfoOsSchema>;

// Version information
export const CoreVersionsSchema = UnraidBaseSchema.merge(z.object({
  unraid: z.string().nullable().optional(),
  api: z.string().nullable().optional(),
  kernel: z.string().nullable().optional(),
}));
export type CoreVersions = z.infer<typeof CoreVersionsSchema>;

export const InfoVersionsSchema = UnraidBaseSchema.merge(z.object({
  core: CoreVersionsSchema.default({}),
}));
export type InfoVersions = z.infer<typeof InfoVersionsSchema>;

// Complete SystemInfo
export const SystemInfoSchema = UnraidBaseSchema.merge(z.object({
  time: DateTimeSchema,
  system: InfoSystemSchema.default({}),
  cpu: InfoCpuSchema.default({}),
  os: InfoOsSchema.default({}),
  versions: InfoVersionsSchema.default({}),
}));
export type SystemInfo = z.infer<typeof SystemInfoSchema>;
```

### Array Models

**File: `src/schemas/array.ts`**

```typescript
import { z } from 'zod';
import { UnraidBaseSchema } from './base';

export const CapacityKilobytesSchema = UnraidBaseSchema.merge(z.object({
  total: z.number().int(),
  used: z.number().int(),
  free: z.number().int(),
}));
export type CapacityKilobytes = z.infer<typeof CapacityKilobytesSchema>;

export const ArrayCapacitySchema = UnraidBaseSchema.merge(z.object({
  kilobytes: CapacityKilobytesSchema,
})).transform((data) => ({
  ...data,
  // Computed properties (like Python @property)
  totalBytes: data.kilobytes.total * 1024,
  usedBytes: data.kilobytes.used * 1024,
  freeBytes: data.kilobytes.free * 1024,
  usagePercent: data.kilobytes.total
    ? (data.kilobytes.used / data.kilobytes.total) * 100
    : 0,
}));
export type ArrayCapacity = z.infer<typeof ArrayCapacitySchema>;

export const ParityCheckSchema = UnraidBaseSchema.merge(z.object({
  status: z.string().nullable().optional(),
  progress: z.number().int().nullable().optional(),
  errors: z.number().int().nullable().optional(),
}));
export type ParityCheck = z.infer<typeof ParityCheckSchema>;

export const ArrayDiskSchema = UnraidBaseSchema.merge(z.object({
  id: z.string(),
  idx: z.number().int().nullable().optional(),
  device: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  type: z.string().nullable().optional(),
  size: z.number().int().nullable().optional(),
  fsSize: z.number().int().nullable().optional(),
  fsUsed: z.number().int().nullable().optional(),
  fsFree: z.number().int().nullable().optional(),
  fsType: z.string().nullable().optional(),
  temp: z.number().int().nullable().optional(),
  status: z.string().nullable().optional(),
  isSpinning: z.boolean().nullable().optional(),
  smartStatus: z.string().nullable().optional(),
})).transform((disk) => ({
  ...disk,
  // Computed properties
  sizeBytes: disk.size ? disk.size * 1024 : null,
  fsSizeBytes: disk.fsSize ? disk.fsSize * 1024 : null,
  fsUsedBytes: disk.fsUsed ? disk.fsUsed * 1024 : null,
  fsFreeByte: disk.fsFree ? disk.fsFree * 1024 : null,
  usagePercent: disk.fsSize && disk.fsUsed
    ? (disk.fsUsed / disk.fsSize) * 100
    : null,
}));
export type ArrayDisk = z.infer<typeof ArrayDiskSchema>;

export const UnraidArraySchema = UnraidBaseSchema.merge(z.object({
  state: z.string().nullable().optional(),
  capacity: ArrayCapacitySchema,
  parityCheckStatus: ParityCheckSchema.default({}),
  disks: z.array(ArrayDiskSchema).default([]),
  parities: z.array(ArrayDiskSchema).default([]),
  caches: z.array(ArrayDiskSchema).default([]),
}));
export type UnraidArray = z.infer<typeof UnraidArraySchema>;
```

### Docker & VM Models

**File: `src/schemas/docker.ts`**

```typescript
import { z } from 'zod';
import { UnraidBaseSchema } from './base';

export const ContainerPortSchema = UnraidBaseSchema.merge(z.object({
  privatePort: z.number().int().nullable().optional(),
  publicPort: z.number().int().nullable().optional(),
  type: z.string().nullable().optional(),
}));
export type ContainerPort = z.infer<typeof ContainerPortSchema>;

export const DockerContainerSchema = UnraidBaseSchema.merge(z.object({
  id: z.string(),
  name: z.string(),
  state: z.string().nullable().optional(),
  image: z.string().nullable().optional(),
  webUiUrl: z.string().url().nullable().optional(),
  iconUrl: z.string().url().nullable().optional(),
  ports: z.array(ContainerPortSchema).default([]),
}));
export type DockerContainer = z.infer<typeof DockerContainerSchema>;
```

**File: `src/schemas/vm.ts`**

```typescript
import { z } from 'zod';
import { UnraidBaseSchema } from './base';

export const VmDomainSchema = UnraidBaseSchema.merge(z.object({
  id: z.string(),
  name: z.string(),
  state: z.string().nullable().optional(),
  memory: z.number().int().nullable().optional(),
  vcpu: z.number().int().nullable().optional(),
}));
export type VmDomain = z.infer<typeof VmDomainSchema>;
```

---

## API Client Implementation

### GraphQL Query Definitions

**File: `src/api/queries.ts`**

```typescript
/**
 * GraphQL queries for Unraid API
 *
 * Important: Keep these in sync with the Home Assistant integration specs:
 * - /specs/001-unraid-graphql-integration/contracts/queries.graphql
 */

export const SYSTEM_INFO_QUERY = `
  query SystemInfo {
    info {
      time
      system { uuid manufacturer model version serial }
      cpu { brand threads cores packages { temp totalPower } }
      os { hostname uptime kernel }
      versions { core { unraid api kernel } }
    }
  }
`;

export const METRICS_QUERY = `
  query Metrics {
    metrics {
      cpu { percentTotal }
      memory {
        total used free available percentTotal
        swapTotal swapUsed percentSwapTotal
      }
    }
  }
`;

export const ARRAY_QUERY = `
  query Array {
    array {
      state
      capacity { kilobytes { total used free } }
      parityCheckStatus { status progress errors }
      disks {
        id idx device name type size fsSize fsUsed fsFree fsType
        temp status isSpinning smartStatus
      }
      parities { id idx device name type ... }
      caches { id idx device name type ... }
    }
  }
`;

export const DOCKER_QUERY = `
  query Docker {
    docker {
      containers {
        id name state image webUiUrl iconUrl
        ports { privatePort publicPort type }
      }
    }
  }
`;

export const VMS_QUERY = `
  query Vms {
    vms {
      domains {
        id name state memory vcpu
      }
    }
  }
`;
```

### API Client Class

**File: `src/api/client.ts`**

```typescript
import { z } from 'zod';
import { SystemInfoSchema } from '../schemas/system';
import { MetricsSchema } from '../schemas/metrics';
import { UnraidArraySchema } from '../schemas/array';
import { DockerContainerSchema } from '../schemas/docker';
import { VmDomainSchema } from '../schemas/vm';
import { SYSTEM_INFO_QUERY, METRICS_QUERY, ARRAY_QUERY, DOCKER_QUERY, VMS_QUERY } from './queries';

export class UnraidAPIClient {
  private host: string;
  private port: number;
  private apiKey: string;
  private verifySsl: boolean;
  private timeout: number = 30000; // 30 seconds

  constructor(options: {
    host: string;
    port?: number;
    apiKey: string;
    verifySsl?: boolean;
  }) {
    this.host = options.host;
    this.port = options.port || 443;
    this.apiKey = options.apiKey;
    this.verifySsl = options.verifySsl !== false;
  }

  /**
   * Test connection to Unraid server
   * @throws UnraidConnectionError if connection fails
   * @throws UnraidAuthError if API key is invalid
   */
  async testConnection(): Promise<void> {
    try {
      await this.query(SYSTEM_INFO_QUERY);
    } catch (err) {
      if (err instanceof UnraidAuthError) {
        throw err; // Re-throw auth errors
      }
      throw new UnraidConnectionError(
        `Failed to connect to ${this.host}:${this.port}`,
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  /**
   * Execute GraphQL query against Unraid API
   * @param query GraphQL query string
   * @returns Raw GraphQL response
   * @throws UnraidError subclasses for various failures
   */
  async query<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const url = `https://${this.host}:${this.port}/graphql`;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
        // Note: Node.js fetch with SSL verification would be:
        // agent: new https.Agent({ rejectUnauthorized: this.verifySsl })
      });

      clearTimeout(timeoutId);

      if (response.status === 401 || response.status === 403) {
        throw new UnraidAuthError('Invalid API key or unauthorized access');
      }

      if (!response.ok) {
        throw new UnraidConnectionError(
          `HTTP ${response.status}`,
          await response.text()
        );
      }

      const data = await response.json();

      if (data.errors) {
        throw new UnraidGraphQLError(
          'GraphQL error',
          data.errors
        );
      }

      return data.data;
    } catch (err) {
      if (err instanceof UnraidError) {
        throw err;
      }

      if (err instanceof Error) {
        if (err.name === 'AbortError') {
          throw new UnraidTimeoutError(`Query timeout after ${this.timeout}ms`);
        }
        throw new UnraidConnectionError('Query failed', err.message);
      }

      throw new UnraidConnectionError('Unknown error', String(err));
    }
  }

  /**
   * Get system information with validated schema
   */
  async getSystemInfo() {
    const data = await this.query(SYSTEM_INFO_QUERY);
    return SystemInfoSchema.parse(data.info);
  }

  /**
   * Get metrics with validated schema
   */
  async getMetrics() {
    const data = await this.query(METRICS_QUERY);
    return MetricsSchema.parse(data.metrics);
  }

  /**
   * Get array information with validated schema
   */
  async getArray() {
    const data = await this.query(ARRAY_QUERY);
    return UnraidArraySchema.parse(data.array);
  }

  /**
   * Get Docker containers with validated schema
   */
  async getContainers() {
    const data = await this.query(DOCKER_QUERY);
    return z.array(DockerContainerSchema).parse(data.docker.containers);
  }

  /**
   * Get VMs with validated schema
   */
  async getVms() {
    const data = await this.query(VMS_QUERY);
    return z.array(VmDomainSchema).parse(data.vms.domains);
  }
}

// Custom error classes
export class UnraidError extends Error {
  constructor(message: string, public readonly details?: unknown) {
    super(message);
    this.name = 'UnraidError';
  }
}

export class UnraidConnectionError extends UnraidError {
  constructor(message: string, details?: unknown) {
    super(message, details);
    this.name = 'UnraidConnectionError';
  }
}

export class UnraidAuthError extends UnraidError {
  constructor(message: string = 'Authentication failed') {
    super(message);
    this.name = 'UnraidAuthError';
  }
}

export class UnraidTimeoutError extends UnraidError {
  constructor(message: string = 'Request timeout') {
    super(message);
    this.name = 'UnraidTimeoutError';
  }
}

export class UnraidGraphQLError extends UnraidError {
  constructor(message: string, public readonly graphqlErrors: unknown[]) {
    super(message, graphqlErrors);
    this.name = 'UnraidGraphQLError';
  }
}
```

---

## Device & Capability Mapping

### Device Type Pattern

Similar to Home Assistant entities, Homey devices represent monitored/controlled items.

**File: `src/devices/system.ts`**

```typescript
import Homey from 'homey';
import { UnraidAPIClient, UnraidAuthError, UnraidConnectionError } from '../api/client';
import { SystemInfo } from '../schemas/system';

/**
 * System device: Represents the Unraid server itself
 *
 * Capabilities:
 * - measure_cpu: CPU usage percentage
 * - measure_memory: RAM usage percentage
 * - measure_temperature: CPU temperature
 * - alarm_connected: Connection status
 */
export class UnraidSystemDevice extends Homey.Device {
  private client: UnraidAPIClient | null = null;
  private pollingInterval: NodeJS.Timer | null = null;
  private lastUpdate: Date | null = null;

  async onInit() {
    this.log('System device initialized');

    // Get API client from driver
    const driver = this.getDriver() as UnraidSystemDriver;
    this.client = driver.getApiClient();

    if (!this.client) {
      throw new Error('API client not initialized');
    }

    // Set initial capability values
    await this.updateCapabilities();

    // Start polling (30 second interval, like HA)
    this.startPolling();
  }

  async onDeleted() {
    this.stopPolling();
    this.log('System device deleted');
  }

  private startPolling() {
    if (this.pollingInterval) return;

    this.pollingInterval = setInterval(() => {
      this.updateCapabilities().catch((err) => {
        this.error('Update failed:', err);
      });
    }, 30000);

    this.log('Polling started (30s interval)');
  }

  private stopPolling() {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
      this.log('Polling stopped');
    }
  }

  private async updateCapabilities() {
    if (!this.client) return;

    try {
      const [systemInfo, metrics] = await Promise.all([
        this.client.getSystemInfo(),
        this.client.getMetrics(),
      ]);

      // Update CPU usage
      if (metrics.cpu.percentTotal !== null && metrics.cpu.percentTotal !== undefined) {
        await this.setCapabilityValue('measure_cpu', metrics.cpu.percentTotal);
      }

      // Update memory usage
      if (metrics.memory.percentTotal !== null && metrics.memory.percentTotal !== undefined) {
        await this.setCapabilityValue('measure_memory', metrics.memory.percentTotal);
      }

      // Update temperature (first CPU package temp)
      const temp = systemInfo.cpu.packages.temp[0];
      if (temp) {
        await this.setCapabilityValue('measure_temperature', temp);
      }

      // Connection status (if we get here, connection is OK)
      await this.setCapabilityValue('alarm_connected', false);

      this.lastUpdate = new Date();
    } catch (err) {
      this.error('Failed to update:', err);

      // Set alarm if connection fails
      if (err instanceof UnraidConnectionError || err instanceof UnraidAuthError) {
        await this.setCapabilityValue('alarm_connected', true);
      }
    }
  }

  getLastUpdate(): Date | null {
    return this.lastUpdate;
  }
}

/**
 * System driver: Manages system device lifecycle
 */
export class UnraidSystemDriver extends Homey.Driver {
  private client: UnraidAPIClient | null = null;

  async onInit() {
    this.log('System driver initialized');
  }

  async onPair(session: Homey.Driver.PairSession) {
    session.setHandler('login', async (credentials) => {
      try {
        this.client = new UnraidAPIClient({
          host: credentials.host,
          port: credentials.port || 443,
          apiKey: credentials.apiKey,
          verifySsl: credentials.verifySsl !== false,
        });

        await this.client.testConnection();

        return true;
      } catch (err) {
        this.error('Login failed:', err);
        throw err;
      }
    });

    session.setHandler('list_devices', async () => {
      if (!this.client) {
        throw new Error('Not authenticated');
      }

      const systemInfo = await this.client.getSystemInfo();
      const hostname = systemInfo.os.hostname || 'Unraid Server';

      return [
        {
          name: hostname,
          data: {
            id: systemInfo.system.uuid || 'default',
          },
          settings: {
            host: credentials.host,
            port: credentials.port || 443,
            apiKey: credentials.apiKey,
          },
        },
      ];
    });
  }

  getApiClient(): UnraidAPIClient | null {
    return this.client;
  }
}
```

### Docker Container Device

**File: `src/devices/docker.ts`**

```typescript
import Homey from 'homey';
import { UnraidAPIClient } from '../api/client';
import { DockerContainer } from '../schemas/docker';

/**
 * Docker device: Represents a container
 *
 * Capabilities:
 * - onoff: Container running state (read-only)
 */
export class UnraidDockerDevice extends Homey.Device {
  private client: UnraidAPIClient | null = null;
  private containerId: string = '';

  async onInit() {
    const driver = this.getDriver() as UnraidDockerDriver;
    this.client = driver.getApiClient();
    this.containerId = this.getData().id;

    // Register action handlers
    this.registerCapabilityListener('onoff', this.onCapabilityOnoff.bind(this));

    await this.updateState();
  }

  private async onCapabilityOnoff(value: boolean) {
    if (!this.client) throw new Error('API client not available');

    // TODO: Implement Docker start/stop mutations
    // This would require GraphQL mutations in the Unraid API
  }

  private async updateState() {
    if (!this.client) return;

    try {
      const containers = await this.client.getContainers();
      const container = containers.find((c) => c.id === this.containerId);

      if (!container) {
        this.setUnavailable('Container not found');
        return;
      }

      const isRunning = container.state === 'RUNNING';
      await this.setCapabilityValue('onoff', isRunning);
      this.setAvailable();
    } catch (err) {
      this.error('Failed to update:', err);
      this.setUnavailable(err instanceof Error ? err.message : 'Update failed');
    }
  }
}
```

---

## Error Handling

### Error Hierarchy

```typescript
UnraidError (base)
├── UnraidConnectionError   (network/connection issues)
├── UnraidAuthError         (API key invalid, 401/403)
├── UnraidTimeoutError      (request timeout)
└── UnraidGraphQLError      (GraphQL errors from API)
```

### Usage Pattern

```typescript
try {
  const systemInfo = await client.getSystemInfo();
} catch (err) {
  if (err instanceof UnraidAuthError) {
    // Handle auth failure - show re-authentication flow
    this.error('API key invalid');
  } else if (err instanceof UnraidConnectionError) {
    // Handle network issues - show connection status
    this.error('Cannot reach Unraid server');
  } else if (err instanceof UnraidTimeoutError) {
    // Handle timeout - may retry
    this.error('Request took too long');
  } else if (err instanceof UnraidGraphQLError) {
    // Handle GraphQL errors - log for debugging
    this.error('GraphQL error:', (err as UnraidGraphQLError).graphqlErrors);
  }
}
```

---

## Testing Strategy

### Unit Tests with Zod Validation

**File: `tests/schemas.test.ts`**

```typescript
import { describe, it, expect } from '@jest/globals';
import { SystemInfoSchema } from '../src/schemas/system';
import { UnraidArraySchema } from '../src/schemas/array';

describe('Schema Validation', () => {
  describe('SystemInfo', () => {
    it('should parse valid system info', () => {
      const data = {
        time: '2025-12-28T10:30:00Z',
        system: { uuid: 'abc-123' },
        cpu: { brand: 'AMD Ryzen', threads: 16 },
        os: { hostname: 'tower' },
        versions: { core: { unraid: '7.2.0' } },
      };

      const parsed = SystemInfoSchema.parse(data);
      expect(parsed.system.uuid).toBe('abc-123');
      expect(parsed.cpu.brand).toBe('AMD Ryzen');
    });

    it('should handle missing optional fields', () => {
      const data = {
        system: {},
        cpu: {},
        os: {},
        versions: { core: {} },
      };

      const parsed = SystemInfoSchema.parse(data);
      expect(parsed.system.uuid).toBeUndefined();
      expect(parsed.cpu.brand).toBeUndefined();
    });

    it('should ignore unknown fields (forward compatibility)', () => {
      const data = {
        system: { uuid: 'abc-123', futureField: 'ignored' },
        cpu: {},
        os: {},
        versions: { core: {} },
      };

      // Should not throw
      const parsed = SystemInfoSchema.parse(data);
      expect(parsed.system.uuid).toBe('abc-123');
      expect((parsed.system as any).futureField).toBeUndefined();
    });
  });

  describe('Array capacity calculations', () => {
    it('should calculate bytes from kilobytes', () => {
      const data = {
        capacity: {
          kilobytes: { total: 1000, used: 400, free: 600 },
        },
      };

      const array = UnraidArraySchema.parse(data);
      expect(array.capacity.totalBytes).toBe(1000 * 1024);
      expect(array.capacity.usedBytes).toBe(400 * 1024);
      expect(array.capacity.usagePercent).toBe(40);
    });
  });
});
```

### Integration Tests with Mock API

**File: `tests/api.test.ts`**

```typescript
import { describe, it, expect, beforeEach } from '@jest/globals';
import { UnraidAPIClient, UnraidAuthError, UnraidConnectionError } from '../src/api/client';

describe('UnraidAPIClient', () => {
  let client: UnraidAPIClient;

  beforeEach(() => {
    client = new UnraidAPIClient({
      host: 'localhost',
      port: 8006,
      apiKey: 'test-key',
      verifySsl: false,
    });
  });

  it('should throw UnraidAuthError on 401', async () => {
    // Mock fetch to return 401
    global.fetch = jest.fn(() =>
      Promise.resolve(new Response('Unauthorized', { status: 401 }))
    ) as jest.Mock;

    await expect(client.testConnection()).rejects.toThrow(UnraidAuthError);
  });

  it('should throw UnraidTimeoutError on abort', async () => {
    global.fetch = jest.fn(() =>
      Promise.reject(new DOMException('Aborted', 'AbortError'))
    ) as jest.Mock;

    await expect(client.testConnection()).rejects.toThrow('timeout');
  });

  it('should parse and validate responses', async () => {
    const mockResponse = {
      data: {
        info: {
          time: '2025-12-28T10:30:00Z',
          system: { uuid: 'test-uuid' },
          cpu: { brand: 'AMD' },
          os: { hostname: 'test-host' },
          versions: { core: { unraid: '7.2.0' } },
        },
      },
    };

    global.fetch = jest.fn(() =>
      Promise.resolve(new Response(JSON.stringify(mockResponse)))
    ) as jest.Mock;

    const info = await client.getSystemInfo();
    expect(info.system.uuid).toBe('test-uuid');
  });
});
```

---

## Development Workflow

### Project Setup

```bash
# Initialize Homey app
homey create app unraid-app

# Install dependencies
npm install zod
npm install --save-dev jest @types/jest ts-jest typescript

# Create directory structure
mkdir -p src/{schemas,api,devices}
mkdir -p tests/fixtures
```

### Building & Testing

```bash
# Format code
npm run format

# Lint
npm run lint

# Type check
npm run type-check

# Run tests
npm run test

# Run tests with coverage
npm run test:coverage

# Build for Homey
homey app build

# Test in Homey simulator
homey app run
```

### Configuration File

**File: `package.json`**

```json
{
  "name": "unraid-homey-app",
  "version": "2025.12.0",
  "description": "Unraid integration for Homey",
  "scripts": {
    "format": "prettier --write src tests",
    "lint": "eslint src tests --ext .ts",
    "type-check": "tsc --noEmit",
    "test": "jest",
    "test:coverage": "jest --coverage",
    "build": "tsc",
    "homey:build": "homey app build",
    "homey:run": "homey app run"
  },
  "dependencies": {
    "zod": "^3.22.0"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "@typescript-eslint/eslint-plugin": "^6.0.0",
    "eslint": "^8.0.0",
    "jest": "^29.0.0",
    "prettier": "^3.0.0",
    "typescript": "^5.3.0"
  }
}
```

**File: `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "lib": ["ES2020"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "tests", "dist"]
}
```

---

## Common Pitfalls

### 1. ❌ Missing Passthrough in Nested Schemas

```typescript
// ❌ WRONG: Nested schema loses passthrough
const PersonSchema = z.object({
  name: z.string(),
  address: z.object({
    street: z.string(),
    futureField: z.unknown().optional(), // Explicit handling needed
  }),
});

// ✅ CORRECT: Use extendBaseSchema or merge
const AddressSchema = UnraidBaseSchema.merge(z.object({
  street: z.string(),
}));

const PersonSchema = UnraidBaseSchema.merge(z.object({
  name: z.string(),
  address: AddressSchema,
}));
```

### 2. ❌ Not Handling Nullable vs Optional

```typescript
// ❌ WRONG: These are different!
const A = z.string().optional();        // undefined allowed, null not
const B = z.string().nullable();        // null allowed, undefined not
const C = z.string().nullable().optional(); // both allowed

// ✅ CORRECT: Match Python's `Type | None`
const PythonOptional = z.string().nullable().optional();
```

### 3. ❌ Forgetting to Validate GraphQL Responses

```typescript
// ❌ WRONG: No validation - loses type safety
async getSystemInfo() {
  const data = await this.query(SYSTEM_INFO_QUERY);
  return data.info; // Any unknown structure!
}

// ✅ CORRECT: Validate with schema
async getSystemInfo() {
  const data = await this.query(SYSTEM_INFO_QUERY);
  return SystemInfoSchema.parse(data.info); // Type-safe + validated
}
```

### 4. ❌ Not Handling Computed Properties

```typescript
// ❌ WRONG: Can't calculate in schema
const DiskSchema = z.object({
  size: z.number(),
  sizeBytes: z.number(), // How to calculate?
});

// ✅ CORRECT: Use .transform()
const DiskSchema = UnraidBaseSchema.merge(z.object({
  size: z.number(),
})).transform((disk) => ({
  ...disk,
  sizeBytes: disk.size * 1024,
}));
```

### 5. ❌ Mixing Camel/Snake Case

```typescript
// ❌ WRONG: Zod doesn't auto-convert case
const Schema = z.object({
  totalPower: z.number(), // GraphQL returns totalPower
});

// ✅ CORRECT: If needed, use .transform()
const Schema = UnraidBaseSchema.merge(z.object({
  totalPower: z.number(), // Keep GraphQL field names
}));
```

### 6. ❌ Not Setting Polling Intervals Like HA

```typescript
// ❌ WRONG: No interval pattern
setInterval(() => update(), 5000);

// ✅ CORRECT: Separate intervals like HA coordinators
// System metrics: 30 seconds (responsive)
// Storage data: 5 minutes (expensive SMART queries)
const SYSTEM_POLL_INTERVAL = 30000;
const STORAGE_POLL_INTERVAL = 300000;
```

### 7. ❌ Forgetting Error Class Checks

```typescript
// ❌ WRONG: Generic error handling
try {
  await client.getSystemInfo();
} catch (err) {
  showError('Failed');
}

// ✅ CORRECT: Check error type
try {
  await client.getSystemInfo();
} catch (err) {
  if (err instanceof UnraidAuthError) {
    showAuthFlow();
  } else if (err instanceof UnraidConnectionError) {
    showConnectionStatus();
  } else if (err instanceof UnraidTimeoutError) {
    retry(); // May retry automatically
  }
}
```

---

## Key Takeaways

| Python (Home Assistant) | TypeScript (Homey) | Key Concept |
|---|---|---|
| Pydantic BaseModel | Zod schema + `.infer<T>` | Type + validation together |
| `ConfigDict(extra="ignore")` | `.passthrough()` | Forward compatibility |
| `@field_validator` | `.transform()` | Custom transforms/validation |
| `dataclass @property` | `.transform()` with fields | Computed properties |
| `\| None` | `.nullable().optional()` | Nullable/optional handling |
| DataUpdateCoordinator | Polling interval timers | Separate polling rates |
| Exception hierarchy | Custom error classes | Type-safe error handling |
| pytest fixtures | Jest mocks + fixtures | Test data patterns |

---

## Resources

- **Zod Documentation**: https://zod.dev/
- **Homey SDK**: https://developers.homey.app/
- **GraphQL**: https://graphql.org/learn/
- **TypeScript**: https://www.typescriptlang.org/docs/
- **HA Integration Reference**: `/specs/001-unraid-graphql-integration/`

---

## Questions & Support

For questions about adapting the Unraid HA integration to Homey:

1. Review the HA integration's GraphQL queries in `specs/001-unraid-graphql-integration/contracts/queries.graphql`
2. Ensure Zod schemas match Python model structure
3. Use `.passthrough()` for forward compatibility
4. Test schema validation with fixture data
5. Follow the error class hierarchy for proper exception handling

Good luck building the Homey app! 🚀

