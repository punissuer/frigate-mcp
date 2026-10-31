import { z } from 'zod';

export const STATUS_TOOL = 'get_system_status';
export const STATUS_DESCRIPTION = 'Read-only Frigate health, version compatibility, and sanitized camera/detector statistics. Public health is not proof of authorized API access. Partial failures are explicit; no configuration or media is returned.';
export const inputSchema = z.strictObject({});
const number = z.number().finite().nonnegative();
const name = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
export const cameraSchema = z.object({
  camera_fps: number.optional(),
  process_fps: number.optional(),
  skipped_fps: number.optional(),
  detection_fps: number.optional(),
  detection_enabled: z.boolean().optional(),
});
export const detectorSchema = z.object({ inference_speed: number.optional() });
export const statisticsSchema = z.object({
  cameras: z.record(name, cameraSchema).refine(v => Object.keys(v).length <= 128).meta({ maxProperties: 128 }),
  detectors: z.record(name, detectorSchema).refine(v => Object.keys(v).length <= 32).meta({ maxProperties: 32 }),
  service: z.object({ uptime: number.optional(), last_updated: number.optional() }),
});
const errorSchema = z.strictObject({
  code: z.enum(['authentication', 'forbidden', 'not_found', 'rate_limit', 'upstream_error', 'timeout', 'cancelled', 'unreachable', 'malformed_response', 'payload_too_large', 'redirect_rejected', 'busy']),
  message: z.string().max(160),
  retryable: z.boolean(),
  status: z.number().int().min(100).max(599).optional(),
});
export type ReadError = z.infer<typeof errorSchema>;
const failure = z.strictObject({ ok: z.literal(false), error: errorSchema });
const health = z.union([z.strictObject({ ok: z.literal(true), alive: z.literal(true) }), failure]);
const version = z.union([
  z.strictObject({
    ok: z.literal(true),
    version: z.string().max(80),
    compatibility: z.enum(['supported', 'unknown', 'unsupported']),
  }), failure,
]);
const statistics = z.union([z.strictObject({ ok: z.literal(true), statistics: statisticsSchema }), failure]);
const dataSchema = z.strictObject({
  health, version, statistics,
  authorizedApiAccess: z.enum(['confirmed', 'denied', 'unknown']),
});
const metadataSchema = z.strictObject({
  observedAt: z.iso.datetime(),
  warnings: z.array(z.string().max(160)).max(8),
  contractRelease: z.literal('0.18.2'),
});
// MCP requires an object-shaped top-level schema. Keep the success/error
// discrimination in both runtime validation and the advertised JSON Schema.
export const outputSchema = z.strictObject({
  ok: z.boolean(), error: errorSchema.optional(), data: dataSchema, meta: metadataSchema,
}).refine(v => v.ok ? v.error === undefined : v.error !== undefined).meta({
  oneOf: [
    { properties: { ok: { const: true } }, not: { required: ['error'] } },
    { properties: { ok: { const: false } }, required: ['error'] },
  ],
});
export type StatusResult = z.infer<typeof outputSchema>;

// This release contract was checked against the tagged Frigate source, not a live NVR.
export function compatibility(version: string): 'supported' | 'unknown' | 'unsupported' {
  if (/^0\.18\.2(?:-[a-f0-9]{7,40})?$/.test(version)) return 'supported';
  const match = /^(\d+)\.(\d+)\./.exec(version);
  return match?.[1] === '0' && Number(match[2]) < 18 ? 'unsupported' : 'unknown';
}

export const statusManifest = {
  name: STATUS_TOOL,
  description: STATUS_DESCRIPTION,
  inputSchema: z.toJSONSchema(inputSchema, { target: 'draft-7', io: 'input' }),
  outputSchema: z.toJSONSchema(outputSchema, { target: 'draft-7', io: 'output' }),
} as const;
