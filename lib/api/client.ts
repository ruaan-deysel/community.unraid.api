'use strict';

import { z } from 'zod';
import https from 'https';
import http from 'http';
import {
  UnraidApiError,
  GraphQLResponseSchema,
  type ErrorCode,
} from '../schemas/errors';

/**
 * Configuration for the Unraid API client
 */
export interface UnraidClientConfig {
  /** Unraid server host (IP or hostname) */
  host: string;
  /** API key for authentication */
  apiKey: string;
  /** Connection timeout in milliseconds (default: 10000) */
  timeout?: number;
  /** Whether to use HTTPS (default: true) */
  useHttps?: boolean;
  /** Port number (default: 443 for HTTPS, 80 for HTTP) */
  port?: number;
  /** Allow self-signed certificates (default: true) */
  allowSelfSigned?: boolean;
}

/**
 * Response from executeQuery
 */
export interface QueryResult<T> {
  data: T;
  errors?: Array<{ message: string }>;
}

// Cache for discovered redirect URLs
const redirectUrlCache = new Map<string, string>();

/**
 * Create an error based on HTTP status code
 */
function createHttpError(status: number, statusText: string): UnraidApiError {
  const errorMap: Record<number, { code: ErrorCode; retryable: boolean }> = {
    401: { code: 'AUTHENTICATION_ERROR', retryable: false },
    403: { code: 'AUTHENTICATION_ERROR', retryable: false },
    404: { code: 'RESOURCE_NOT_FOUND', retryable: false },
    429: { code: 'RATE_LIMITED', retryable: true },
    500: { code: 'SERVER_ERROR', retryable: true },
    502: { code: 'SERVER_ERROR', retryable: true },
    503: { code: 'SERVER_ERROR', retryable: true },
    504: { code: 'TIMEOUT_ERROR', retryable: true },
  };
  
  const mapped = errorMap[status] ?? { code: 'UNKNOWN_ERROR' as ErrorCode, retryable: false };
  
  return new UnraidApiError({
    code: mapped.code,
    message: `HTTP ${status}: ${statusText}`,
    details: { status },
    retryable: mapped.retryable,
  });
}

/**
 * Map GraphQL error to error code
 */
function mapGraphQLErrorCode(error: { message: string; extensions?: Record<string, unknown> }): ErrorCode {
  const code = error.extensions?.code as string | undefined;
  
  const codeMap: Record<string, ErrorCode> = {
    'UNAUTHENTICATED': 'AUTHENTICATION_ERROR',
    'FORBIDDEN': 'AUTHENTICATION_ERROR',
    'NOT_FOUND': 'RESOURCE_NOT_FOUND',
    'INTERNAL_SERVER_ERROR': 'SERVER_ERROR',
    'BAD_USER_INPUT': 'VALIDATION_ERROR',
  };
  
  if (code && codeMap[code]) {
    return codeMap[code];
  }
  
  // Try to infer from message
  const message = error.message.toLowerCase();
  if (message.includes('not found')) return 'RESOURCE_NOT_FOUND';
  if (message.includes('unauthorized') || message.includes('authentication')) return 'AUTHENTICATION_ERROR';
  if (message.includes('timeout')) return 'TIMEOUT_ERROR';
  
  return 'OPERATION_FAILED';
}

/**
 * Parse a URL string into its components
 */
function parseUrl(urlString: string): { hostname: string; port: number; protocol: string; path: string } | null {
  try {
    const match = urlString.match(/^(https?):\/\/([^:/]+)(?::(\d+))?(\/.*)?$/);
    if (!match) return null;
    
    const [, protocol, hostname, portStr, path] = match;
    const defaultPort = protocol === 'https' ? 443 : 80;
    const port = portStr ? parseInt(portStr, 10) : defaultPort;
    
    return { hostname, port, protocol, path: path || '/' };
  } catch {
    return null;
  }
}

/**
 * Discover redirect URL by making HTTP request to port 80
 * Unraid often redirects HTTP -> myunraid.net cloud URL
 */
