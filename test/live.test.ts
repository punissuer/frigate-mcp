import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { serverParameters } from './helpers/durable.js';

/**
 * Opt-in live compatibility check.
 *
 * It never runs by default: without FRIGATE_LIVE_API_ROOT the test is skipped,
 * so CI stays offline and never touches a real NVR. The check only reads the
 * public health, version, statistics, and configuration endpoints; it never
 * mutates configuration, reviews, events, or footage.
 */
const apiRoot = process.env.FRIGATE_LIVE_API_ROOT;
const supportedRelease = process.env.FRIGATE_LIVE_SUPPORTED_RELEASE ?? '0.18.2';

test('a live Frigate instance answers the contract-tested reads', { skip: apiRoot ? false : 'FRIGATE_LIVE_API_ROOT is not set' }, async () => {
  const env: Record<string, string> = {};
  if (process.env.FRIGATE_USERNAME) env.FRIGATE_USERNAME = process.env.FRIGATE_USERNAME;
  if (process.env.FRIGATE_PASSWORD) env.FRIGATE_PASSWORD = process.env.FRIGATE_PASSWORD;
  if (process.env.FRIGATE_BEARER_TOKEN) env.FRIGATE_BEARER_TOKEN = process.env.FRIGATE_BEARER_TOKEN;
  if (process.env.FRIGATE_CAMERAS) env.FRIGATE_CAMERAS = process.env.FRIGATE_CAMERAS;
  const client = new Client({ name: 'frigate-live-check', version: '1' });
  try {
    await client.connect(new StdioClientTransport(serverParameters(apiRoot!, env)));
    const status = await client.callTool({ name: 'get_system_status', arguments: {} });
    assert.equal(status.isError, false, 'the live status read must succeed');
    const structured = status.structuredContent as {
      ok: boolean;
      data: { version?: { version: string; compatibility: string }; authorizedApiAccess: string };
    };
    assert.equal(structured.ok, true);
    assert.ok(structured.data.version, 'the live instance must report a version');
    assert.equal(
      structured.data.version?.compatibility,
      'supported',
      `the live instance runs ${structured.data.version?.version}, which is not the contract-tested release ${supportedRelease}`,
    );
    assert.equal(structured.data.authorizedApiAccess, 'confirmed', 'the live instance must accept the configured credentials');

    const cameras = await client.callTool({ name: 'list_cameras', arguments: {} });
    assert.equal(cameras.isError, false);
    const capabilities = await client.callTool({ name: 'get_capabilities', arguments: {} });
    assert.equal(capabilities.isError, false);
  } finally {
    await client.close();
  }
});
