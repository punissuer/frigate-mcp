import { z } from 'zod';

export const STATUS_TOOL = 'get_system_status';
export const LIST_CAMERAS_TOOL = 'list_cameras';
export const CAPABILITIES_TOOL = 'get_capabilities';

export const STATUS_DESCRIPTION = 'Read-only Frigate health, version compatibility, and sanitized camera/detector statistics. Public health is not proof of authorized API access. Partial failures are explicit; no configuration or media is returned.';
export const LIST_CAMERAS_DESCRIPTION = 'List the Frigate cameras this server may inspect, with their zone names and detection state. Only allowlisted configuration fields are read; RTSP URLs, provider credentials, and filesystem paths are never returned. A camera outside the operator scope is rejected.';
export const CAPABILITIES_DESCRIPTION = 'Report which read-only Frigate capabilities this server can rely on, the tracked object labels, and the effective policy limits. Capability detection never searches events or downloads media; uncertain capabilities are reported as unknown.';

const CAMERA_ID = /^[A-Za-z0-9_-]{1,64}$/;
const number = z.number().finite().nonnegative();
const name = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
export const cameraIdSchema = z.string().min(1).max(64).regex(CAMERA_ID);

export const statusInputSchema = z.strictObject({});
export const listCamerasInputSchema = z.strictObject({ camera: cameraIdSchema.optional() });
export const capabilitiesInputSchema = z.strictObject({});

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
export type Statistics = z.infer<typeof statisticsSchema>;
export const errorSchema = z.strictObject({
  code: z.enum(['authentication', 'forbidden', 'not_found', 'rate_limit', 'upstream_error', 'timeout', 'cancelled', 'unreachable', 'malformed_response', 'payload_too_large', 'redirect_rejected', 'busy', 'invalid_request']),
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
export const statusDataSchema = z.strictObject({
  health, version, statistics,
  authorizedApiAccess: z.enum(['confirmed', 'denied', 'unknown']),
});

export const cameraEntrySchema = z.strictObject({
  id: z.string().min(1).max(64),
  zones: z.array(z.string().min(1).max(64)).max(64),
  detectionEnabled: z.boolean().optional(),
});
export const listCamerasDataSchema = z.strictObject({
  scope: z.enum(['restricted', 'unrestricted']),
  cameras: z.array(cameraEntrySchema).max(128),
});

const capability = z.enum(['supported', 'unknown']);
export const capabilitiesDataSchema = z.strictObject({
  version: z.strictObject({ version: z.string().max(80), compatibility: z.enum(['supported', 'unknown', 'unsupported']) }).optional(),
  capabilities: z.strictObject({
    objectEvents: capability,
    semanticSearch: capability,
    reviews: capability,
    recordingAvailability: capability,
    imageSnapshots: capability,
  }),
  trackedLabels: z.array(z.string().min(1).max(64)).max(256),
  policy: z.strictObject({
    cameraScope: z.enum(['restricted', 'unrestricted']),
    permittedCameraCount: z.number().int().nonnegative().max(128),
    timeoutMs: z.number().int().positive(),
    maxResponseBytes: z.number().int().positive(),
    maxConcurrent: z.number().int().positive(),
  }),
});

export const metadataSchema = z.strictObject({
  observedAt: z.iso.datetime(),
  warnings: z.array(z.string().max(160)).max(8),
  contractRelease: z.literal('0.18.2'),
});

// MCP requires an object-shaped top-level schema. Keep the success/error
// discrimination in both runtime validation and the advertised JSON Schema.
const envelope = <T extends z.ZodType>(data: T) => z.strictObject({
  ok: z.boolean(), error: errorSchema.optional(), data, meta: metadataSchema,
}).refine(v => v.ok ? v.error === undefined : v.error !== undefined).meta({
  oneOf: [
    { properties: { ok: { const: true } }, not: { required: ['error'] } },
    { properties: { ok: { const: false } }, required: ['error'] },
  ],
});

export const outputSchema = envelope(statusDataSchema);
export type StatusResult = z.infer<typeof outputSchema>;
export const listCamerasOutputSchema = envelope(listCamerasDataSchema);
export type ListCamerasResult = z.infer<typeof listCamerasOutputSchema>;
export const capabilitiesOutputSchema = envelope(capabilitiesDataSchema);
export type CapabilitiesResult = z.infer<typeof capabilitiesOutputSchema>;

// This release contract was checked against the tagged Frigate source, not a live NVR.
export function compatibility(version: string): 'supported' | 'unknown' | 'unsupported' {
  if (/^0\.18\.2(?:-[a-f0-9]{7,40})?$/.test(version)) return 'supported';
  const match = /^(\d+)\.(\d+)\./.exec(version);
  return match?.[1] === '0' && Number(match[2]) < 18 ? 'unsupported' : 'unknown';
}

const manifestEntry = (name: string, description: string, input: z.ZodType, output: z.ZodType) => ({
  name,
  description,
  inputSchema: z.toJSONSchema(input, { target: 'draft-7', io: 'input' }),
  outputSchema: z.toJSONSchema(output, { target: 'draft-7', io: 'output' }),
}) as const;

export const statusManifest = manifestEntry(STATUS_TOOL, STATUS_DESCRIPTION, statusInputSchema, outputSchema);
export const listCamerasManifest = manifestEntry(LIST_CAMERAS_TOOL, LIST_CAMERAS_DESCRIPTION, listCamerasInputSchema, listCamerasOutputSchema);
export const capabilitiesManifest = manifestEntry(CAPABILITIES_TOOL, CAPABILITIES_DESCRIPTION, capabilitiesInputSchema, capabilitiesOutputSchema);

export const toolManifests = {
  [STATUS_TOOL]: statusManifest,
  [LIST_CAMERAS_TOOL]: listCamerasManifest,
  [CAPABILITIES_TOOL]: capabilitiesManifest,
} as const;

/** Runtime validators matching the advertised manifests. */
export const toolInputSchemas = {
  [STATUS_TOOL]: statusInputSchema,
  [LIST_CAMERAS_TOOL]: listCamerasInputSchema,
  [CAPABILITIES_TOOL]: capabilitiesInputSchema,
} as const;

export const toolOutputSchemas = {
  [STATUS_TOOL]: outputSchema,
  [LIST_CAMERAS_TOOL]: listCamerasOutputSchema,
  [CAPABILITIES_TOOL]: capabilitiesOutputSchema,
} as const;

export type ToolName = keyof typeof toolManifests;