function discoverRedirectUrl(host: string, timeout: number): Promise<string | null> {
  return new Promise((resolve) => {
    // Skip if host is empty
    if (!host || host.trim() === '') {
      resolve(null);
      return;
    }
    
    const options: http.RequestOptions = {
      hostname: host.trim(),
      port: 80,
      path: '/graphql',
      method: 'GET',
    };
    
    let req: http.ClientRequest | null = null;
    
    // eslint-disable-next-line homey-app/global-timers
    const timeoutId = setTimeout(() => {
      if (req) req.destroy();
      resolve(null);
    }, timeout);
    
    req = http.request(options, (res) => {
      clearTimeout(timeoutId);
      
      // Check for redirect
      if (res.statusCode && [301, 302, 307, 308].includes(res.statusCode)) {
        const { location } = res.headers;
        if (location) {
          // Validate the redirect URL is parseable and has a hostname
          const parsed = parseUrl(location);
          if (parsed && parsed.hostname && parsed.hostname.length > 0) {
            // Check if it's a myunraid.net URL
            if (parsed.hostname === 'myunraid.net' || parsed.hostname.endsWith('.myunraid.net')) {
              resolve(location);
              return;
            }
          }
        }
      }
      
      resolve(null);
    });
    
    req.on('error', () => {
      clearTimeout(timeoutId);
      resolve(null);
    });
    
    req.end();
  });
}

/**
 * Make an HTTP/HTTPS request
 */
function makeHttpRequest(
  url: string,
  body: string,
  apiKey: string,
  timeout: number,
  allowSelfSigned: boolean,
): Promise<{ status: number; statusText: string; body: string; redirectUrl?: string }> {
  return new Promise((resolve, reject) => {
    const parsed = parseUrl(url);
    if (!parsed) {
      reject(new Error(`Invalid URL: ${url}`));
      return;
    }
    
    const { hostname, port, protocol, path } = parsed;
    const useHttps = protocol === 'https';
    
    const options: https.RequestOptions = {
      hostname,
      port,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'Content-Length': Buffer.byteLength(body),
      },
    };
    
    if (useHttps && allowSelfSigned) {
      options.rejectUnauthorized = false;
    }
    
    const protocolModule = useHttps ? https : http;
    
    let req: http.ClientRequest | null = null;
    
    // eslint-disable-next-line homey-app/global-timers
    const timeoutId = setTimeout(() => {
      if (req) req.destroy();
      reject(new Error(`Request timed out after ${timeout}ms`));
    }, timeout);
    
    req = protocolModule.request(options, (res) => {
      // Handle redirects
      if (res.statusCode && [301, 302, 307, 308].includes(res.statusCode)) {
        clearTimeout(timeoutId);
        const { location } = res.headers;
        if (location) {
          resolve({
            status: res.statusCode,
            statusText: res.statusMessage ?? 'Redirect',
            body: '',
            redirectUrl: location,
          });
          return;
        }
      }
      
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        clearTimeout(timeoutId);
        resolve({
          status: res.statusCode ?? 0,
          statusText: res.statusMessage ?? '',
          body: data,
        });
      });
      
      res.on('error', (error) => {
        clearTimeout(timeoutId);
        reject(error);
      });
    });
    
    req.on('error', (error) => {
      clearTimeout(timeoutId);
      reject(error);
    });
    
    req.write(body);
    req.end();
  });
}

/**
 * Execute a GraphQL query against the Unraid API
 * 
 * @param config - Client configuration
 * @param query - GraphQL query string
 * @param variables - Optional query variables
 * @param schema - Zod schema for response validation
 * @returns Validated response data
 * @throws UnraidApiError on failure
 */
export async function executeQuery<T>(
  config: UnraidClientConfig,
  query: string,
  variables: Record<string, unknown> = {},
  schema: z.ZodType<T>,
): Promise<T> {
  const timeout = config.timeout ?? 10000;
  const allowSelfSigned = config.allowSelfSigned !== false;
  const body = JSON.stringify({ query, variables });
  
  // Validate host is present
  if (!config.host || config.host.trim() === '') {
    throw new UnraidApiError({
      code: 'VALIDATION_ERROR',
      message: 'Host is required but was empty',
      retryable: false,
    });
  }
  
  const host = config.host.trim();
  
  // Check cache for redirect URL
  const cacheKey = host;
  let resolvedUrl = redirectUrlCache.get(cacheKey);
  
  // If no cached URL, try to discover redirect
  if (!resolvedUrl) {
    const redirectUrl = await discoverRedirectUrl(host, timeout);
    if (redirectUrl) {
      // Remove trailing path if present and add /graphql
      const parsed = parseUrl(redirectUrl);
      if (parsed) {
        const baseUrl = `${parsed.protocol}://${parsed.hostname}${parsed.port !== 443 && parsed.port !== 80 ? `:${parsed.port}` : ''}`;
        resolvedUrl = `${baseUrl}/graphql`;
        redirectUrlCache.set(cacheKey, resolvedUrl);
      }
    }
    
    // If no redirect found, use direct URL
    if (!resolvedUrl) {
      const useHttps = config.useHttps !== false;
      const protocol = useHttps ? 'https' : 'http';
      const defaultPort = useHttps ? 443 : 80;
      const port = config.port ?? defaultPort;
      const portSuffix = (port === 443 && useHttps) || (port === 80 && !useHttps) ? '' : `:${port}`;
      resolvedUrl = `${protocol}://${host}${portSuffix}/graphql`;
    }
  }
  
  // Final validation of the URL
  const parsedUrl = parseUrl(resolvedUrl);
  if (!parsedUrl || !parsedUrl.hostname) {
    throw new UnraidApiError({
      code: 'VALIDATION_ERROR',
      message: `Invalid URL constructed: ${resolvedUrl}. Host: ${host}`,
      retryable: false,
    });
  }
  
  try {
    let response = await makeHttpRequest(resolvedUrl, body, config.apiKey, timeout, allowSelfSigned);
    
    // Handle additional redirects
    let redirectCount = 0;
    const MAX_REDIRECTS = 5;
    while (response.redirectUrl && redirectCount < MAX_REDIRECTS) {
      redirectCount++;
      // Update cache with new redirect URL
      const parsed = parseUrl(response.redirectUrl);
      if (parsed) {
        resolvedUrl = response.redirectUrl;
        redirectUrlCache.set(cacheKey, resolvedUrl);
      }
      response = await makeHttpRequest(response.redirectUrl, body, config.apiKey, timeout, allowSelfSigned);
    }
    
    if (response.status < 200 || response.status >= 300) {
      throw createHttpError(response.status, response.statusText);
    }
    
    let json: unknown;
    try {
      json = JSON.parse(response.body);
    } catch {
      throw new UnraidApiError({
        code: 'VALIDATION_ERROR',
        message: 'Invalid JSON response from server',
        details: { body: response.body.substring(0, 200) },
        retryable: false,
      });
    }
    
    // Validate GraphQL response structure
    const graphqlResponse = GraphQLResponseSchema(schema).safeParse(json);
    
    if (!graphqlResponse.success) {
      throw new UnraidApiError({
        code: 'VALIDATION_ERROR',
        message: 'Invalid response format from server',
        details: { zodIssues: graphqlResponse.error.issues },
        retryable: false,
      });
    }
    
    // Check for GraphQL errors
    if (graphqlResponse.data.errors?.length) {
      const firstError = graphqlResponse.data.errors[0];
      throw new UnraidApiError({
        code: mapGraphQLErrorCode(firstError),
        message: firstError.message,
        details: { graphqlErrors: graphqlResponse.data.errors },
        retryable: false,
      });
    }
    
    // Return validated data
    if (graphqlResponse.data.data === null) {
      throw new UnraidApiError({
        code: 'SERVER_ERROR',
        message: 'Server returned null data',
        retryable: true,
      });
    }
    
    return graphqlResponse.data.data;
    
  } catch (error) {
    if (error instanceof UnraidApiError) {
      throw error;
    }
    
    if (error instanceof Error) {
      if (error.message.includes('timed out')) {
        throw new UnraidApiError({
          code: 'TIMEOUT_ERROR',
          message: error.message,
          retryable: true,
        });
      }
      
      if (error.message.includes('ECONNREFUSED')) {
        throw new UnraidApiError({
          code: 'CONNECTION_ERROR',
          message: `Connection refused - is the server running at ${config.host}?`,
          retryable: true,
        });
      }
      
      if (error.message.includes('ENOTFOUND') || error.message.includes('EAI_AGAIN')) {
        throw new UnraidApiError({
          code: 'CONNECTION_ERROR',
          message: `Could not resolve hostname: ${config.host}`,
          retryable: true,
        });
      }
      
      throw new UnraidApiError({
        code: 'CONNECTION_ERROR',
        message: error.message,
        retryable: true,
      });
    }
    
    throw new UnraidApiError({
      code: 'UNKNOWN_ERROR',
      message: 'An unexpected error occurred',
      retryable: false,
    });
  }
}

/**
 * Test connection to Unraid server
 */
export async function testConnection(config: UnraidClientConfig): Promise<boolean> {
  const testQuery = `query { online }`;
  const testSchema = z.object({
    online: z.boolean(),
  });
  
  try {
    const result = await executeQuery(config, testQuery, {}, testSchema);
    return result.online;
  } catch {
    return false;
  }
}

/**
 * Test connection and return detailed result
 */
export async function testConnectionDetailed(config: UnraidClientConfig): Promise<{ 
  success: boolean; 
  error?: string;
}> {
  const testQuery = `query { online }`;
  const testSchema = z.object({
    online: z.boolean(),
  });
  
  try {
    const result = await executeQuery(config, testQuery, {}, testSchema);
    if (!result.online) {
      return {
        success: false,
        error: 'Server reports offline status',
      };
    }
    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { 
      success: false, 
      error: message,
    };
  }
}

/**
 * Clear the redirect URL cache (useful for testing or reconnection)
 */
export function clearRedirectCache(): void {
  redirectUrlCache.clear();
}

// =============================================================================
// Docker Container Mutations
// =============================================================================

/**
 * Start a Docker container
 */
export async function startContainer(
  config: UnraidClientConfig,
  containerId: string
): Promise<{ id: string; state: string }> {
  const mutation = `
    mutation StartContainer($id: ID!) {
      dockerContainerStart(id: $id) {
        id
        state
      }
    }
  `;
  const schema = z.object({
    dockerContainerStart: z.object({
      id: z.string(),
      state: z.string(),
    }),
  });
  const result = await executeQuery(config, mutation, { id: containerId }, schema);
  return result.dockerContainerStart;
}

/**
 * Stop a Docker container
 */
export async function stopContainer(
  config: UnraidClientConfig,
  containerId: string
): Promise<{ id: string; state: string }> {
  const mutation = `
    mutation StopContainer($id: ID!) {
      dockerContainerStop(id: $id) {
        id
        state
      }
    }
  `;
  const schema = z.object({
    dockerContainerStop: z.object({
      id: z.string(),
      state: z.string(),
    }),
  });
  const result = await executeQuery(config, mutation, { id: containerId }, schema);
  return result.dockerContainerStop;
}

/**
 * Restart a Docker container
 */
export async function restartContainer(
  config: UnraidClientConfig,
  containerId: string
): Promise<{ id: string; state: string }> {
  const mutation = `
    mutation RestartContainer($id: ID!) {
      dockerContainerRestart(id: $id) {
        id
        state
      }
    }
  `;
  const schema = z.object({
    dockerContainerRestart: z.object({
      id: z.string(),
      state: z.string(),
    }),
  });
  const result = await executeQuery(config, mutation, { id: containerId }, schema);
  return result.dockerContainerRestart;
}

// =============================================================================
// VM Mutations
// =============================================================================

/**
 * Start a VM
 */
export async function startVM(
  config: UnraidClientConfig,
  vmId: string
): Promise<{ id: string; state: string }> {
  const mutation = `
    mutation StartVM($id: ID!) {
      vmStart(id: $id) {
        id
        state
      }
    }
  `;
  const schema = z.object({
    vmStart: z.object({
      id: z.string(),
      state: z.string(),
    }),
  });
  const result = await executeQuery(config, mutation, { id: vmId }, schema);
  return result.vmStart;
}

/**
 * Stop a VM
 */
export async function stopVM(
  config: UnraidClientConfig,
  vmId: string
): Promise<{ id: string; state: string }> {
  const mutation = `
    mutation StopVM($id: ID!) {
      vmStop(id: $id) {
        id
        state
      }
    }
  `;
  const schema = z.object({
    vmStop: z.object({
      id: z.string(),
      state: z.string(),
    }),
  });
  const result = await executeQuery(config, mutation, { id: vmId }, schema);
  return result.vmStop;
}

// =============================================================================
// Array Mutations
// =============================================================================

/**
 * Start the array
 */
export async function startArray(
  config: UnraidClientConfig
): Promise<{ state: string }> {
  const mutation = `
    mutation StartArray {
      arrayAction(action: START) {
        state
      }
    }
  `;
  const schema = z.object({
    arrayAction: z.object({
      state: z.string(),
    }),
  });
  const result = await executeQuery(config, mutation, {}, schema);
  return result.arrayAction;
}

/**
 * Stop the array
 */
export async function stopArray(
  config: UnraidClientConfig
): Promise<{ state: string }> {
  const mutation = `
    mutation StopArray {
      arrayAction(action: STOP) {
        state
      }
    }
  `;
  const schema = z.object({
    arrayAction: z.object({
      state: z.string(),
    }),
  });
  const result = await executeQuery(config, mutation, {}, schema);
  return result.arrayAction;
}

// =============================================================================
// Parity Check Mutations
// =============================================================================

/**
 * Start a parity check
 */
export async function startParityCheck(
  config: UnraidClientConfig,
  correct: boolean = false
): Promise<{ state: string }> {
  const mutation = `
    mutation StartParityCheck($correct: Boolean!) {
      parityCheckStart(correct: $correct) {
        state
      }
    }
  `;
  const schema = z.object({
    parityCheckStart: z.object({
      state: z.string(),
    }),
  });
  const result = await executeQuery(config, mutation, { correct }, schema);
  return result.parityCheckStart;
}

/**
 * Pause a parity check
 */
export async function pauseParityCheck(
  config: UnraidClientConfig
): Promise<{ state: string }> {
  const mutation = `
    mutation PauseParityCheck {
      parityCheckPause {
        state
      }
    }
  `;
  const schema = z.object({
    parityCheckPause: z.object({
      state: z.string(),
    }),
  });
  const result = await executeQuery(config, mutation, {}, schema);
  return result.parityCheckPause;
}

/**
 * Resume a parity check
 */
export async function resumeParityCheck(
  config: UnraidClientConfig
): Promise<{ state: string }> {
  const mutation = `
    mutation ResumeParityCheck {
      parityCheckResume {
        state
      }
    }
  `;
  const schema = z.object({
    parityCheckResume: z.object({
      state: z.string(),
    }),
  });
  const result = await executeQuery(config, mutation, {}, schema);
  return result.parityCheckResume;
}

/**
 * Cancel a parity check
 */
export async function cancelParityCheck(
  config: UnraidClientConfig
): Promise<{ state: string }> {
  const mutation = `
    mutation CancelParityCheck {
      parityCheckCancel {
        state
      }
    }
  `;
  const schema = z.object({
    parityCheckCancel: z.object({
      state: z.string(),
    }),
  });
  const result = await executeQuery(config, mutation, {}, schema);
  return result.parityCheckCancel;
}

// =============================================================================
// Disk Mutations
// =============================================================================

/**
 * Spin up a disk
 */
export async function spinUpDisk(
  config: UnraidClientConfig,
  diskName: string
): Promise<{ name: string; status: string }> {
  const mutation = `
    mutation SpinUpDisk($name: String!) {
      diskSpinUp(name: $name) {
        name
        status
      }
    }
  `;
  const schema = z.object({
    diskSpinUp: z.object({
      name: z.string(),
      status: z.string(),
    }),
  });
  const result = await executeQuery(config, mutation, { name: diskName }, schema);
  return result.diskSpinUp;
}

/**
 * Spin down a disk
 */
export async function spinDownDisk(
  config: UnraidClientConfig,
  diskName: string
): Promise<{ name: string; status: string }> {
  const mutation = `
    mutation SpinDownDisk($name: String!) {
      diskSpinDown(name: $name) {
        name
        status
      }
    }
  `;
  const schema = z.object({
    diskSpinDown: z.object({
      name: z.string(),
      status: z.string(),
    }),
  });
  const result = await executeQuery(config, mutation, { name: diskName }, schema);
  return result.diskSpinDown;
}
